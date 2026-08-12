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

for (const route of routes) {
  const html = await get(`${route}?verify=${Date.now()}`);
  if (!/StyleKorean/i.test(html)) throw new Error(`${route}: StyleKorean application marker missing`);
}

const health = await get(`/api/logistics/health?verify=${Date.now()}`, true);
if (health.ok !== true) throw new Error(`health: ${JSON.stringify(health).slice(0, 500)}`);

const snapshot = await get(`/api/logistics/snapshot?verify=${Date.now()}`, true);
if (snapshot.ok !== true) throw new Error(`snapshot: ${JSON.stringify(snapshot).slice(0, 500)}`);
if (Number.isNaN(Date.parse(snapshot.generatedAt))) throw new Error("snapshot: generatedAt is invalid");
if (!Array.isArray(snapshot.sourceHealth)) throw new Error("snapshot: sourceHealth is missing");

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
    },
    null,
    2,
  ),
);
