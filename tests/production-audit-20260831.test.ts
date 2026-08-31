import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("2026-08-31 production audit regressions", () => {
  it("does not ship the hand-curated August 22 shipment exception snapshot", () => {
    const tracker = read("app/ShipmentEventTrackerCard.tsx");
    for (const staleMarker of [
      "REVIEWED_THROUGH",
      "TRACKED_EVENTS",
      "HJ80 · SMCU1040159",
      "XPO 755-384346",
      "reviewed through 08/22/26",
    ]) {
      expect(tracker).not.toContain(staleMarker);
    }
  });

  it("does not keep orphan nested repository pointers in the canonical app", () => {
    expect(existsSync("skwarehouse")).toBe(false);
    expect(existsSync("stylekorean")).toBe(false);
  });

  it("supports DHL Unified tracking server-side without exposing its API key", () => {
    const command = read("worker/tracking-command.ts");
    const tracking = read("worker/carrier-tracking.ts");
    const env = read("worker-configuration.d.ts");

    expect(command).toContain('"dhl"');
    expect(tracking).toContain('"dhl"');
    expect(tracking).toContain("DHL-API-Key");
    expect(tracking).toContain("api-eu.dhl.com/track/shipments");
    expect(env).toContain("DHL_API_KEY?: string");
  });

  it("treats UPS warning responses as explicit tracking errors", () => {
    const tracking = read("worker/carrier-tracking.ts");
    expect(tracking).toContain("shipment?.warnings");
    expect(tracking).toContain("Tracking Information Not Found");
  });
});
