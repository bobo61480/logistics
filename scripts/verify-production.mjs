const base = (process.env.PRODUCTION_BASE_URL || "https://stylekorean.dpdns.org").replace(/\/$/, "");
const timeoutMs = Number(process.env.PRODUCTION_VERIFY_TIMEOUT_MS || 60000);
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
if (typeof health.databaseConfigured !== "boolean") throw new Error("health: databaseConfigured is missing");
if (health.databaseConfigured && !String(health.dataStore).includes("D1")) {
  throw new Error(`health: configured D1 is not reflected by data store ${health.dataStore}`);
}
if (!health.databaseConfigured && health.dataStore !== "Google Sheets") {
  throw new Error(`health: unexpected fallback data store ${health.dataStore}`);
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
if (health.databaseConfigured && reconciliation.ready !== true) throw new Error("reconciliation: D1 is not ready");

const sources = new Map(snapshot.sourceHealth.map((item) => [item.name, item]));
for (const name of ["IMPORTS", "Outbound Shipping Schedule"]) {
  if (!sources.get(name)?.ok) throw new Error(`snapshot: core source unhealthy: ${name}`);
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
