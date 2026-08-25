import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGrids = readFileSync("app/data-grids.tsx", "utf8");
const page = readFileSync("app/page.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");

describe("Data Grids tabbed section", () => {
  it("defines exactly the six tabs that have a real, distinct data source in this app", () => {
    // No separate "WH Trucking" tab: outbound freight is one bucket in this
    // app's real data model (outboundMeta decides which sheet backs it at
    // load time), not two independently-tabbable sources.
    const tabKeys = [...dataGrids.matchAll(/key:\s*"(\w+)"/g)].map((m) => m[1]);
    expect(tabKeys).toEqual(["imports", "outbound", "transfers", "nationals", "wms", "inventory"]);
  });

  it("never fabricates per-row Transfers data — the tab is an honest placeholder", () => {
    expect(dataGrids).toContain('active === "transfers"');
    expect(dataGrids).toContain("isn&apos;t exposed to the frontend today");
    expect(dataGrids).not.toMatch(/active === "transfers"[\s\S]{0,120}<ScheduleTable/);
  });

  it("reuses the existing 14-day-window-filtered visibleItems, not a fresh unfiltered read of items", () => {
    expect(page).toContain(
      'visibleItems.filter((item) => item.sourceSheet === "NATIONAL ORDER PROGRESS")',
    );
    expect(page).toContain('visibleItems.filter((item) => item.sourceSheet === "Stylekorean")');
  });

  it("mounts once in page.tsx, wired to the real schedule/inventory state", () => {
    expect(page).toContain("<DataGrids");
    expect(page).toContain("imports={importScheduleItems}");
    expect(page).toContain("outbound={outboundVisibleItems}");
    expect(page).toContain("nationals={nationalsGridItems}");
    expect(page).toContain("wms={wmsGridItems}");
  });

  it("shows the shipment identity under Reference and moves the former value to Invoice #", () => {
    expect(dataGrids).toContain("<th>Reference</th>");
    expect(dataGrids).toContain("<th>Invoice #</th>");
    expect(dataGrids).toContain('item.shipmentNo || item.title || item.reference || "—"');
    expect(dataGrids).toContain('item.invoice || item.po || item.customer || item.title || "—"');
  });

  it("scopes its dark-theme panel-heading override to .data-grids-panel, avoiding the PR-3 leak class", () => {
    expect(css).toContain('[data-theme="dark"] .data-grids-panel .panel-heading');
    expect(css).not.toMatch(/\[data-theme="dark"\]\s+\.panel-heading\s*[,{]/);
  });
});
