const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_QUERY_LIMIT = 10_000;

type Env = {
  CMS_UPSTREAM_MCP_URL: string;
  CMS_MCP_AUTH_TOKEN?: string;
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
  return { start, next };
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

async function handleSalesSummary(url: URL, env: Env) {
  try {
    const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
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
    return json({
      ok: true,
      month,
      source: { database: "CSMS", schema: source.schema, table: source.table },
      rows,
      generatedAt: new Date().toISOString(),
      notes: currencyColumn ? "Totals are grouped by CMS currency and are not combined across currencies." : "CMS source has no detected currency column.",
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502);
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
