import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("production source consolidation", () => {
  it("does not publish a manually curated shipment-exception snapshot beside the live Gmail/D1 feed", () => {
    const shipmentEvents = read("app/ShipmentEventTrackerCard.tsx");
    expect(shipmentEvents).not.toContain("TRACKED_EVENTS");
    expect(shipmentEvents).not.toContain("REVIEWED_THROUGH");
    expect(shipmentEvents).not.toContain("08/22/26");
    expect(shipmentEvents).toContain("return null");
  });

  it("supports DHL as a first-class server-side tracking provider everywhere the parcel map can request it", () => {
    const page = read("app/page.tsx");
    const trackingCommand = read("worker/tracking-command.ts");
    const carrierTracking = read("worker/carrier-tracking.ts");
    const liveMap = read("app/live-map.tsx");
    const workerTypes = read("worker-configuration.d.ts");

    expect(page).toContain('function trackableCarrier(value?: string): "ups" | "fedex" | "usps" | "dhl" | null');
    expect(page).toContain('if (normalized.includes("dhl")) return "dhl"');
    expect(trackingCommand).toContain('["ups", "fedex", "usps", "dhl"]');
    expect(carrierTracking).toContain('export type Carrier = "ups" | "fedex" | "usps" | "dhl"');
    expect(carrierTracking).toContain("https://api-eu.dhl.com/track/shipments");
    expect(carrierTracking).toContain('"DHL-API-Key"');
    expect(liveMap).toContain('export type Carrier = "ups" | "fedex" | "usps" | "dhl"');
    expect(workerTypes).toContain("DHL_API_KEY?: string");
  });

  it("treats UPS 200-with-warning responses as tracking errors instead of successful empty activity", () => {
    const carrierTracking = read("worker/carrier-tracking.ts");
    expect(carrierTracking).toContain("shipment?.warnings");
    expect(carrierTracking).toContain("UPS tracking warning");
  });

  it("keeps D1/Worker as the exclusive browser runtime source and never bypasses strict dual-write", () => {
    const page = read("app/page.tsx");
    expect(page).not.toContain("NEXT_PUBLIC_APPS_SCRIPT_WRITE_URL");
    expect(page).not.toContain("Worker snapshot unavailable; falling back to Google Sheets");
    expect(page).not.toContain("Direct Sheets fallback");
    expect(page).not.toContain("Sheets fallback ready");
    expect(page).not.toContain("fetch(LEGACY_WRITE_ENDPOINT");
    expect(page).toContain("D1 snapshot · canonical frontend");
  });
});
