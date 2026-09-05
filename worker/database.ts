import type { SourceHealth } from "./sources";
import {
  partitionSources,
  readSheetGrid,
  readSheetGrids,
  readSheetStoreHealth,
  syncSheetGrids,
  updateSheetCell,
} from "./sheet-store";

const PART_BYTES = 512 * 1024;
const MAX_PARTS = 44;
const RETAINED_SNAPSHOTS = 4;

export type OperationalSnapshot = {
  ok: true;
  generatedAt: string;
  version: string;
  sourceHealth: SourceHealth[];
  sources: Record<string, unknown>;
  kpis: unknown;
  kpiError?: string;
};

export type StoredSnapshot = OperationalSnapshot & {
  storage: "d1";
  storedAt: string;
};

type SnapshotRow = {
  id: string;
  generated_at: string;
  version: string;
  source_count: number;
  part_count: number;
  payload_bytes: number;
  created_at: string;
};

type PartRow = { part_name: string; part_index: number; payload_text: string; payload_bytes: number };

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function splitPayload(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Snapshot value is not JSON serializable");
  const chunks: string[] = [];
  const encoder = new TextEncoder();
  let start = 0;
  while (start < serialized.length) {
    const buffer = new Uint8Array(PART_BYTES);
    const { read, written } = encoder.encodeInto(serialized.slice(start), buffer);
    if (!read || !written) throw new Error("Snapshot payload could not be chunked");
    const chunk = serialized.slice(start, start + read);
    if (byteLength(chunk) !== written) throw new Error("Snapshot chunk byte count is inconsistent");
    chunks.push(chunk);
    start += read;
  }
  return chunks.length ? chunks : [""];
}

export function joinPayload(chunks: string[]) {
  return JSON.parse(chunks.join("")) as unknown;
}

function payloadEntries(snapshot: OperationalSnapshot, metaSources: Record<string, unknown>) {
  return [
    ["sourceHealth", snapshot.sourceHealth],
    ["sources", metaSources],
    ["kpis", snapshot.kpis],
    ["kpiError", snapshot.kpiError ?? null],
  ] as const;
}

/**
 * Publishes a snapshot to D1. Grid-shaped sheet sources are delta-synced into
 * the relational `sheet_rows` store (only changed rows are written); the small
 * remainder — source health, KPIs, GViz tables, ingestion events, CMS
 * projections — is chunked into the immutable snapshot tables behind the
 * atomic `current_snapshot` pointer.
 */
