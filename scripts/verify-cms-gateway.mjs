import { pathToFileURL } from "node:url";

export function currentPacificMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit",
  }).formatToParts(now);
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}`;
}

export async function verifyCmsGateway({
  gatewayUrl,
  month = currentPacificMonth(),
  fetchImpl = fetch,
  timeoutMs = 60_000,
}) {
  const base = new URL(gatewayUrl);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid verification month");

  async function read(path) {
    const response = await fetchImpl(new URL(path, base), {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Never print response bodies: upstream errors may contain sensitive data.
    if (response.status !== 200) throw new Error(`${path.split("?")[0]}: HTTP ${response.status}`);
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error(`${path.split("?")[0]}: invalid JSON`); }
    if (payload?.ok !== true) throw new Error(`${path.split("?")[0]}: ok must be true`);
    return payload;
  }

  const health = await read("/health");
  const sales = await read(`/sales-summary?month=${month}`);
  if (sales.month !== month) throw new Error("CMS sales response month does not match the request");
  if (!Array.isArray(sales.rows)) throw new Error("CMS sales response has no aggregate rows");
  for (const row of sales.rows) {
    if (!row || typeof row.totalSales !== "number" || !Number.isFinite(row.totalSales)
      || !Number.isInteger(row.invoiceCount) || row.invoiceCount < 0) {
      throw new Error("CMS sales response has invalid aggregate values");
    }
  }
  return {
    ok: true,
    month,
    aggregateCount: sales.rows.length,
    invoiceCount: sales.rows.reduce((count, row) => count + row.invoiceCount, 0),
    unattendedAuthConfigured: health.unattendedAuthConfigured === true,
    bootstrapSessionConfigured: health.bootstrapSessionConfigured === true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyCmsGateway({
      gatewayUrl: process.env.CMS_GATEWAY_BASE_URL || "https://stylekorean-cms-gateway.stylekorean.workers.dev",
      month: process.env.CMS_VERIFY_MONTH || currentPacificMonth(),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`CMS gateway verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
