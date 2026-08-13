const base = (process.env.PRODUCTION_BASE_URL || "https://stylekorean.dpdns.org").replace(/\/$/, "");
const timeoutMs = Number(process.env.PRODUCTION_VERIFY_TIMEOUT_MS || 60000);
const requireD1 = process.env.REQUIRE_D1 === "true";
const routes = ["/", "/light-skin", "/light", "/light-full", "/fulfillment-style"];

async function get(path, expectJson = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "StyleKorean-Production-Verifier/2026-08-12" },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body.slice(0, 300)}`);
    if (/Application error|Internal Server Error|Worker threw exception/i.test(body)) {
      throw new Error(`${path}: deployment error marker found`);
    }
    if (!expectJson) return body;
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`${path}: invalid JSON ${body.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function getHeaders(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "StyleKorean-Production-Verifier/2026-08-12" },
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    await response.body?.cancel();
    return response.headers;
  } finally {
    clearTimeout(timer);
  }
}

for (const route of routes) {
  const html = await get(`${route}?verify=${Date.now()}`);
  if (!/StyleKorean/i.test(html)) throw new Error(`${route}: StyleKorean application marker missing`);
}

const health = await get(`/api/logistics/health?verify=${Date.now()}`, true);
if (health.ok !== true) throw new Error(`health: ${JSON.stringify(health).slice(0, 500)}`);
if (health.accessPolicy !== "public") throw new Error(`health: unexpected access policy ${health.accessPolicy}`);
if (health.statusWriteAuthentication !== "none") {
  throw new Error(`health: unexpected status-write authentication ${health.statusWriteAuthentication}`);
}
if (!String(health.statusWriteRateLimit).includes("30 requests per 60 seconds")) {
  throw new Error(`health: status-write rate limit is not reported: ${health.statusWriteRateLimit}`);
}
if (requireD1 && health.databaseConfigured !== true) throw new Error("health: production D1 binding is required but missing");
if (health.databaseConfigured && !String(health.dataStore).includes("D1")) {
  throw new Error(`health: D1 is not reflected by ${health.dataStore}`);
}
const healthHeaders = await getHeaders(`/api/logistics/health?headers=${Date.now()}`);
if (healthHeaders.get("x-content-type-options") !== "nosniff") throw new Error("health: nosniff header missing");
if (healthHeaders.get("x-frame-options") !== "DENY") throw new Error("health: frame protection header missing");

const snapshot = await get(`/api/logistics/snapshot?verify=${Date.now()}`, true);
if (snapshot.ok !== true) throw new Error(`snapshot: ${JSON.stringify(snapshot).slice(0, 500)}`);
if (Number.isNaN(Date.parse(snapshot.generatedAt))) throw new Error("snapshot: generatedAt is invalid");
if (!Array.isArray(snapshot.sourceHealth)) throw new Error("snapshot: sourceHealth is missing");

const reconciliation = await get(`/api/logistics/reconciliation?verify=${Date.now()}`, true);
if (reconciliation.ok !== true || reconciliation.databaseConfigured !== health.databaseConfigured) {
  throw new Error(`reconciliation: ${JSON.stringify(reconciliation).slice(0, 500)}`);
}
if (health.databaseConfigured) {
  if (reconciliation.ready !== true) throw new Error("reconciliation: D1 is not ready");
  if (snapshot.storage !== "d1") throw new Error(`snapshot: expected D1 storage, received ${snapshot.storage}`);
} else {
  if (reconciliation.ready !== false || reconciliation.activationRequired !== true) {
    throw new Error(`reconciliation: unbound D1 state is not explicit: ${JSON.stringify(reconciliation).slice(0, 500)}`);
  }
  if (snapshot.storage !== "sheets") throw new Error(`snapshot: expected Sheets fallback, received ${snapshot.storage}`);
}

const sources = new Map(snapshot.sourceHealth.map((item) => [item.name, item]));
if (!sources.get("IMPORTS")?.ok) throw new Error("snapshot: IMPORTS source is unhealthy");
const outboundMeta = snapshot.sources?.outboundMeta;
if (!["Outbound Shipping Schedule", "WH Trucking Request"].includes(outboundMeta?.sheetName)) {
  throw new Error("snapshot: effective outbound source metadata is missing");
}
if (!sources.get(outboundMeta.sheetName)?.ok) {
  throw new Error(`snapshot: effective outbound source is unhealthy: ${outboundMeta.sheetName}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      base,
      routes: routes.length,
      workerVersion: health.version,
      generatedAt: snapshot.generatedAt,
      sourcesChecked: snapshot.sourceHealth.length,
      databaseConfigured: health.databaseConfigured,
    },
    null,
    2,
  ),
);
