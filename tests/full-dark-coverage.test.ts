import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("app/globals.css", "utf8");
const shipmentEventCard = readFileSync("app/ShipmentEventTrackerCard.tsx", "utf8");
const styleVariants = readFileSync("app/style-variants.module.css", "utf8");
const fulfillmentTkCss = readFileSync("app/fulfillment-tk-orders.module.css", "utf8");

describe("PR-8 dark-theme full coverage pass", () => {
  it("covers the metrics strip, control panel, search, and source legend, still-light after PRs 1-7", () => {
    expect(css).toContain('[data-theme="dark"] .metrics article');
    expect(css).toContain('[data-theme="dark"] .control-panel');
    expect(css).toContain('[data-theme="dark"] .search');
    expect(css).toContain('[data-theme="dark"] .source-legend');
  });

  it("covers the inventory panels and their tables/toolbars", () => {
    expect(css).toContain('[data-theme="dark"] .inventory-panel');
    expect(css).toContain('[data-theme="dark"] .inventory-table th');
    expect(css).toContain('[data-theme="dark"] .inventory-table td');
    expect(css).toContain('[data-theme="dark"] .inventory-toolbar input');
  });

  it("covers the import schedules panel and its table", () => {
    expect(css).toContain('[data-theme="dark"] .import-schedules');
    expect(css).toContain('[data-theme="dark"] .import-table th');
    expect(css).toContain('[data-theme="dark"] .import-table td');
  });

  it("gives ShipmentEventTrackerCard its own inline dark overrides, since it doesn't use globals.css", () => {
    expect(shipmentEventCard).toContain('[data-theme="dark"] .shipment-event-card');
    expect(shipmentEventCard).toContain('[data-theme="dark"] .shipment-event-list');
    expect(shipmentEventCard).toContain('[data-theme="dark"] .shipment-event-expired');
  });

  it("themes the site-wide platform switcher nav, which layout.tsx mounts on every route", () => {
    expect(styleVariants).toContain(':global([data-theme="dark"]) .variantNav');
    expect(styleVariants).toContain(':global([data-theme="dark"]) .variantNavCurrent');
  });

  it("deliberately leaves FulfillmentTkOrders untouched: it already renders permanently dark and never participates in the toggle", () => {
    expect(fulfillmentTkCss).not.toContain("data-theme");
  });
});
