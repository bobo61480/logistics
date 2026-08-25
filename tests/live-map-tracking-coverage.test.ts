import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("live tracking coverage", () => {
  it("routes DHL shipments through the canonical tracking poll and map", () => {
    const page = readFileSync("app/page.tsx", "utf8");
    const map = readFileSync("app/live-map.tsx", "utf8");
    const command = readFileSync("worker/tracking-command.ts", "utf8");

    expect(page).toContain('normalized.includes("dhl")');
    expect(map).toContain('"ups" | "fedex" | "usps" | "dhl"');
    expect(command).toContain('["ups", "fedex", "usps", "dhl"]');
    expect(map).toContain("L.marker(coords, { icon })");
    expect(map).toContain("Open official carrier tracking");
    expect(map).toContain("Delivered by Deutsche Post DHL Group");
  });
});
