const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;
const DIRECT_TIMEOUT_MS = 15_000;
const MAX_QUERY_LIMIT = 10_000;
const DIRECT_INVOICE_URL = "https://cms.siliconii.com/SalesProcess/INVCList";

type Env = {
  CMS_UPSTREAM_MCP_URL: string;
  CMS_MCP_AUTH_TOKEN?: string;
  CMS_IMS_API_KEY?: string;
};

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: {
      sql?: string;
      limit?: number;
      prompt?: string;
    };
  };
};

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function safeIdentifier(value: string) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error("Unsafe CMS identifier");
  return `[${value}]`;
}

function validateReadonlySql(sql: string) {
  const compact = sql.replace(/\s+/g, " ").trim();
  if (!compact || compact.length > 20_000) throw new Error("Invalid SQL length");
  if (!/^(select|with)\b/i.test(compact)) throw new Error("Only SELECT/CTE queries are allowed");
  const withoutTrailing = compact.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) throw new Error("Multiple SQL statements are not allowed");
  const forbidden = /\b(insert|update|delete|merge|drop|alter|create|truncate|exec(?:ute)?|grant|revoke|deny|backup|restore|dbcc|use|into)\b/i;
  if (forbidden.test(withoutTrailing)) throw new Error("Write-capable SQL is not allowed");
  return withoutTrailing;
}

function parseRpc(raw: string) {
  const trimmed = raw.trim();
  const payload = trimmed.startsWith("{")
    ? trimmed
    : trimmed.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
  if (!payload) throw new Error("Upstream CMS gateway returned an unreadable response");
  return JSON.parse(payload) as {
    error?: unknown;
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
}

async function runReadonlyQuery(env: Env, sql: string, limit: number, prompt: string) {
  if (!env.CMS_UPSTREAM_MCP_URL) throw new Error("CMS upstream gateway is not configured");
  const safeSql = validateReadonlySql(sql);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, MAX_QUERY_LIMIT));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (env.CMS_MCP_AUTH_TOKEN) headers.Authorization = `Bearer ${env.CMS_MCP_AUTH_TOKEN}`;
    const response = await fetch(env.CMS_UPSTREAM_MCP_URL, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          name: "run_readonly_query",
          arguments: { sql: safeSql, limit: safeLimit, prompt: text(prompt).slice(0, 500) },
        },
      }),
    });
    if (!response.ok) throw new Error(`CMS upstream HTTP ${response.status}`);
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) throw new Error("CMS response exceeded byte limit");
    const rpc = parseRpc(raw);
    if (rpc.error || rpc.result?.isError) throw new Error("CMS upstream rejected the read-only query");
    const content = rpc.result?.content?.map((item) => item.text ?? "").join("") ?? "";
    const parsed = JSON.parse(content) as { error?: unknown; rows?: Record<string, unknown>[] };
    if (parsed.error || !Array.isArray(parsed.rows)) throw new Error("CMS upstream returned invalid query data");
    return parsed.rows;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleMcp(request: Request, env: Env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: RpcRequest;
  try {
    body = await request.json<RpcRequest>();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }, 400);
  }
  const id = body.id ?? null;
  if (body.method !== "tools/call" || body.params?.name !== "run_readonly_query") {
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Only run_readonly_query is available" } }, 400);
  }
  try {
    const args = body.params.arguments ?? {};
    const rows = await runReadonlyQuery(env, text(args.sql), Number(args.limit) || 1000, text(args.prompt));
    return json({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify({ rows }) }], isError: false },
    });
  } catch (error) {
    return json({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], isError: true },
    }, 400);
  }
}

function monthBounds(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("month must be YYYY-MM");
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${year}-${String(monthNumber).padStart(2, "0")}-01`;
  const next = monthNumber === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
  const endDate = new Date(`${next}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  return { start, next, end: endDate.toISOString().slice(0, 10) };
}

function extractRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"));
  if (!payload || typeof payload !== "object") return [];
  const object = payload as Record<string, unknown>;
  for (const key of ["Data", "data", "rows", "Rows", "result", "Result", "list", "List"]) {
    const value = object[key];
    if (Array.isArray(value)) return value.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"));
  }
  return [];
}

