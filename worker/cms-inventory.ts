import { runCmsReadonlyQuery, type CmsGatewayEnv } from "./cms-client";

const DIRECT_STOCK_URL = "https://ims.siliconii.com/api/get/report/stock/expdate";
// The IMS host responds in a few seconds from a normal network, but its
// Cloudflare egress path can hang until the previous 25-second timeout. Keep
// the direct attempt short and fall back to the Google Apps Script egress.
const DIRECT_TIMEOUT_MS = 8_000;
const PROXY_TIMEOUT_MS = 45_000;

type ColumnRow = { TABLE_SCHEMA?: unknown; TABLE_NAME?: unknown; COLUMN_NAME?: unknown };

export type CmsInventoryRow = {
  productName: string;
  sku: string;
  upc: string;
  expirationDate: string;
  quantity: number;
};

type DirectInventoryEnv = CmsGatewayEnv & {
  CMS_IMS_API_KEY?: string;
  APPS_SCRIPT_WRITE_URL?: string;
};

const SKU_COLUMNS = ["sku", "sku_cd", "prod_cd", "product_cd", "item_cd", "goods_cd"];
const QTY_COLUMNS = ["qty", "stock_qty", "stock_qtot", "inv_qty", "onhand_qty", "on_hand_qty", "wh_qty", "avail_qty"];
const NAME_COLUMNS = ["product_name", "prod_nm", "item_nm", "goods_nm", "sku_nm"];
const UPC_COLUMNS = ["upc", "barcode", "bar_cd", "upc_cd"];
const EXPIRY_COLUMNS = ["expiration_date", "expiry_date", "expire_dt", "expr_dt", "exp_dt"];

function text(value: unknown) { return String(value ?? "").trim(); }
function safeIdentifier(value: string) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error("CMS metadata returned an unsafe identifier");
  return `[${value}]`;
}
function findColumn(columns: string[], aliases: string[]) {
  const normalized = new Map(columns.map((column) => [column.toLowerCase(), column]));
  return aliases.map((alias) => normalized.get(alias)).find(Boolean) ?? "";
}

