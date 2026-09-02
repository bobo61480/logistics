import { describe, expect, it } from "vitest";

const STYLE = "https://stylekorean.dpdns.org";
const GATEWAY = "https://stylekorean-cms-gateway.stylekorean.workers.dev";

async function probe(url: string) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "StyleKorean-Live-CMS-KPI-QA/1.0",
    },
  });
  const text = await response.text();
  console.log(`LIVE_PROBE ${url} HTTP ${response.status} ${text}`);
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch {}
  return { response, body, text };
}

describe("live CMS-backed KPI diagnostics", () => {
  it("shows direct gateway and StyleKorean August responses", async () => {
    const gatewayHealth = await probe(`${GATEWAY}/health`);
    const gatewayAugust = await probe(`${GATEWAY}/sales-summary?month=2026-08`);
    const styleAugust = await probe(`${STYLE}/api/logistics/cms-sales-kpis?month=2026-08`);

    expect(gatewayHealth.response.status).toBe(200);
    expect(gatewayAugust.response.status).toBe(200);
    expect(styleAugust.response.status).toBe(200);
  }, 120_000);

  it("shows direct gateway and StyleKorean September responses", async () => {
    const gatewaySeptember = await probe(`${GATEWAY}/sales-summary?month=2026-09`);
    const styleSeptember = await probe(`${STYLE}/api/logistics/cms-sales-kpis?month=2026-09`);
    expect(gatewaySeptember.response.status).toBe(200);
    expect(styleSeptember.response.status).toBe(200);
  }, 120_000);
});
