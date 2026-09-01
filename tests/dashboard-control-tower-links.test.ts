import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("app/page.tsx", "utf8");
const layout = readFileSync("app/layout.tsx", "utf8");
const remap = readFileSync("app/dashboard-control-tower-links.tsx", "utf8");

describe("main dashboard control tower links", () => {
  it("keeps both dashboard badges identifiable", () => {
    expect(page).toContain('<div className="sys-badge-name">Logistics Control Tower</div>');
    expect(page).toContain('<div className="sys-badge-name">Warehouse Control Tower</div>');
  });

  it("remaps Logistics to skwarehouse and Warehouse to skwbp after hydration", () => {
    expect(layout).toContain('import { DashboardControlTowerLinks } from "./dashboard-control-tower-links";');
    expect(layout).toContain("<DashboardControlTowerLinks />");
    expect(remap).toContain('const LOGISTICS_HOST = "skwarehouse.dpdns.org";');
    expect(remap).toContain('const WAREHOUSE_HOST = "skwbp.dpdns.org";');
    expect(remap).toContain('anchor.href = `https://${WAREHOUSE_HOST}`;');
    expect(remap).toContain('name.textContent === "Logistics Control Tower"');
    expect(remap).toContain('name.textContent === "Warehouse Control Tower"');
  });
});
