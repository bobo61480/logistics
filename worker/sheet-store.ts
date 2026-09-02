/**
 * worker/sheet-store.ts
 * Relational D1 mirror of the grid-shaped Google Sheet sources.
 *
 * Google Sheets stays the synchronized operational source; D1 stays the
 * exclusive frontend read model. What changes here is how D1 holds it: instead
 * of re-serializing every source into a fresh chunked snapshot on every write,
 * each sheet row is a row in `sheet_rows`, keyed by (source_key, row_index) and
 * fingerprinted by a content hash. That makes a scheduled refresh write only
 * the rows that actually changed, and a confirmed status writeback touch
 * exactly one row instead of the whole snapshot.
 *
 * Non-grid sources (GViz tables, ingestion events, CMS projections, KPIs)
 * remain in the chunked snapshot tables — see ./database.ts.
 */

export type SheetGrid = string[][];

// D1 caps bound parameters per statement; 4 params per row keeps every
// multi-row INSERT comfortably inside the limit.
const PARAMS_PER_ROW = 4;
const ROWS_PER_STATEMENT = 25;
const STATEMENTS_PER_BATCH = 40;
const MAX_CELL_LENGTH = 32_768;

export function isSheetGrid(value: unknown): value is SheetGrid {
  return Array.isArray(value) && value.every((row) => Array.isArray(row));
}

/** Splits a snapshot's `sources` map into relational grids and everything else. */
export function partitionSources(sources: Record<string, unknown>) {
  const grids: Record<string, SheetGrid> = {};
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sources)) {
    if (isSheetGrid(value)) grids[key] = value as SheetGrid;
    else meta[key] = value;
  }
  return { grids, meta };
}

/**
 * FNV-1a style 64-bit content fingerprint rendered as hex. Synchronous (unlike
 * SubtleCrypto) so a refresh can fingerprint tens of thousands of rows without
 * awaiting once per row, and stable across isolates.
 */
export function hashRow(cells: readonly string[]): string {
  const text = JSON.stringify(cells);
  let hi = 0x811c9dc5;
  let lo = 0x9dc5811c;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    hi = Math.imul(hi ^ code, 0x01000193) >>> 0;
    lo = Math.imul(lo ^ ((code << 5) | (code >>> 3)), 0x01000193) >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

function normalizeGrid(grid: SheetGrid): string[][] {
  return grid.map((row) => row.map((cell) => {
    const text = String(cell ?? "");
    return text.length > MAX_CELL_LENGTH ? text.slice(0, MAX_CELL_LENGTH) : text;
  }));
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]) {
  for (let index = 0; index < statements.length; index += STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(index, index + STATEMENTS_PER_BATCH));
  }
}

function upsertRowStatements(
  db: D1Database,
  sourceKey: string,
  rows: Array<{ index: number; cells: string[]; hash: string }>,
) {
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
    const slice = rows.slice(start, start + ROWS_PER_STATEMENT);
    const placeholders = slice.map(() => `(${new Array(PARAMS_PER_ROW).fill("?").join(",")})`).join(",");
    const bindings = slice.flatMap((row) => [sourceKey, row.index, row.hash, JSON.stringify(row.cells)]);
    statements.push(db.prepare(
      `INSERT INTO sheet_rows (source_key, row_index, row_hash, cells_json) VALUES ${placeholders}
       ON CONFLICT(source_key, row_index) DO UPDATE SET
         row_hash = excluded.row_hash, cells_json = excluded.cells_json`,
    ).bind(...bindings));
  }
  return statements;
}

export type SheetSyncStats = {
  sources: number;
  rowsTotal: number;
  rowsWritten: number;
  rowsDeleted: number;
  elapsedMs: number;
};

/**
 * Delta-syncs every grid source into D1. Only rows whose content hash changed,
 * plus trailing rows the source no longer has, are written.
 */
