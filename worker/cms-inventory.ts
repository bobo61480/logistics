import { runCmsReadonlyQuery, type CmsGatewayEnv } from "./cms-client";

type ColumnRow = { TABLE_SCHEMA?: unknown; TABLE_NAME?: unknown; COLUMN_NAME?: unknown };

export type CmsInventoryRow = {
  productName: string;
  sku: string;
  upc: string;
  expirationDate: string;
  quantity: number;
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

export async function fetchCmsInventory(env: CmsGatewayEnv) {
  const started = Date.now();
  const fetchedAt = new Date().toISOString();
  const health = (ok: boolean, error?: string) => ({
    name: "Siliconii CMS Inventory",
    ok,
    fetchedAt,
    latencyMs: Date.now() - started,
    error,
  });
  if (!env.CMS_MCP_URL) return { configured: false, rows: [] as CmsInventoryRow[], health: health(false, "CMS gateway is not configured") };
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
