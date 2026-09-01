import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("app/page.tsx", "utf8");

describe("main dashboard control tower links", () => {
  it("routes Logistics Control Tower to skwarehouse and Warehouse Control Tower to skwbp", () => {
    expect(source).toContain('<div className="sys-badge-name">Logistics Control Tower</div>');
    expect(source).toContain('<div className="sys-badge-host">skwarehouse.dpdns.org</div>');
    expect(source).toContain('href="https://skwarehouse.dpdns.org"');

    expect(source).toContain('<div className="sys-badge-name">Warehouse Control Tower</div>');
    expect(source).toContain('<div className="sys-badge-host">skwbp.dpdns.org</div>');
    expect(source).toContain('href="https://skwbp.dpdns.org"');
  });
});
