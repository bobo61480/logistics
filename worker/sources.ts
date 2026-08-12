const LOGISTICS_MASTER_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const NATIONAL_SHEET_ID = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";
const WMS_SHEET_ID = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";

const IMPORTS_GID = 1497250700;
const OUTBOUND_GID = 20260708;
const NATIONAL_GID = 99300389;
const WMS_GID = 0;

export type SourceHealth = {
  name: string;
  ok: boolean;
  fetchedAt: string;
  latencyMs: number;
  error?: string;
};

export type SourceResult<T> = {
  health: SourceHealth;
  data: T | null;
};

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quoted) {
      if (ch === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(value);
      value = "";
    } else if (ch === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else value += ch;
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function parseGviz(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Unreadable GViz response");
  const payload = JSON.parse(text.slice(start, end + 1));
  if (!payload?.table) throw new Error("GViz response missing table");
  return payload.table;
}

async function timedFetch(name: string, url: URL): Promise<SourceResult<string>> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "StyleKorean-Control-Tower/2026-08-12" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return {
      data: text,
      health: { name, ok: true, fetchedAt: new Date().toISOString(), latencyMs: Date.now() - started },
    };
  } catch (error) {
    return {
      data: null,
      health: {
        name,
        ok: false,
        fetchedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCsvSource(name: string, spreadsheetId: string, gid: number): Promise<SourceResult<string[][]>> {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
  url.searchParams.set("format", "csv");
  url.searchParams.set("gid", String(gid));
  url.searchParams.set("_", String(Date.now()));
  const result = await timedFetch(name, url);
  if (!result.data) return { data: null, health: result.health };
  try {
    return { data: parseCsv(result.data), health: result.health };
  } catch (error) {
    return { data: null, health: { ...result.health, ok: false, error: String(error) } };
  }
}

export async function fetchGvizSource(
  name: string,
  spreadsheetId: string,
  options: { gid?: number; sheet?: string; range: string; headers?: number },
): Promise<SourceResult<unknown>> {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:json");
  if (options.gid !== undefined) url.searchParams.set("gid", String(options.gid));
  if (options.sheet) url.searchParams.set("sheet", options.sheet);
  url.searchParams.set("range", options.range);
  url.searchParams.set("headers", String(options.headers ?? 1));
  url.searchParams.set("_", String(Date.now()));
  const result = await timedFetch(name, url);
  if (!result.data) return { data: null, health: result.health };
  try {
    return { data: parseGviz(result.data), health: result.health };
  } catch (error) {
    return { data: null, health: { ...result.health, ok: false, error: String(error) } };
  }
}

export async function fetchOperationalSources() {
  const [imports, outbound, nationalOutbound, salesOutbound, inventoryDashboardTable, skwInboundTable, skwStockTable] =
    await Promise.all([
      fetchCsvSource("IMPORTS", LOGISTICS_MASTER_ID, IMPORTS_GID),
      fetchCsvSource("Outbound Shipping Schedule", LOGISTICS_MASTER_ID, OUTBOUND_GID),
      fetchGvizSource("Nationals", NATIONAL_SHEET_ID, { gid: NATIONAL_GID, range: "A1:U3500", headers: 1 }),
      fetchGvizSource("WMS Stylekorean", WMS_SHEET_ID, { gid: WMS_GID, range: "A2:AF4200", headers: 1 }),
      fetchGvizSource("Inventory", LOGISTICS_MASTER_ID, { sheet: "INVENTORY", range: "A1:O6500", headers: 1 }),
      fetchGvizSource("SKW Inbound", LOGISTICS_MASTER_ID, { sheet: "SKW_Inbound", range: "A1:R2500", headers: 1 }),
      fetchGvizSource("SKW Stock", LOGISTICS_MASTER_ID, { sheet: "SKW_Stock", range: "A1:J2500", headers: 1 }),
    ]);

  return {
    sourceHealth: [imports, outbound, nationalOutbound, salesOutbound, inventoryDashboardTable, skwInboundTable, skwStockTable].map(
      (entry) => entry.health,
    ),
    sources: {
      imports: imports.data,
      outbound: outbound.data,
      nationalOutbound: nationalOutbound.data,
      salesOutbound: salesOutbound.data,
      inventoryDashboardTable: inventoryDashboardTable.data,
      skwInboundTable: skwInboundTable.data,
      skwStockTable: skwStockTable.data,
    },
  };
}
