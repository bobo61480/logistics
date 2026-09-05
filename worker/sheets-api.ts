type SheetsDatabaseEnv = Env & { DB: D1Database };

type SheetTabRow = {
  spreadsheet_id: string;
  document_alias: string;
  document_title: string;
  sheet_id: number;
  title: string;
  hidden: number;
  row_count: number;
  chunk_count: number;
  content_hash: string | null;
  last_synced_at: string | null;
  last_error: string | null;
};

type SheetChunkRow = {
  chunk_index: number;
  payload_json: string;
  content_hash: string;
};

function hasDatabase(env: Env): env is SheetsDatabaseEnv {
  return "DB" in env;
}

function secureJson(value: unknown, status = 200) {
  const response = Response.json(value, {
    status,
    headers: {
      "cache-control": status === 200 ? "public, max-age=30, stale-while-revalidate=120" : "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
  response.headers.set("content-security-policy", "base-uri 'self'; frame-ancestors 'none'; object-src 'none'");
  response.headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("strict-transport-security", "max-age=31536000");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  return response;
}

function tabAgeSeconds(lastSyncedAt: string | null) {
  if (!lastSyncedAt) return null;
  const parsed = Date.parse(lastSyncedAt);
  return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 1000)) : null;
}

async function catalog(env: SheetsDatabaseEnv) {
  const result = await env.DB.prepare(`SELECT
      d.alias AS document_alias,
      d.title AS document_title,
      t.spreadsheet_id,
      t.sheet_id,
      t.title,
      t.hidden,
      t.row_count,
      t.chunk_count,
      t.content_hash,
      t.last_synced_at,
      t.last_error
    FROM google_sheet_tabs t
    JOIN google_sheet_documents d ON d.spreadsheet_id = t.spreadsheet_id
    WHERE t.frontend_enabled = 1 AND t.mode = 'mirror'
    ORDER BY d.alias, t.sheet_index`).all<SheetTabRow>();
  const tabs = result.results.map((row) => ({
    document: row.document_alias,
    documentTitle: row.document_title,
    spreadsheetId: row.spreadsheet_id,
    sheetId: row.sheet_id,
    tab: row.title,
    hidden: Boolean(row.hidden),
    rows: row.row_count,
    chunks: row.chunk_count,
    ready: Boolean(row.content_hash),
    lastSyncedAt: row.last_synced_at,
    ageSeconds: tabAgeSeconds(row.last_synced_at),
    error: row.last_error,
  }));
  return secureJson({
    ok: true,
    frontendSource: "d1",
    dataStore: "Cloudflare D1",
    googleSheetsRole: "synchronized operational source",
    tabs,
  });
}

async function resolveTab(env: SheetsDatabaseEnv, document: string, tab: string) {
  return env.DB.prepare(`SELECT
      d.alias AS document_alias,
      d.title AS document_title,
      t.spreadsheet_id,
      t.sheet_id,
      t.title,
      t.hidden,
      t.row_count,
      t.chunk_count,
      t.content_hash,
      t.last_synced_at,
      t.last_error
    FROM google_sheet_tabs t
    JOIN google_sheet_documents d ON d.spreadsheet_id = t.spreadsheet_id
    WHERE t.frontend_enabled = 1
      AND t.mode = 'mirror'
      AND (d.alias = ? OR t.spreadsheet_id = ?)
      AND (t.title = ? OR CAST(t.sheet_id AS TEXT) = ?)
    LIMIT 1`)
    .bind(document, document, tab, tab)
    .first<SheetTabRow>();
}

export async function handleSheetsRead(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return secureJson({ ok: false, error: "Method not allowed" }, 405);
  if (!hasDatabase(env)) return secureJson({ ok: false, error: "D1 database binding is not configured" }, 503);

  const url = new URL(request.url);
  const document = url.searchParams.get("document")?.trim() || "";
  const tab = url.searchParams.get("tab")?.trim() || "";
  if (!document && !tab) return catalog(env);
  if (!document || !tab) return secureJson({ ok: false, error: "Both document and tab are required" }, 400);

  const resolved = await resolveTab(env, document, tab);
  if (!resolved) return secureJson({ ok: false, error: "D1 sheet is not frontend-enabled or does not exist" }, 404);
  if (!resolved.content_hash) {
    return secureJson({
      ok: false,
      error: "D1 sheet mirror has not completed its first synchronization",
      document: resolved.document_alias,
      tab: resolved.title,
    }, 503);
  }

  const chunks = await env.DB.prepare(`SELECT chunk_index, payload_json, content_hash
    FROM google_sheet_chunks
    WHERE spreadsheet_id = ? AND sheet_id = ?
    ORDER BY chunk_index`)
    .bind(resolved.spreadsheet_id, resolved.sheet_id)
    .all<SheetChunkRow>();

  if (chunks.results.length !== resolved.chunk_count) {
    return secureJson({ ok: false, error: "D1 sheet mirror is incomplete", expectedChunks: resolved.chunk_count, actualChunks: chunks.results.length }, 503);
  }
  if (chunks.results.some((chunk) => chunk.content_hash !== resolved.content_hash)) {
    return secureJson({ ok: false, error: "D1 sheet mirror failed revision integrity validation" }, 503);
  }

  const rows: unknown[][] = [];
  for (const chunk of chunks.results) {
    const parsed = JSON.parse(chunk.payload_json) as unknown;
    if (!Array.isArray(parsed)) return secureJson({ ok: false, error: "D1 sheet chunk is invalid" }, 503);
    rows.push(...parsed as unknown[][]);
  }
  if (rows.length !== resolved.row_count) {
    return secureJson({ ok: false, error: "D1 sheet row count failed integrity validation", expectedRows: resolved.row_count, actualRows: rows.length }, 503);
  }

  const ageSeconds = tabAgeSeconds(resolved.last_synced_at);
  return secureJson({
    ok: true,
    frontendSource: "d1",
    dataStore: "Cloudflare D1",
    googleSheetsRole: "synchronized operational source",
    document: resolved.document_alias,
    documentTitle: resolved.document_title,
    spreadsheetId: resolved.spreadsheet_id,
    sheetId: resolved.sheet_id,
    tab: resolved.title,
    contentHash: resolved.content_hash,
    lastSyncedAt: resolved.last_synced_at,
    ageSeconds,
    stale: ageSeconds !== null && ageSeconds > 30 * 60,
    rows,
  });
}