async function fetchDirectCmsInventory(env: DirectInventoryEnv) {
  if (!env.CMS_IMS_API_KEY) return null;
  const url = new URL(DIRECT_STOCK_URL);
  url.search = new URLSearchParams({
    curr_lang: "ENG", comp_cd: "CO000007", exp_date_fr: "", exp_date_to: "",
    prod_cd: "", prod_nm: "", brand_cd: "", brand_nm: "", hide_null_cost: "false",
  }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        "x-api-key": env.CMS_IMS_API_KEY,
        Origin: "https://cms.siliconii.com",
        Referer: "https://cms.siliconii.com/ImsReport/StockExpDate",
        "User-Agent": "StyleKorean-Control-Tower/2026-08-30",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Siliconii IMS HTTP ${response.status}`);
    const payload = await response.json() as { ResultCode?: string; ResultMessage?: string; Data?: Array<Record<string, unknown>> };
    if (payload.ResultCode !== "0000" || !Array.isArray(payload.Data)) throw new Error(payload.ResultMessage || "Siliconii IMS returned invalid inventory data");
    return payload.Data.map((row): CmsInventoryRow => ({
      productName: text(row.prod_nm), sku: text(row.prod_cd), upc: text(row.barcode),
      expirationDate: text(row.exp_date), quantity: Number(row.stock_qty) || 0,
    })).filter((row) => row.sku);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAppsScriptCmsInventory(env: DirectInventoryEnv) {
  // Keep this path in the published Worker bundle alongside the IMS secret;
  // secret-only deployments otherwise preserve the prior script version.
  if (!env.APPS_SCRIPT_WRITE_URL || !env.CMS_IMS_API_KEY) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(env.APPS_SCRIPT_WRITE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ action: "cmsInventory", apiKey: env.CMS_IMS_API_KEY }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CMS IMS proxy HTTP ${response.status}`);
    const payload = await response.json() as { ok?: boolean; rows?: Array<Record<string, unknown>>; error?: string };
    if (payload.ok !== true || !Array.isArray(payload.rows)) throw new Error(payload.error || "CMS IMS proxy returned invalid inventory data");
    return payload.rows.map((row): CmsInventoryRow => ({
      productName: text(row.productName), sku: text(row.sku), upc: text(row.upc),
      expirationDate: text(row.expirationDate), quantity: Number(row.quantity) || 0,
    })).filter((row) => row.sku);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchCmsInventory(env: DirectInventoryEnv) {
  const started = Date.now();
  const fetchedAt = new Date().toISOString();
  const health = (ok: boolean, error?: string) => ({
    name: "Siliconii CMS Inventory",
    ok,
    fetchedAt,
    latencyMs: Date.now() - started,
    error,
  });
  if (!env.CMS_MCP_URL && !env.CMS_IMS_API_KEY) return { configured: false, rows: [] as CmsInventoryRow[], health: health(false, "CMS gateway is not configured") };
  let directError = "";
  if (env.CMS_IMS_API_KEY) {
    try {
      const directRows = await fetchDirectCmsInventory(env);
      if (directRows) return { configured: true, rows: directRows, health: health(true) };
    } catch (error) {
      directError = error instanceof Error ? error.message : String(error);
    }
    try {
      const proxiedRows = await fetchAppsScriptCmsInventory(env);
      if (proxiedRows) return { configured: true, rows: proxiedRows, health: health(true) };
    } catch (error) {
      const proxyError = error instanceof Error ? error.message : String(error);
      throw new Error(`${proxyError}${directError ? ` (direct IMS: ${directError})` : ""}`);
    }
  }
  try {
    const metadata = await runCmsReadonlyQuery(env, `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
      FROM CSMS.INFORMATION_SCHEMA.COLUMNS
      WHERE LOWER(COLUMN_NAME) IN ('${[...SKU_COLUMNS, ...QTY_COLUMNS, ...NAME_COLUMNS, ...UPC_COLUMNS, ...EXPIRY_COLUMNS].join("','")}')
      ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`, 5000,
      "Discover the approved read-only Siliconii inventory table and its product identifiers");
    const tables = new Map<string, { schema: string; table: string; columns: string[] }>();
    for (const raw of metadata as ColumnRow[]) {
      const schema = text(raw.TABLE_SCHEMA || (raw as Record<string, unknown>).table_schema);
      const table = text(raw.TABLE_NAME || (raw as Record<string, unknown>).table_name);
      const column = text(raw.COLUMN_NAME || (raw as Record<string, unknown>).column_name);
      if (!schema || !table || !column) continue;
      const key = `${schema}.${table}`;
      const entry = tables.get(key) ?? { schema, table, columns: [] };
      entry.columns.push(column);
      tables.set(key, entry);
    }
    const candidates = [...tables.values()].map((table) => ({
      ...table,
      sku: findColumn(table.columns, SKU_COLUMNS),
      quantity: findColumn(table.columns, QTY_COLUMNS),
      name: findColumn(table.columns, NAME_COLUMNS),
      upc: findColumn(table.columns, UPC_COLUMNS),
      expiry: findColumn(table.columns, EXPIRY_COLUMNS),
    })).filter((table) => table.sku && table.quantity)
      .sort((a, b) => Number(/stock|invt|invent|warehouse/i.test(b.table)) - Number(/stock|invt|invent|warehouse/i.test(a.table)));
    const source = candidates[0];
    if (!source) throw new Error("No CMS table exposes both a SKU and stock quantity column");
    const select = (column: string, alias: string) => column ? `${safeIdentifier(column)} AS ${alias}` : `'' AS ${alias}`;
    const sql = `SELECT TOP 10000 ${select(source.name, "productName")}, ${select(source.sku, "sku")},
      ${select(source.upc, "upc")}, ${select(source.expiry, "expirationDate")},
      ${safeIdentifier(source.quantity)} AS quantity
      FROM [CSMS].${safeIdentifier(source.schema)}.${safeIdentifier(source.table)} WITH (NOLOCK)
      WHERE ${safeIdentifier(source.sku)} IS NOT NULL AND ${safeIdentifier(source.quantity)} <> 0`;
    const result = await runCmsReadonlyQuery(env, sql, 10000, "Read current Siliconii stock for D1 inventory reconciliation");
    const rows = result.map((row): CmsInventoryRow => ({
      productName: text(row.productName),
      sku: text(row.sku),
      upc: text(row.upc),
      expirationDate: text(row.expirationDate),
      quantity: Number(row.quantity) || 0,
    })).filter((row) => row.sku);
    return { configured: true, rows, health: health(true) };
  } catch (error) {
    console.error(JSON.stringify({ event: "siliconii-cms-inventory-failed", error: String(error) }));
    return { configured: true, rows: [] as CmsInventoryRow[], health: health(false, error instanceof Error ? error.message : String(error)) };
  }
}
