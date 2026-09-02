#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync(new URL("../config/google-sheets-manifest.json", import.meta.url), "utf8"));
const database = process.env.D1_DATABASE_NAME || manifest.database || "stylekorean-logistics-read-model";
const CHUNK_BYTES = 48 * 1024;
const FETCH_CONCURRENCY = 4;
const MAX_FETCH_ATTEMPTS = 3;

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

function gvizUrl(document, tab) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${document.spreadsheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:csv");
  url.searchParams.set("gid", String(tab.sheetId));
  url.searchParams.set("headers", "0");
  url.searchParams.set("_", String(Date.now()));
  return url.toString();
}

function allTabs() {
  return manifest.documents.flatMap((document) => document.tabs.map((tab) => ({ document, tab })));
}

function registrySql(now) {
  const statements = ["PRAGMA foreign_keys=ON;", "BEGIN;"];
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
  statements.push("COMMIT;");
  return statements.join("\n");
}

function currentHashes() {
  const result = executeSql("SELECT spreadsheet_id, sheet_id, content_hash FROM google_sheet_tabs WHERE content_hash IS NOT NULL;");
  const rows = result.flatMap((entry) => entry?.results || []);
  return new Map(rows.map((row) => [`${row.spreadsheet_id}:${row.sheet_id}`, row.content_hash]));
}

function tabWriteSql(document, tab, rows, contentHash, chunks, now) {
  const statements = ["PRAGMA foreign_keys=ON;", "BEGIN;"];
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
  statements.push("COMMIT;");
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
      const csv = await fetchWithRetry(gvizUrl(document, tab), `${document.alias}/${tab.title}`);
      const rows = redactRows(trimGrid(parseCsv(csv)), tab.redactColumns || []);
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
