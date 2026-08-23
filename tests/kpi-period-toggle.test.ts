import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("app/page.tsx", "utf8");

describe("KPI Control Tower: MTD/YTD toggle and honest placeholders", () => {
  it("drives the simple KPI tiles from a single period toggle state", () => {
    expect(page).toContain('const [period, setPeriod] = useState<"mtd" | "ytd">("mtd")');
    expect(page).toContain('onClick={() => setPeriod("mtd")}');
    expect(page).toContain('onClick={() => setPeriod("ytd")}');
    expect(page).toContain('period === "mtd" ? kpis.shippingMtd : kpis.shippingYtd');
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
