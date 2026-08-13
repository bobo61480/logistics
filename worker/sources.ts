import { detectStrongCarrier, trackingCandidate } from "../lib/domain/carriers";

const LOGISTICS_MASTER_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const NATIONAL_SHEET_ID = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";
const WMS_SHEET_ID = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";

const IMPORTS_GID = 1497250700;
const OUTBOUND_GID = 20260708;
const TRUCKING_GID = 1418033635;
const TRANSFERS_GID = 1834454901;
const NATIONAL_GID = 99300389;
const WMS_GID = 0;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

export type SourceHealth = { name: string; ok: boolean; fetchedAt: string; latencyMs: number; error?: string };
export type SourceResult<T> = { health: SourceHealth; data: T | null };

type GvizTable = { cols?: Array<{ label?: string }>; rows?: Array<{ c?: Array<{ v?: unknown; f?: string } | null> }> };

export async function readBoundedText(response: Response, maxBytes = MAX_SOURCE_BYTES) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Source response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error(`Source response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quoted) {
      if (ch === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
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

function parseGviz(text: string): GvizTable {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Unreadable GViz response");
  const payload = JSON.parse(text.slice(start, end + 1));
  if (!payload?.table) throw new Error("GViz response missing table");
  return payload.table;
}

export function gvizTableRows(table: GvizTable | null) {
  if (!table) return [];
  const header = (table.cols ?? []).map((col) => String(col?.label ?? ""));
  const rows = (table.rows ?? []).map((row) =>
    (row.c ?? []).map((cell) => String(cell?.f ?? cell?.v ?? "")),
  );
  return [header, ...rows];
}

/** Normalize malformed parcel columns in the read snapshot only. */
export function normalizeImportsParcelRows(rows: string[][]) {
  const parcelsIndex = rows.findIndex((row) => String(row[0] ?? "").trim().toUpperCase() === "PARCELS");
  if (parcelsIndex < 0) return rows.map((row) => row.slice());
  return rows.map((sourceRow, index) => {
    const row = sourceRow.slice();
    if (index <= parcelsIndex) return row;
    const columnB = row[1] ?? "";
    const columnC = row[2] ?? "";
    const columnK = row[10] ?? "";
    const candidate = trackingCandidate(columnB, columnC, columnK);
    if (!detectStrongCarrier(candidate)) return row;
    row[1] = candidate;
    if (detectStrongCarrier(columnC) && candidate === String(columnC).replace(/[\s-]+/g, "").toUpperCase()) row[2] = "";
    return row;
  });
}

async function timedFetch(name: string, url: URL): Promise<SourceResult<string>> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { headers: { "user-agent": "StyleKorean-Control-Tower/2026-08-12" }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { data: await readBoundedText(response), health: { name, ok: true, fetchedAt: new Date().toISOString(), latencyMs: Date.now() - started } };
  } catch (error) {
    return { data: null, health: { name, ok: false, fetchedAt: new Date().toISOString(), latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) } };
  } finally { clearTimeout(timer); }
}

export async function fetchCsvSource(name: string, spreadsheetId: string, gid: number): Promise<SourceResult<string[][]>> {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
  url.searchParams.set("format", "csv");
  url.searchParams.set("gid", String(gid));
  url.searchParams.set("_", String(Date.now()));
  const result = await timedFetch(name, url);
  if (!result.data) return { data: null, health: result.health };
  try { return { data: parseCsv(result.data), health: result.health }; }
  catch (error) { return { data: null, health: { ...result.health, ok: false, error: String(error) } }; }
}

export async function fetchGvizSource(name: string, spreadsheetId: string, options: { gid?: number; sheet?: string; range: string; headers?: number }): Promise<SourceResult<GvizTable>> {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:json");
  if (options.gid !== undefined) url.searchParams.set("gid", String(options.gid));
  if (options.sheet) url.searchParams.set("sheet", options.sheet);
  url.searchParams.set("range", options.range);
  url.searchParams.set("headers", String(options.headers ?? 1));
  url.searchParams.set("_", String(Date.now()));
  const result = await timedFetch(name, url);
  if (!result.data) return { data: null, health: result.health };
  try { return { data: parseGviz(result.data), health: result.health }; }
  catch (error) { return { data: null, health: { ...result.health, ok: false, error: String(error) } }; }
}

export async function fetchOperationalSources() {
  const [imports, outbound, trucking, transfers, nationalOutbound, salesOutbound, inventoryDashboardTable, skwInboundTable, skwStockTable] = await Promise.all([
    fetchCsvSource("IMPORTS", LOGISTICS_MASTER_ID, IMPORTS_GID),
    fetchCsvSource("Outbound Shipping Schedule", LOGISTICS_MASTER_ID, OUTBOUND_GID),
    fetchCsvSource("WH Trucking Request", LOGISTICS_MASTER_ID, TRUCKING_GID),
    fetchCsvSource("TRANSFERS", LOGISTICS_MASTER_ID, TRANSFERS_GID),
    fetchGvizSource("Nationals", NATIONAL_SHEET_ID, { gid: NATIONAL_GID, range: "A1:U3500", headers: 1 }),
    fetchGvizSource("WMS Stylekorean", WMS_SHEET_ID, { gid: WMS_GID, range: "A2:AF4200", headers: 1 }),
    fetchGvizSource("Inventory", LOGISTICS_MASTER_ID, { sheet: "INVENTORY", range: "A1:O6500", headers: 1 }),
    fetchGvizSource("SKW Inbound", LOGISTICS_MASTER_ID, { sheet: "SKW_Inbound", range: "A1:R2500", headers: 1 }),
    fetchGvizSource("SKW Stock", LOGISTICS_MASTER_ID, { sheet: "SKW_Stock", range: "A1:J2500", headers: 1 }),
  ]);

  return {
    sourceHealth: [imports, outbound, trucking, transfers, nationalOutbound, salesOutbound, inventoryDashboardTable, skwInboundTable, skwStockTable].map((entry) => entry.health),
    sources: {
      imports: imports.data ? normalizeImportsParcelRows(imports.data) : null,
      outbound: outbound.data,
      nationalOutbound: nationalOutbound.data,
      salesOutbound: salesOutbound.data,
      inventoryDashboardTable: inventoryDashboardTable.data,
      skwInboundTable: skwInboundTable.data,
      skwStockTable: skwStockTable.data,
    },
    kpiRows: {
      nationalRows: gvizTableRows(nationalOutbound.data),
      wmsRows: gvizTableRows(salesOutbound.data),
      truckingRows: trucking.data ?? [],
      transferRows: transfers.data ?? [],
    },
  };
}
