import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("app/page.tsx", "utf8");
const sources = readFileSync("worker/sources.ts", "utf8");
const statuses = readFileSync("lib/domain/status.ts", "utf8");

describe("schedule status dropdown write-back", () => {
  it("enables every schedule source and retains exact source-row writes", () => {
    expect(page).toMatch(/sourceSheet: "NATIONAL ORDER PROGRESS"[\s\S]*?editable: true/);
    expect(page).toMatch(/sourceSheet: "Stylekorean"[\s\S]*?editable: true/);
    expect(page).toContain("editable: statusSource.editable");
    expect(page).toContain("sourceSheet: statusSource.sourceSheet");
    expect(page).toContain("sourceRow: statusSource.sourceRow");
  });

  it("reads the dedicated WMS WEBSITE STATUS column included in snapshots", () => {
    expect(page).toContain("const websiteStatus = cell(row, 32)");
    expect(sources).toContain('range: "A2:AG4200"');
  });

  it("offers the canonical pickup and in-transit statuses", () => {
    expect(page).toMatch(/const INBOUND_STATUS_OPTIONS[^=]*= LOGISTICS_STATUS_OPTIONS/);
    expect(statuses).toContain('"Schedule Requested"');
    expect(statuses).toContain('"Picked Up/Shipped"');
    expect(statuses).toContain('"In Transit/Stopover"');
  });
});
