#!/usr/bin/env node

import { createHash, createSign, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync(new URL("../config/google-sheets-manifest.json", import.meta.url), "utf8"));
const database = process.env.D1_DATABASE_NAME || manifest.database || "stylekorean-logistics-read-model";
const CHUNK_BYTES = 48 * 1024;
const FETCH_CONCURRENCY = 4;
const MAX_FETCH_ATTEMPTS = 3;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const GOOGLE_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets/";

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function wrangler(args, options = {}) {
  const bin = process.platform === "win32" ? "npx.cmd" : "npx";
  return execFileSync(bin, ["wrangler", ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseWranglerJson(text) {
  const firstArray = text.indexOf("[");
  const firstObject = text.indexOf("{");
  const start = firstArray < 0 ? firstObject : firstObject < 0 ? firstArray : Math.min(firstArray, firstObject);
  if (start < 0) throw new Error("Wrangler returned no JSON payload");
  return JSON.parse(text.slice(start));
}

function executeSql(command) {
  const out = wrangler(["d1", "execute", database, "--remote", "--command", command, "--json"], { capture: true });
  return parseWranglerJson(out);
}

function executeFile(contents, label) {
  const dir = mkdtempSync(join(tmpdir(), "stylekorean-d1-"));
  const file = join(dir, `${label.replace(/[^a-z0-9_.-]+/gi, "-")}.sql`);
  try {
    writeFileSync(file, contents, "utf8");
    // Wrangler D1 file imports are already atomic. Explicit BEGIN/COMMIT is
    // rejected by D1 and would also duplicate Wrangler's rollback protection.
    wrangler(["d1", "execute", database, "--remote", "--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(value); value = ""; }
    else if (ch === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += ch;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function trimGrid(rows) {
  const output = rows.map((row) => {
    const copy = row.map((cell) => String(cell ?? ""));
    while (copy.length && copy.at(-1) === "") copy.pop();
    return copy;
  });
  while (output.length && output.at(-1).length === 0) output.pop();
  return output;
}

function redactRows(rows, redactColumns = []) {
  if (!Array.isArray(redactColumns) || redactColumns.length === 0) return rows;
  const indexes = new Set(redactColumns.map(Number));
  return rows.map((row) => row.map((value, index) => indexes.has(index) ? "[REDACTED]" : value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function chunkRows(rows) {
  const chunks = [];
  let current = [];
  let start = 1;
  for (const row of rows) {
    const candidate = [...current, row];
    const bytes = Buffer.byteLength(JSON.stringify(candidate));
    if (current.length && bytes > CHUNK_BYTES) {
      const payload = JSON.stringify(current);
      chunks.push({ rowStart: start, rowEnd: start + current.length - 1, payload, bytes: Buffer.byteLength(payload) });
      start += current.length;
      current = [row];
    } else {
      current = candidate;
    }
  }
  if (current.length || rows.length === 0) {
    const payload = JSON.stringify(current);
    chunks.push({ rowStart: start, rowEnd: start + Math.max(0, current.length - 1), payload, bytes: Buffer.byteLength(payload) });
  }
  return chunks;
}

function parseJsonSecret(raw, label) {
  if (!raw) return null;
  const candidates = [String(raw).trim()];
  try {
    candidates.push(Buffer.from(String(raw).trim(), "base64").toString("utf8"));
  } catch {}
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  throw new Error(`${label} is set but is not valid JSON/base64 JSON`);
}

function loadServiceAccount() {
  const parsed = parseJsonSecret(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, "GOOGLE_SERVICE_ACCOUNT_JSON");
  const clientEmail = String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || parsed?.client_email || "").trim();
  const privateKey = String(process.env.GOOGLE_PRIVATE_KEY || parsed?.private_key || "").replaceAll("\\n", "\n").trim();
  if (!clientEmail && !privateKey) return null;
  if (!clientEmail || !privateKey) throw new Error("Google service-account credentials are incomplete");
  return { clientEmail, privateKey };
}

function loadClaspOAuth() {
  const parsed = parseJsonSecret(process.env.CLASP_ACCESS_TOKEN, "CLASP_ACCESS_TOKEN");
  if (!parsed) return null;
  const token = parsed.token || parsed.tokens || parsed;
  const settings = parsed.oauth2ClientSettings || parsed.oauth2_client_settings || parsed.credentials || {};
  const accessToken = String(token.access_token || token.accessToken || "").trim();
  const refreshToken = String(token.refresh_token || token.refreshToken || "").trim();
  const clientId = String(settings.clientId || settings.client_id || parsed.client_id || "").trim();
  const clientSecret = String(settings.clientSecret || settings.client_secret || parsed.client_secret || "").trim();
  const expiryDate = Number(token.expiry_date || token.expiryDate || 0);
  const scope = String(token.scope || "").trim();
  if (!accessToken && !refreshToken) throw new Error("CLASP_ACCESS_TOKEN contains no OAuth access_token or refresh_token");
  return { accessToken, refreshToken, clientId, clientSecret, expiryDate, scope };
}

const serviceAccount = loadServiceAccount();
const claspOAuth = loadClaspOAuth();
let accessTokenPromise = null;

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function exchangeServiceAccountToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: serviceAccount.clientEmail,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.privateKey).toString("base64url");
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Google service-account token exchange failed: ${detail}`);
  }
  return payload.access_token;
}

async function exchangeClaspRefreshToken() {
  if (!claspOAuth?.refreshToken || !claspOAuth.clientId || !claspOAuth.clientSecret) {
    if (claspOAuth?.accessToken) return claspOAuth.accessToken;
    throw new Error("CLASP_ACCESS_TOKEN cannot refresh because OAuth client settings are incomplete");
  }
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: claspOAuth.clientId,
      client_secret: claspOAuth.clientSecret,
      refresh_token: claspOAuth.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Clasp OAuth refresh failed: ${detail}`);
  }
  return payload.access_token;
}

async function getGoogleAccessToken() {
  if (!serviceAccount && !claspOAuth) throw new Error("No Google OAuth credential is configured");
  if (!accessTokenPromise) {
    accessTokenPromise = (async () => {
      if (serviceAccount) return exchangeServiceAccountToken();
      if (claspOAuth.accessToken && (!claspOAuth.expiryDate || claspOAuth.expiryDate > Date.now() + 60_000)) {
        return claspOAuth.accessToken;
      }
      return exchangeClaspRefreshToken();
    })();
  }
  return accessTokenPromise;
}

async function fetchWithRetry(url, label) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "StyleKorean-D1-Sheet-Mirror/1.0", accept: "text/csv,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (/^\s*</.test(text)) throw new Error("Google returned HTML instead of CSV");
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function fetchSheetsApiRows(document, tab) {
  const token = await getGoogleAccessToken();
  const escapedTitle = String(tab.title).replaceAll("'", "''");
  const range = `'${escapedTitle}'`;
  const url = new URL(`${GOOGLE_SHEETS_API}${document.spreadsheetId}/values/${encodeURIComponent(range)}`);
  url.searchParams.set("majorDimension", "ROWS");
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "user-agent": "StyleKorean-D1-Sheet-Mirror/1.0",
    },
    signal: AbortSignal.timeout(45_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`${document.alias}/${tab.title}: Sheets API ${detail}`);
  }
  return Array.isArray(payload.values) ? payload.values : [];
}

function gvizUrl(document, tab) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${document.spreadsheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:csv");
  url.searchParams.set("gid", String(tab.sheetId));
  url.searchParams.set("headers", "0");
  url.searchParams.set("_", String(Date.now()));
  return url.toString();
}

async function fetchTabRows(document, tab) {
  const label = `${document.alias}/${tab.title}`;
  const privateWorkbook = document.alias !== "logistics-master";
  if (privateWorkbook) {
    if (!serviceAccount && !claspOAuth) throw new Error(`${label}: authenticated Google OAuth is required for private workbook sync`);
    try {
      return await fetchSheetsApiRows(document, tab);
    } catch (apiError) {
      try {
        const csv = await fetchWithRetry(gvizUrl(document, tab), label);
        return parseCsv(csv);
      } catch (gvizError) {
        throw new Error(`${apiError instanceof Error ? apiError.message : String(apiError)}; public fallback failed: ${gvizError instanceof Error ? gvizError.message : String(gvizError)}`);
      }
    }
  }

  try {
    const csv = await fetchWithRetry(gvizUrl(document, tab), label);
    return parseCsv(csv);
  } catch (gvizError) {
    if (!serviceAccount && !claspOAuth) throw gvizError;
    return fetchSheetsApiRows(document, tab);
  }
}

function allTabs() {
  return manifest.documents.flatMap((document) => document.tabs.map((tab) => ({ document, tab })));
}

function registrySql(now) {
  const statements = ["PRAGMA foreign_keys=ON;"];
  for (const document of manifest.documents) {
    const sourceUrl = `https://docs.google.com/spreadsheets/d/${document.spreadsheetId}/edit`;
    statements.push(`INSERT INTO google_sheet_documents
      (spreadsheet_id, alias, title, source_url, timezone, enabled, last_checked_at)
      VALUES (${sql(document.spreadsheetId)}, ${sql(document.alias)}, ${sql(document.title)}, ${sql(sourceUrl)}, ${sql(document.timezone || "America/Los_Angeles")}, 1, ${sql(now)})
      ON CONFLICT(spreadsheet_id) DO UPDATE SET alias=excluded.alias, title=excluded.title,
      source_url=excluded.source_url, timezone=excluded.timezone, enabled=1, last_checked_at=excluded.last_checked_at;`);
    for (const tab of document.tabs) {
      statements.push(`INSERT INTO google_sheet_tabs
        (spreadsheet_id, sheet_id, title, sheet_index, sheet_type, hidden, mode, frontend_enabled,
         redact_columns_json, row_count_hint, column_count_hint, last_checked_at)
        VALUES (${sql(document.spreadsheetId)}, ${sql(tab.sheetId)}, ${sql(tab.title)}, ${sql(tab.index)}, ${sql(tab.sheetType || "GRID")},
          ${tab.hidden ? 1 : 0}, ${sql(tab.mode || "mirror")}, ${tab.frontend ? 1 : 0}, ${sql(JSON.stringify(tab.redactColumns || []))},
          ${sql(tab.rows || 0)}, ${sql(tab.columns || 0)}, ${sql(now)})
        ON CONFLICT(spreadsheet_id, sheet_id) DO UPDATE SET title=excluded.title, sheet_index=excluded.sheet_index,
          sheet_type=excluded.sheet_type, hidden=excluded.hidden, mode=excluded.mode,
          frontend_enabled=excluded.frontend_enabled, redact_columns_json=excluded.redact_columns_json,
          row_count_hint=excluded.row_count_hint, column_count_hint=excluded.column_count_hint,
          last_checked_at=excluded.last_checked_at;`);
      if (tab.mode === "metadata_only") {
        statements.push(`DELETE FROM google_sheet_chunks WHERE spreadsheet_id=${sql(document.spreadsheetId)} AND sheet_id=${sql(tab.sheetId)};`);
        statements.push(`UPDATE google_sheet_tabs SET row_count=0, chunk_count=0, content_hash=NULL, last_error=NULL
          WHERE spreadsheet_id=${sql(document.spreadsheetId)} AND sheet_id=${sql(tab.sheetId)};`);
      }
    }
  }
  return statements.join("\n");
}

function currentHashes() {
  const result = executeSql("SELECT spreadsheet_id, sheet_id, content_hash FROM google_sheet_tabs WHERE content_hash IS NOT NULL;");
  const rows = result.flatMap((entry) => entry?.results || []);
  return new Map(rows.map((row) => [`${row.spreadsheet_id}:${row.sheet_id}`, row.content_hash]));
}

function tabWriteSql(document, tab, rows, contentHash, chunks, now) {
  const statements = ["PRAGMA foreign_keys=ON;"];
  statements.push(`DELETE FROM google_sheet_chunks WHERE spreadsheet_id=${sql(document.spreadsheetId)} AND sheet_id=${sql(tab.sheetId)};`);
  chunks.forEach((chunk, index) => {
    statements.push(`INSERT INTO google_sheet_chunks
      (spreadsheet_id, sheet_id, chunk_index, row_start, row_end, payload_json, payload_bytes, content_hash, synced_at)
      VALUES (${sql(document.spreadsheetId)}, ${sql(tab.sheetId)}, ${index}, ${chunk.rowStart}, ${chunk.rowEnd},
        ${sql(chunk.payload)}, ${chunk.bytes}, ${sql(contentHash)}, ${sql(now)});`);
  });
  statements.push(`UPDATE google_sheet_tabs SET row_count=${rows.length}, chunk_count=${chunks.length}, content_hash=${sql(contentHash)},
    last_checked_at=${sql(now)}, last_synced_at=${sql(now)}, last_error=NULL
    WHERE spreadsheet_id=${sql(document.spreadsheetId)} AND sheet_id=${sql(tab.sheetId)};`);
  statements.push(`UPDATE google_sheet_documents SET last_checked_at=${sql(now)}, last_synced_at=${sql(now)}, last_error=NULL
    WHERE spreadsheet_id=${sql(document.spreadsheetId)};`);
  return statements.join("\n");
}

function unchangedSql(document, tab, now, rowsLength) {
  return `UPDATE google_sheet_tabs SET row_count=${rowsLength}, last_checked_at=${sql(now)}, last_error=NULL
    WHERE spreadsheet_id=${sql(document.spreadsheetId)} AND sheet_id=${sql(tab.sheetId)};
    UPDATE google_sheet_documents SET last_checked_at=${sql(now)} WHERE spreadsheet_id=${sql(document.spreadsheetId)};`;
}

function errorSql(document, tab, now, message) {
  return `UPDATE google_sheet_tabs SET last_checked_at=${sql(now)}, last_error=${sql(message)}
    WHERE spreadsheet_id=${sql(document.spreadsheetId)} AND sheet_id=${sql(tab.sheetId)};
    UPDATE google_sheet_documents SET last_checked_at=${sql(now)}, last_error=${sql(message)} WHERE spreadsheet_id=${sql(document.spreadsheetId)};`;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  console.log(`Google Sheets -> D1 mirror starting: ${runId}`);
  executeFile(registrySql(startedAt), "registry");
  const hashes = currentHashes();
  const candidates = allTabs().filter(({ tab }) => tab.mode !== "metadata_only");
  const fetched = await mapLimit(candidates, FETCH_CONCURRENCY, async ({ document, tab }) => {
    try {
      const sourceRows = await fetchTabRows(document, tab);
      const rows = redactRows(trimGrid(sourceRows), tab.redactColumns || []);
      const serialized = JSON.stringify(rows);
      const contentHash = sha256(serialized);
      return { document, tab, rows, contentHash, chunks: chunkRows(rows), error: null };
    } catch (error) {
      return { document, tab, rows: [], contentHash: "", chunks: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

  let checkedTabs = 0;
  let changedTabs = 0;
  let errorTabs = 0;
  const detail = [];
  for (const item of fetched) {
    const { document, tab } = item;
    const now = new Date().toISOString();
    checkedTabs += 1;
    if (item.error) {
      errorTabs += 1;
      console.error(`ERROR ${document.alias}/${tab.title}: ${item.error}`);
      executeSql(errorSql(document, tab, now, item.error));
      detail.push({ document: document.alias, tab: tab.title, ok: false, error: item.error });
      continue;
    }
    const key = `${document.spreadsheetId}:${tab.sheetId}`;
    if (hashes.get(key) === item.contentHash) {
      executeSql(unchangedSql(document, tab, now, item.rows.length));
      console.log(`UNCHANGED ${document.alias}/${tab.title}: ${item.rows.length} rows`);
      detail.push({ document: document.alias, tab: tab.title, ok: true, changed: false, rows: item.rows.length });
      continue;
    }
    executeFile(tabWriteSql(document, tab, item.rows, item.contentHash, item.chunks, now), `${document.alias}-${tab.sheetId}`);
    changedTabs += 1;
    console.log(`SYNCED ${document.alias}/${tab.title}: ${item.rows.length} rows, ${item.chunks.length} chunks`);
    detail.push({ document: document.alias, tab: tab.title, ok: true, changed: true, rows: item.rows.length, chunks: item.chunks.length });
  }

  const finishedAt = new Date().toISOString();
  const metadataOnlyCount = allTabs().length - candidates.length;
  const status = errorTabs === 0 ? "success" : changedTabs > 0 ? "partial" : "error";
  const runSql = `INSERT INTO google_sheet_sync_runs
    (id, started_at, finished_at, status, checked_tabs, changed_tabs, error_tabs, detail_json)
    VALUES (${sql(runId)}, ${sql(startedAt)}, ${sql(finishedAt)}, ${sql(status)}, ${checkedTabs}, ${changedTabs}, ${errorTabs}, ${sql(JSON.stringify({ metadataOnlyCount, tabs: detail }))});`;
  executeSql(runSql);
  console.log(JSON.stringify({ runId, status, checkedTabs, changedTabs, errorTabs, metadataOnlyCount, startedAt, finishedAt }, null, 2));
  if (errorTabs > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});