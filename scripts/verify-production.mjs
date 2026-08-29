const base = (process.env.PRODUCTION_BASE_URL || "https://stylekorean.dpdns.org").replace(/\/$/, "");
const timeoutMs = Number(process.env.PRODUCTION_VERIFY_TIMEOUT_MS || 120000);
const requireD1 = process.env.REQUIRE_D1 !== "false";
const routes = ["/", "/light-skin", "/light", "/light-full", "/fulfillment-style"];

async function get(path, expectJson = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "StyleKorean-Production-Verifier/2026-08-29" },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body.slice(0, 300)}`);
    if (/Application error|Internal Server Error|Worker threw exception/i.test(body)) throw new Error(`${path}: deployment error marker found`);
    if (!expectJson) return body;
    try { return JSON.parse(body); }
    catch { throw new Error(`${path}: invalid JSON ${body.slice(0, 300)}`); }
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
      headers: { "user-agent": "StyleKorean-Production-Verifier/2026-08-29" },
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
if (health.frontendSource !== "d1") throw new Error(`health: frontend must be D1, received ${health.frontendSource}`);
if (health.databaseConfigured !== true || health.databaseReady !== true) throw new Error("health: production D1 binding must be configured and ready");
if (!String(health.dataStore).includes("D1")) throw new Error(`health: D1 is not reflected by ${health.dataStore}`);
if (!Number.isFinite(health.databaseAgeSeconds) || health.databaseAgeSeconds > 30 * 60) throw new Error(`health: D1 snapshot is not fresh: ${JSON.stringify(health).slice(0, 500)}`);
if (health.statusWriteMode !== "strict Google Sheets + D1 dual write") throw new Error(`health: unexpected write mode ${health.statusWriteMode}`);
if (health.deduplication !== "enabled-before-d1-publish") throw new Error(`health: dedupe is not enabled: ${health.deduplication}`);
if (requireD1 && health.frontendSource !== "d1") throw new Error("health: D1 frontend is required");

const healthHeaders = await getHeaders(`/api/logistics/health?headers=${Date.now()}`);
if (healthHeaders.get("x-content-type-options") !== "nosniff") throw new Error("health: nosniff header missing");
if (healthHeaders.get("x-frame-options") !== "DENY") throw new Error("health: frame protection header missing");

const snapshot = await get(`/api/logistics/snapshot?verify=${Date.now()}`, true);
if (snapshot.ok !== true) throw new Error(`snapshot: ${JSON.stringify(snapshot).slice(0, 500)}`);
if (snapshot.storage !== "d1" || snapshot.frontendSource !== "d1") throw new Error(`snapshot: frontend must be D1, received storage=${snapshot.storage} source=${snapshot.frontendSource}`);
if (Number.isNaN(Date.parse(snapshot.generatedAt))) throw new Error("snapshot: generatedAt is invalid");
if (!Array.isArray(snapshot.sourceHealth)) throw new Error("snapshot: sourceHealth is missing");
if (snapshot.stale === true) throw new Error("snapshot: D1 payload is stale");

const reconciliation = await get(`/api/logistics/reconciliation?verify=${Date.now()}`, true);
if (reconciliation.ok !== true || reconciliation.databaseConfigured !== true || reconciliation.ready !== true || reconciliation.frontendSource !== "d1") {
  throw new Error(`reconciliation: ${JSON.stringify(reconciliation).slice(0, 500)}`);
}

const sources = new Map(snapshot.sourceHealth.map((item) => [item.name, item]));
if (!sources.get("IMPORTS")?.ok) throw new Error("snapshot: IMPORTS source is unhealthy");
const outboundMeta = snapshot.sources?.outboundMeta;
if (!["Outbound Shipping Schedule", "WH Trucking Request"].includes(outboundMeta?.sheetName)) throw new Error("snapshot: effective outbound source metadata is missing");
if (!sources.get(outboundMeta.sheetName)?.ok) throw new Error(`snapshot: effective outbound source is unhealthy: ${outboundMeta.sheetName}`);

console.log(JSON.stringify({
  ok: true,
  base,
  routes: routes.length,
  workerVersion: health.version,
  frontendSource: health.frontendSource,
  generatedAt: snapshot.generatedAt,
  sourcesChecked: snapshot.sourceHealth.length,
  databaseConfigured: health.databaseConfigured,
}, null, 2));