async function fetchDirectInvoiceRows(env: Env, month: string) {
  if (!env.CMS_IMS_API_KEY) throw new Error("Direct CMS API key is not configured");
  const { start, end } = monthBounds(month);
  const url = new URL(DIRECT_INVOICE_URL);
  url.search = new URLSearchParams({
    mode: "LIST",
    key_val: "",
    appr_yn: "",
    block_gbn: "",
    block_pages: "10",
    page_rows: "10000",
    curr_block: "1",
    curr_page: "1",
    base_key: "",
    sdt: start,
    edt: end,
    comp_cd: "CO000007",
    whouse_cd: "",
    invc_user: "",
    dept_cd: "",
    cust_cd: "",
    cust_nm: "",
    prod_cd: "",
    prod_nm: "",
    biz_type: "",
    biz_curr: "",
    pay_curr: "",
    pkng_gbn: "",
    ow_yn: "",
    ow_sdt: "",
    ow_edt: "",
    invc_no: "",
    curr_lang: "ENG",
  }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        "x-api-key": env.CMS_IMS_API_KEY,
        Origin: "https://cms.siliconii.com",
        Referer: "https://cms.siliconii.com/SalesProcess/INVCList",
        "User-Agent": "StyleKorean-CMS-Gateway/2026-09-01",
      },
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();
    if (!response.ok) throw new Error(`Direct CMS invoice HTTP ${response.status}`);
    if (!contentType.toLowerCase().includes("json") && !raw.trim().startsWith("{") && !raw.trim().startsWith("[")) {
      throw new Error("Direct CMS invoice endpoint did not return JSON");
    }
    const rows = extractRows(JSON.parse(raw));
    if (!rows.length) throw new Error("Direct CMS invoice endpoint returned no readable rows");
    return rows;
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeInvoiceRows(rows: Record<string, unknown>[], month: string) {
  const { start, next } = monthBounds(month);
  const groups = new Map<string, { invoiceIds: Set<string>; count: number; total: number }>();
  for (const row of rows) {
    const date = text(row.invc_dt ?? row.INVC_DT).slice(0, 10);
    if (date && (date < start || date >= next)) continue;
    const amount = Number(String(row.invc_atot ?? row.INVC_ATOT ?? "").replace(/[$,]/g, ""));
    if (!Number.isFinite(amount)) continue;
    const currency = text(row.biz_curr ?? row.BIZ_CURR ?? row.pay_curr ?? row.PAY_CURR) || "UNKNOWN";
    const invoice = text(row.invc_no ?? row.INVC_NO);
    const group = groups.get(currency) ?? { invoiceIds: new Set<string>(), count: 0, total: 0 };
    group.count += 1;
    group.total += amount;
    if (invoice) group.invoiceIds.add(invoice);
    groups.set(currency, group);
  }
  return [...groups.entries()].map(([currency, group]) => {
    const invoiceCount = group.invoiceIds.size || group.count;
    return {
      currency,
      invoiceCount,
      totalSales: Math.round(group.total * 100) / 100,
      averageInvoiceValue: invoiceCount ? Math.round((group.total / invoiceCount) * 100) / 100 : 0,
    };
  }).sort((a, b) => a.currency.localeCompare(b.currency));
}

async function discoverInvoiceSource(env: Env) {
  const rows = await runReadonlyQuery(env, `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
    FROM CSMS.INFORMATION_SCHEMA.COLUMNS
    WHERE LOWER(COLUMN_NAME) IN ('invc_dt','invc_atot','biz_curr','pay_curr','invc_no')
    ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`, 5000,
    "Discover the canonical CMS invoice table for monthly sales aggregation");
  const tables = new Map<string, { schema: string; table: string; columns: string[] }>();
  for (const row of rows) {
    const schema = text(row.TABLE_SCHEMA ?? row.table_schema);
    const table = text(row.TABLE_NAME ?? row.table_name);
    const column = text(row.COLUMN_NAME ?? row.column_name);
    if (!schema || !table || !column) continue;
    const key = `${schema}.${table}`;
    const item = tables.get(key) ?? { schema, table, columns: [] };
    item.columns.push(column);
    tables.set(key, item);
  }
  const candidates = [...tables.values()].filter((item) => {
    const lower = item.columns.map((column) => column.toLowerCase());
    return lower.includes("invc_dt") && lower.includes("invc_atot");
  }).sort((a, b) => Number(/invc|invoice|sales/i.test(b.table)) - Number(/invc|invoice|sales/i.test(a.table)));
  const source = candidates[0];
  if (!source) throw new Error("No CMS table exposes both invc_dt and invc_atot");
  return source;
}

async function fetchMcpSalesSummary(env: Env, month: string) {
  const { start, next } = monthBounds(month);
  const source = await discoverInvoiceSource(env);
  const lowerColumns = new Map(source.columns.map((column) => [column.toLowerCase(), column]));
  const dateColumn = lowerColumns.get("invc_dt")!;
  const amountColumn = lowerColumns.get("invc_atot")!;
  const currencyColumn = lowerColumns.get("biz_curr") || lowerColumns.get("pay_curr") || "";
  const invoiceColumn = lowerColumns.get("invc_no") || "";
  const invoiceCountExpr = invoiceColumn
    ? `COUNT(DISTINCT ${safeIdentifier(invoiceColumn)})`
    : "COUNT(*)";
  const currencyExpr = currencyColumn ? safeIdentifier(currencyColumn) : "''";
  const groupBy = currencyColumn ? `GROUP BY ${safeIdentifier(currencyColumn)}` : "";
  const sql = `SELECT ${currencyExpr} AS currency,
    ${invoiceCountExpr} AS invoiceCount,
    SUM(TRY_CONVERT(decimal(19,2), ${safeIdentifier(amountColumn)})) AS totalSales,
    AVG(TRY_CONVERT(decimal(19,2), ${safeIdentifier(amountColumn)})) AS averageInvoiceValue
    FROM [CSMS].${safeIdentifier(source.schema)}.${safeIdentifier(source.table)} WITH (NOLOCK)
    WHERE TRY_CONVERT(date, ${safeIdentifier(dateColumn)}) >= '${start}'
      AND TRY_CONVERT(date, ${safeIdentifier(dateColumn)}) < '${next}'
    ${groupBy}
    ORDER BY currency`;
  const rows = await runReadonlyQuery(env, sql, 100, `Aggregate CMS invoice sales for ${month}`);
  return {
    rows,
    source: { database: "CSMS", schema: source.schema, table: source.table, transport: "mcp" },
    notes: currencyColumn ? "Totals are grouped by CMS currency and are not combined across currencies." : "CMS source has no detected currency column.",
  };
}

async function handleSalesSummary(url: URL, env: Env) {
  const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
  try {
    monthBounds(month);
    let directError = "";
    if (env.CMS_IMS_API_KEY) {
      try {
        const directRows = await fetchDirectInvoiceRows(env, month);
        const rows = summarizeInvoiceRows(directRows, month);
        if (rows.length) {
          return json({
            ok: true,
            month,
            source: { endpoint: DIRECT_INVOICE_URL, transport: "direct-api" },
            rows,
            generatedAt: new Date().toISOString(),
            notes: "Totals are grouped by CMS currency and are not combined across currencies.",
          });
        }
        directError = "Direct CMS invoice data contained no numeric invoice totals for the requested month";
      } catch (error) {
        directError = error instanceof Error ? error.message : String(error);
      }
    }
    try {
      const result = await fetchMcpSalesSummary(env, month);
      return json({
        ok: true,
        month,
        ...result,
        generatedAt: new Date().toISOString(),
        fallbackFromDirect: directError || undefined,
      });
    } catch (error) {
      const mcpError = error instanceof Error ? error.message : String(error);
      return json({
        ok: false,
        error: mcpError,
        directError: directError || undefined,
        transportsTried: [env.CMS_IMS_API_KEY ? "direct-api" : null, "mcp"].filter(Boolean),
      }, 502);
    }
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "stylekorean-cms-gateway",
        mode: "read-only",
        upstreamConfigured: Boolean(env.CMS_UPSTREAM_MCP_URL),
        authForwardingConfigured: Boolean(env.CMS_MCP_AUTH_TOKEN),
        directInvoiceConfigured: Boolean(env.CMS_IMS_API_KEY),
        checkedAt: new Date().toISOString(),
      });
    }
    if (url.pathname === "/mcp") return handleMcp(request, env);
    if (url.pathname === "/sales-summary") {
      return request.method === "GET" ? handleSalesSummary(url, env) : json({ error: "Method not allowed" }, 405);
    }
    return json({ ok: false, error: "Route not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
