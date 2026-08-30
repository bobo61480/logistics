const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CMS_TIMEOUT_MS = 25_000;

export type CmsGatewayEnv = {
  CMS_MCP_URL?: string;
  CMS_MCP_AUTH_TOKEN?: string;
};

function parseRpc(raw: string) {
  const trimmed = raw.trim();
  const payload = trimmed.startsWith("{")
    ? trimmed
    : trimmed.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
  if (!payload) throw new Error("CMS gateway returned an unreadable response");
  return JSON.parse(payload) as {
    error?: unknown;
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
}

export async function runCmsReadonlyQuery(env: CmsGatewayEnv, sql: string, limit: number, prompt: string) {
  if (!env.CMS_MCP_URL) throw new Error("CMS gateway is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CMS_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (env.CMS_MCP_AUTH_TOKEN) headers.Authorization = `Bearer ${env.CMS_MCP_AUTH_TOKEN}`;
    const response = await fetch(new URL(env.CMS_MCP_URL).toString(), {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: "run_readonly_query", arguments: { sql, limit, prompt } },
      }),
    });
    if (!response.ok) throw new Error(`CMS gateway HTTP ${response.status}`);
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) throw new Error("CMS response exceeded its byte limit");
    const rpc = parseRpc(raw);
    if (rpc.error || rpc.result?.isError) throw new Error("CMS gateway rejected the read-only query");
    const content = rpc.result?.content?.map((item) => item.text ?? "").join("") ?? "";
    const parsed = JSON.parse(content) as { error?: unknown; rows?: unknown[] };
    if (parsed.error || !Array.isArray(parsed.rows)) throw new Error("CMS gateway returned invalid query data");
    return parsed.rows as Record<string, unknown>[];
  } finally {
    clearTimeout(timeout);
  }
}
