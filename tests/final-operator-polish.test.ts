import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("final operator polish", () => {
  it("shows production API, write proxy, and the actual data store globally", () => {
    const layout = read("app/layout.tsx");
    const health = read("app/production-health.tsx");

    expect(layout).toContain("ProductionHealth");
    expect(layout).toContain("<ProductionHealth />");
    expect(health).toContain("/api/logistics/health");
    expect(health).toContain("API");
    expect(health).toContain("WRITE PROXY");
    expect(health).toContain("DATA");
    expect(health).toContain("dataStore");
    expect(health).toContain("databaseReady");
    expect(health).toContain("databaseState");
  });

  it("does not describe freight spend as carrier earnings or local heuristics as exact miles", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("Freight Spend");
    expect(page).not.toContain("<small>Earnings</small>");
    expect(page).not.toContain("LOCAL ≤50 MI");
    expect(page).not.toContain("Carrier earnings use");
    expect(page).toContain("LOCAL / REGIONAL HEURISTIC");
  });

  it("matches the desktop grids to the number of rendered controls and metrics", () => {
    const css = read("app/globals.css");
    expect(css).toContain(".source-buttons { display: grid; grid-template-columns: repeat(3, 1fr); }");
    expect(css).toMatch(/\.metrics \{[\s\S]*?grid-template-columns: repeat\(4, 1fr\);/);
  });

  it("keeps fulfillment polling stable and releases request timers", () => {
    const fulfillment = read("app/FulfillmentTkOrders.tsx");
    expect(fulfillment).toContain("const jobsRef = useRef<OverviewJob[]>([])");
    expect(fulfillment).toContain("jobsRef.current = nextJobs");
    expect(fulfillment).not.toContain("}, [jobs.length]);");
    expect(fulfillment.match(/finally \{\s*window\.clearTimeout\(timer\);\s*\}/g)).toHaveLength(2);
  });
});