export async function syncSheetGrids(
  db: D1Database,
  grids: Record<string, SheetGrid>,
  generatedAt: string,
): Promise<SheetSyncStats> {
  const startedAt = Date.now();
  const syncedAt = new Date().toISOString();
  let rowsTotal = 0;
  let rowsWritten = 0;
  let rowsDeleted = 0;

  for (const [sourceKey, rawGrid] of Object.entries(grids)) {
    const grid = normalizeGrid(rawGrid);
    rowsTotal += grid.length;
    const existing = await db.prepare(
      "SELECT row_index, row_hash FROM sheet_rows WHERE source_key = ?",
    ).bind(sourceKey).all<{ row_index: number; row_hash: string }>();
    const previous = new Map(existing.results.map((row) => [row.row_index, row.row_hash]));

    const changed = grid
      .map((cells, index) => ({ index, cells, hash: hashRow(cells) }))
      .filter((row) => previous.get(row.index) !== row.hash);
    const staleCount = Math.max(0, previous.size - grid.length);

    // The parent row must exist before its rows (foreign key), so it leads the
    // first batch for this source.
    const statements: D1PreparedStatement[] = [db.prepare(
      `INSERT INTO sheet_sources (source_key, row_count, column_count, generated_at, synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET
         row_count = excluded.row_count, column_count = excluded.column_count,
         generated_at = excluded.generated_at, synced_at = excluded.synced_at`,
    ).bind(
      sourceKey,
      grid.length,
      grid.reduce((max, row) => Math.max(max, row.length), 0),
      generatedAt,
      syncedAt,
    )];
    statements.push(...upsertRowStatements(db, sourceKey, changed));
    if (staleCount > 0) {
      statements.push(db.prepare(
        "DELETE FROM sheet_rows WHERE source_key = ? AND row_index >= ?",
      ).bind(sourceKey, grid.length));
    }
    await runBatches(db, statements);
    rowsWritten += changed.length;
    rowsDeleted += staleCount;
  }

  // A source that vanished from the feed must not linger as frontend data. The
  // rows are deleted explicitly rather than relying on cascade, so an orphaned
  // row can never outlive its source.
  const keys = Object.keys(grids);
  if (keys.length) {
    const placeholders = keys.map(() => "?").join(",");
    await db.batch([
      db.prepare(`DELETE FROM sheet_rows WHERE source_key NOT IN (${placeholders})`).bind(...keys),
      db.prepare(`DELETE FROM sheet_sources WHERE source_key NOT IN (${placeholders})`).bind(...keys),
    ]);
  }

  return { sources: keys.length, rowsTotal, rowsWritten, rowsDeleted, elapsedMs: Date.now() - startedAt };
}

/** Reads every stored grid back in row order. */
export async function readSheetGrids(db: D1Database): Promise<Record<string, SheetGrid>> {
  const [sourcesResult, rowsResult] = await db.batch([
    db.prepare("SELECT source_key, row_count FROM sheet_sources"),
    db.prepare("SELECT source_key, row_index, cells_json FROM sheet_rows ORDER BY source_key, row_index"),
  ]);
  const declared = sourcesResult.results as Array<{ source_key: string; row_count: number }>;
  if (!declared.length) return {};

  const grids: Record<string, SheetGrid> = {};
  for (const source of declared) grids[source.source_key] = [];
  for (const row of rowsResult.results as Array<{ source_key: string; row_index: number; cells_json: string }>) {
    const grid = grids[row.source_key];
    if (!grid) continue;
    grid[row.row_index] = JSON.parse(row.cells_json) as string[];
  }
  for (const source of declared) {
    const grid = grids[source.source_key];
    if (grid.length !== source.row_count || grid.some((row) => row === undefined)) {
      throw new Error(`Relational sheet source ${source.source_key} failed integrity validation`);
    }
  }
  return grids;
}

/** Reads a single stored grid, or null when the source has never been synced. */
export async function readSheetGrid(db: D1Database, sourceKey: string): Promise<SheetGrid | null> {
  const rows = await db.prepare(
    "SELECT row_index, cells_json FROM sheet_rows WHERE source_key = ? ORDER BY row_index",
  ).bind(sourceKey).all<{ row_index: number; cells_json: string }>();
  if (!rows.results.length) return null;
  const grid: SheetGrid = [];
  for (const row of rows.results) grid[row.row_index] = JSON.parse(row.cells_json) as string[];
  if (grid.some((row) => row === undefined)) throw new Error(`Relational sheet source ${sourceKey} failed integrity validation`);
  return grid;
}

export async function readSheetStoreHealth(db: D1Database) {
  const rows = await db.prepare(
    "SELECT source_key, row_count, generated_at, synced_at FROM sheet_sources ORDER BY source_key",
  ).all<{ source_key: string; row_count: number; generated_at: string; synced_at: string }>();
  const sources = rows.results;
  const generatedAt = sources.reduce((latest, source) => (source.generated_at > latest ? source.generated_at : latest), "");
  return {
    ready: sources.length > 0,
    sourceCount: sources.length,
    rowCount: sources.reduce((total, source) => total + source.row_count, 0),
    generatedAt: generatedAt || undefined,
    sources: sources.map((source) => ({
      sourceKey: source.source_key,
      rowCount: source.row_count,
      syncedAt: source.synced_at,
    })),
  };
}

/**
 * Targeted single-row writeback. Returns the updated cells so the caller can
 * confirm what D1 now holds without re-reading the whole source.
 */
export async function updateSheetCell(db: D1Database, input: {
  sourceKey: string;
  rowIndex: number;
  columnIndex: number;
  value: string;
}) {
  const existing = await db.prepare(
    "SELECT cells_json FROM sheet_rows WHERE source_key = ? AND row_index = ?",
  ).bind(input.sourceKey, input.rowIndex).first<{ cells_json: string }>();
  if (!existing) throw new Error(`Relational sheet row ${input.sourceKey}:${input.rowIndex} does not exist`);

  const cells = JSON.parse(existing.cells_json) as string[];
  while (cells.length <= input.columnIndex) cells.push("");
  cells[input.columnIndex] = input.value;
  const hash = hashRow(cells);
  await db.prepare(
    "UPDATE sheet_rows SET row_hash = ?, cells_json = ? WHERE source_key = ? AND row_index = ?",
  ).bind(hash, JSON.stringify(cells), input.sourceKey, input.rowIndex).run();
  return { cells, hash };
}