export async function persistSnapshot(db: D1Database, snapshot: OperationalSnapshot) {
  const id = crypto.randomUUID();
  const { grids, meta } = partitionSources(snapshot.sources);
  const sheetSync = await syncSheetGrids(db, grids, snapshot.generatedAt);
  const entries = payloadEntries(snapshot, meta);
  const parts = entries.flatMap(([name, value]) =>
    splitPayload(value).map((payload, index) => ({ name, index, payload, bytes: byteLength(payload) })),
  );
  if (parts.length > MAX_PARTS) throw new Error(`Snapshot requires ${parts.length} database parts; limit is ${MAX_PARTS}`);
  const payloadBytes = parts.reduce((total, part) => total + part.bytes, 0);
  const now = new Date().toISOString();
  const statements = [
    db.prepare(`INSERT INTO operational_snapshots
      (id, generated_at, version, source_count, part_count, payload_bytes)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(
      id,
      snapshot.generatedAt,
      snapshot.version,
      snapshot.sourceHealth.length,
      parts.length,
      payloadBytes,
    ),
    ...parts.map((part) => db.prepare(`INSERT INTO operational_snapshot_parts
      (snapshot_id, part_name, part_index, payload_text, payload_bytes)
      VALUES (?, ?, ?, ?, ?)`).bind(id, part.name, part.index, part.payload, part.bytes)),
    db.prepare(`INSERT INTO operational_state (key, snapshot_id, updated_at)
      VALUES ('current_snapshot', ?, ?)
      ON CONFLICT(key) DO UPDATE SET snapshot_id = excluded.snapshot_id, updated_at = excluded.updated_at`).bind(id, now),
  ];
  await db.batch(statements);

  await db.prepare(`DELETE FROM operational_snapshots
    WHERE id NOT IN (
      SELECT id FROM operational_snapshots ORDER BY generated_at DESC LIMIT ?
    ) AND id NOT IN (SELECT snapshot_id FROM operational_state)`).bind(RETAINED_SNAPSHOTS).run();
  return { id, partCount: parts.length, payloadBytes, sheetSync };
}

/**
 * Reads the chunked remainder of the current snapshot — everything except the
 * grid sources, which live in the relational store. Kept separate so a
 * writeback can resolve snapshot metadata without materializing every sheet.
 */
async function readSnapshotMeta(db: D1Database): Promise<StoredSnapshot | null> {
  const [metadataResult, partsResult] = await db.batch([
    db.prepare(`SELECT s.id, s.generated_at, s.version, s.source_count, s.part_count,
      s.payload_bytes, s.created_at
      FROM operational_state state
      JOIN operational_snapshots s ON s.id = state.snapshot_id
      WHERE state.key = 'current_snapshot'`),
    db.prepare(`SELECT p.part_name, p.part_index, p.payload_text, p.payload_bytes
      FROM operational_state state
      JOIN operational_snapshot_parts p ON p.snapshot_id = state.snapshot_id
      WHERE state.key = 'current_snapshot'
      ORDER BY p.part_name, p.part_index`),
  ]);
  const metadata = metadataResult.results[0] as SnapshotRow | undefined;
  if (!metadata) return null;
  const rows = partsResult.results as PartRow[];
  if (rows.length !== metadata.part_count) throw new Error("Current D1 snapshot is incomplete");
  const actualPayloadBytes = rows.reduce((total, row) => {
    const actualPartBytes = byteLength(row.payload_text);
    if (actualPartBytes !== row.payload_bytes) {
      throw new Error(`Current D1 snapshot part ${row.part_name}:${row.part_index} failed integrity validation`);
    }
    return total + actualPartBytes;
  }, 0);
  if (actualPayloadBytes !== metadata.payload_bytes) throw new Error("Current D1 snapshot byte count failed integrity validation");

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const chunks = grouped.get(row.part_name) ?? [];
    chunks[row.part_index] = row.payload_text;
    grouped.set(row.part_name, chunks);
  }
  const decode = (name: string) => {
    const chunks = grouped.get(name);
    if (!chunks?.length || chunks.some((chunk) => chunk === undefined)) throw new Error(`Current D1 snapshot is missing ${name}`);
    return joinPayload(chunks);
  };
  const sourceHealth = decode("sourceHealth") as SourceHealth[];
  if (!Array.isArray(sourceHealth) || sourceHealth.length !== metadata.source_count) throw new Error("Current D1 snapshot source count failed integrity validation");
  return {
    ok: true,
    generatedAt: metadata.generated_at,
    version: metadata.version,
    sourceHealth,
    sources: decode("sources") as Record<string, unknown>,
    kpis: decode("kpis"),
    kpiError: (decode("kpiError") as string | null) ?? undefined,
    storage: "d1",
    storedAt: metadata.created_at,
  };
}

/**
 * The frontend read model: chunked snapshot metadata merged with the relational
 * sheet grids. Grids win over the chunked copy so a targeted status writeback
 * is visible immediately, and an empty relational store simply yields whatever
 * the chunked snapshot already held (the pre-migration shape).
 */
export async function readCurrentSnapshot(db: D1Database): Promise<StoredSnapshot | null> {
  const meta = await readSnapshotMeta(db);
  if (!meta) return null;
  let grids: Record<string, string[][]>;
  try {
    grids = await readSheetGrids(db);
  } catch (error) {
    // If migration 0005 has not been applied yet, the current snapshot is still
    // a pre-migration one that carries its grids inline — serve it rather than
    // failing the read. Once the store is in use, an unreadable store is a real
    // outage and must surface.
    const { grids: legacy } = partitionSources(meta.sources);
    if (!Object.keys(legacy).length) throw error;
    console.error(JSON.stringify({ event: "d1-sheet-store-unavailable", error: String(error) }));
    return meta;
  }
  return Object.keys(grids).length ? { ...meta, sources: { ...meta.sources, ...grids } } : meta;
}

export async function readDatabaseHealth(db: D1Database) {
  const [row, sheetStore] = await Promise.all([
    db.prepare(`SELECT s.generated_at, s.created_at, s.source_count,
      s.part_count, s.payload_bytes
      FROM operational_state state
      JOIN operational_snapshots s ON s.id = state.snapshot_id
      WHERE state.key = 'current_snapshot'`).first<{
        generated_at: string;
        created_at: string;
        source_count: number;
        part_count: number;
        payload_bytes: number;
      }>(),
    readSheetStoreHealth(db).catch(() => ({ ready: false, sourceCount: 0, rowCount: 0, sources: [] })),
  ]);
  return row ? {
    ready: true,
    generatedAt: row.generated_at,
    storedAt: row.created_at,
    ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(row.generated_at)) / 1000)),
    sourceCount: row.source_count,
    partCount: row.part_count,
    payloadBytes: row.payload_bytes,
    sheetStore,
  } : { ready: false, sheetStore };
}

function normalize(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function findStatusColumn(rows: string[][]) {
  const aliases = new Set(["STATUS", "WEBSITE STATUS", "CURRENT STATUS"]);
  for (let r = 0; r < Math.min(rows.length, 8); r += 1) {
    for (let c = 0; c < rows[r].length; c += 1) {
      if (aliases.has(normalize(rows[r][c]))) return { headerRow: r, statusColumn: c };
    }
  }
  return null;
}

/** Maps an editable Sheet tab name onto its relational source key. */
function sourceKeyForSheet(sources: Record<string, unknown>, sourceSheet: string) {
  if (sourceSheet === "IMPORTS") return "imports";
  const outboundMeta = sources.outboundMeta as { sheetName?: string } | undefined;
  if (outboundMeta?.sheetName === sourceSheet) return "outbound";
  return null;
}

/**
 * Applies a Sheet-confirmed status to the D1 read model as a single-row write.
 *
 * The previous implementation rebuilt and re-persisted the entire snapshot for
 * every status change; this resolves the one row and updates just that row, so
 * writeback cost is independent of how much sheet data D1 holds.
 */
export async function applyConfirmedStatusToSnapshot(db: D1Database, input: {
  sourceSheet: string;
  sourceRow: number;
  entityId: string;
  status: string;
}) {
  const meta = await readSnapshotMeta(db);
  if (!meta) throw new Error("D1 frontend snapshot is not initialized");
  const sourceKey = sourceKeyForSheet(meta.sources, input.sourceSheet);
  if (!sourceKey) throw new Error(`D1 frontend does not contain editable source ${input.sourceSheet}`);
  let rows = await readSheetGrid(db, sourceKey);
  if (!rows) {
    // First writeback after the relational migration: the source still only
    // exists inside the chunked snapshot, so seed it before updating in place.
    const legacy = meta.sources[sourceKey];
    if (!Array.isArray(legacy)) throw new Error(`D1 frontend does not contain editable source ${input.sourceSheet}`);
    rows = legacy as string[][];
    await syncSheetGrids(db, { [sourceKey]: rows }, meta.generatedAt);
  }
  const info = findStatusColumn(rows);
  if (!info) throw new Error(`D1 frontend source ${input.sourceSheet} has no status column`);

  let targetIndex = input.sourceRow - 1;
  const identity = normalize(input.entityId);
  if (targetIndex <= info.headerRow || targetIndex >= rows.length || (identity && !rows[targetIndex].some((cell) => normalize(cell) === identity))) {
    const candidates = identity
      ? rows.map((row, index) => ({ row, index })).filter(({ row, index }) => index > info.headerRow && row.some((cell) => normalize(cell) === identity))
      : [];
    if (candidates.length === 1) targetIndex = candidates[0].index;
    else if (targetIndex <= info.headerRow || targetIndex >= rows.length) throw new Error("D1 frontend row could not be resolved uniquely");
  }

  await updateSheetCell(db, {
    sourceKey,
    rowIndex: targetIndex,
    columnIndex: info.statusColumn,
    value: input.status,
  });
  return { sourceKey, targetIndex, statusColumn: info.statusColumn, rowsWritten: 1 };
}

export async function recordPendingReviewDecision(db: D1Database, event: {
  correlationId: string;
  reviewKey: string;
  shipmentId?: string;
  decision: "approve" | "reject";
  resultingStatus: string;
}) {
  await db.prepare(`INSERT INTO automation_events
    (id, source, entity_type, entity_id, previous_json, proposed_json, decision,
      actor, correlation_id, verification, created_at)
    VALUES (?, 'gmail-review', 'gmail-review', ?, ?, ?, ?, 'operator', ?, 'source-confirmed', ?)`)
    .bind(
      crypto.randomUUID(),
      event.shipmentId || event.reviewKey,
      JSON.stringify({ status: "NEEDS REVIEW" }),
      JSON.stringify({ status: event.resultingStatus }),
      event.decision === "approve" ? "confirmed" : "rejected",
      event.correlationId,
      new Date().toISOString(),
    )
    .run();
}

export async function recordConfirmedStatusWrite(db: D1Database, event: {
  correlationId: string;
  entityType: "inbound" | "outbound";
  entityId: string;
  previousStatus?: string;
  status: string;
  sourceSheet: string;
  sourceRow: number;
}) {
  await db.prepare(`INSERT INTO automation_events
    (id, source, entity_type, entity_id, previous_json, proposed_json, decision,
      actor, correlation_id, verification, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'operator', ?, 'source-and-d1-confirmed', ?)`)
    .bind(
      crypto.randomUUID(),
      `${event.sourceSheet}:${event.sourceRow}`,
      event.entityType,
      event.entityId,
      JSON.stringify({ status: event.previousStatus ?? null }),
      JSON.stringify({ status: event.status }),
      event.correlationId,
      new Date().toISOString(),
    )
    .run();
}
