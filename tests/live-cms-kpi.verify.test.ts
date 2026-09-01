import { describe, expect, it } from "vitest";

const BASE = "https://stylekorean.dpdns.org";

async function json(path: string) {
  const response = await fetch(`${BASE}${path}`, {
    headers: {
      accept: "application/json",
      "user-agent": "StyleKorean-Live-CMS-KPI-QA/1.0",
    },
  });
  const body = await response.json() as Record<string, unknown>;
  console.log(`LIVE_KPI ${path} HTTP ${response.status} ${JSON.stringify(body)}`);
  expect(response.status).toBe(200);
  expect(body.ok).toBe(true);
  return body;
}

describe("live CMS-backed KPI routes", () => {
  it("returns the known August CMS invoice total through both routes", async () => {
    const cms = await json("/api/logistics/cms-sales-kpis?month=2026-08");
    const monthly = await json("/api/logistics/monthly-kpis?month=2026-08");

    expect(cms.source).toBe("siliconii-cms-invoices");
    expect(cms.selectedMonth).toBe("2026-08");
    expect(cms.wmsSalesMtd).toBeCloseTo(22001455.27, 2);
    expect((monthly.kpis as Record<string, unknown>).wmsSalesMtd).toBeCloseTo(22001455.27, 2);
  }, 120_000);

  it("returns current September MTD and YTD from CMS plus all monthly KPI fields", async () => {
    const cms = await json("/api/logistics/cms-sales-kpis?month=2026-09");
    const monthly = await json("/api/logistics/monthly-kpis?month=2026-09");
    const kpis = monthly.kpis as Record<string, unknown>;

    expect(cms.source).toBe("siliconii-cms-invoices");
    expect(cms.selectedMonth).toBe("2026-09");
    expect(Number(cms.wmsSalesYtd)).toBeGreaterThanOrEqual(Number(cms.wmsSalesMtd));
    for (const field of [
      "shippingMtd",
      "transfersMtd",
      "njTransferMtd",
      "nationalsSalesMtd",
      "wmsSalesMtd",
      "truckingMtd",
      "totalLocalMtd",
      "totalCaliforniaMtd",
      "totalOutOfStateMtd",
    ]) {
      expect(typeof kpis[field]).toBe("number");
    }
  }, 120_000);
});
