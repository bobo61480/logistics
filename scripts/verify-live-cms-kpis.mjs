const style = (process.env.PRODUCTION_BASE_URL || "https://stylekorean.dpdns.org").replace(/\/$/, "");
const gateway = (process.env.CMS_GATEWAY_BASE_URL || "https://stylekorean-cms-gateway.stylekorean.workers.dev").replace(/\/$/, "");
const timeoutMs = Number(process.env.LIVE_CMS_KPI_VERIFY_TIMEOUT_MS || 120000);

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        "user-agent": "StyleKorean-Live-CMS-KPI-QA/1.0",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    console.log(`LIVE_PROBE ${url} HTTP ${response.status} ${text}`);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${url}: invalid JSON ${text.slice(0, 300)}`);
    }
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${text.slice(0, 300)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

for (const month of ["2026-08", "2026-09"]) {
  await probe(`${gateway}/sales-summary?month=${month}`);
  await probe(`${style}/api/logistics/cms-sales-kpis?month=${month}`);
}

await probe(`${gateway}/health`);
