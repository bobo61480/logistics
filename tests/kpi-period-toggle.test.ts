import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("app/page.tsx", "utf8");

describe("KPI Control Tower: combined periods and Summary/Details", () => {
  it("shows MTD and YTD together in every primary KPI tile", () => {
    expect(page).toContain("function KpiPeriodValues");
    expect(page).toContain('<div><small>MTD</small><strong>{format(mtd)}</strong></div>');
    expect(page).toContain('<div><small>YTD</small><strong>{format(ytd)}</strong></div>');
    expect(page).toContain('<KpiPeriodValues mtd={kpis.shippingMtd} ytd={kpis.shippingYtd} />');
    expect(page).not.toContain('period === "mtd" ? kpis.shippingMtd : kpis.shippingYtd');
  });

  it("uses Summary/Details to reveal supporting KPI breakdowns", () => {
    expect(page).toContain('const [kpiView, setKpiView] = useState<"summary" | "details">("summary")');
    expect(page).toContain('onClick={() => setKpiView("summary")}');
    expect(page).toContain('onClick={() => setKpiView("details")}');
    expect(page).toContain('kpiView === "details" && <article className="kpi-card kpi-carrier">');
  });

  it("labels the carrier and truckload-mix cards as YTD-only, since computeLiveKpis has no MTD variant for them", () => {
    expect(page).toContain("TOP 3 CARRIERS · YTD (always YTD)");
    expect(page).toContain("TRUCKLOAD MIX · YTD (always YTD)");
  });

  it("renders Net Margin as an honest placeholder, never a fabricated figure", () => {
    expect(page).toContain("NET MARGIN");
    expect(page).toContain("No cost/margin data source yet");
    expect(page).not.toMatch(/NET MARGIN[\s\S]{0,80}moneyWithCents/);
  });

  it("labels the Warehouse Control Tower badge as an external, non-live link rather than faking status", () => {
    expect(page).toContain("Warehouse Control Tower");
    expect(page).toContain("External system · no live data here");
    expect(page).toContain('href="https://skwarehouse.dpdns.org"');
  });
});
