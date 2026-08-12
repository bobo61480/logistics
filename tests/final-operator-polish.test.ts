import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("final operator polish", () => {
  it("shows production API, write proxy, and optional database health globally", () => {
    const layout = read("app/layout.tsx");
    const health = read("app/production-health.tsx");

    expect(layout).toContain("ProductionHealth");
    expect(layout).toContain("<ProductionHealth />");
    expect(health).toContain("/api/logistics/health");
    expect(health).toContain("API");
    expect(health).toContain("WRITE PROXY");
    expect(health).toContain("DATABASE");
    expect(health).toContain("OPTIONAL / UNBOUND");
  });

  it("does not describe freight spend as carrier earnings or local heuristics as exact miles", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("Freight Spend");
    expect(page).not.toContain("<small>Earnings</small>");
    expect(page).not.toContain("LOCAL ≤50 MI");
    expect(page).not.toContain("Carrier earnings use");
    expect(page).toContain("LOCAL / REGIONAL HEURISTIC");
  });
});
