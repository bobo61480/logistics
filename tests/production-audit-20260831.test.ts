import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

function appSources(dir = "app"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return appSources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("2026-08-31 production audit regressions", () => {
  // Scans the whole app tree rather than the single retired component file, so
  // the guarantee survives that file being deleted and also catches the
  // snapshot being reintroduced anywhere else. Tracked Shipment Updates now
  // renders from the live gmailIngestion feed instead — see
  // app/tracked-shipment-updates-card.tsx.
  it("does not ship the hand-curated August 22 shipment exception snapshot", () => {
    for (const path of appSources()) {
      const source = read(path);
      for (const staleMarker of [
        "REVIEWED_THROUGH",
        "TRACKED_EVENTS",
        "HJ80 · SMCU1040159",
        "XPO 755-384346",
        "reviewed through 08/22/26",
      ]) {
        expect(source, `${path} contains ${staleMarker}`).not.toContain(staleMarker);
      }
    }
  });

  it("keeps the Tracked Shipment Updates panel derived from the live D1 feed", () => {
    const card = read("app/tracked-shipment-updates-card.tsx");
    const page = read("app/page.tsx");
    expect(page).toContain("<TrackedShipmentUpdatesCard");
    expect(page).toContain("events={gmailIngestion}");
    // Every row's sheet + row number is resolved against live schedule items,
    // never a checked-in mapping.
    expect(card).toContain("buildRowIndex");
    expect(card).not.toMatch(/row(Index)?\s*[:=]\s*\d{2,}/);
  });

  it("does not keep orphan nested repository pointers in the canonical app", () => {
    expect(existsSync("skwarehouse")).toBe(false);
    expect(existsSync("stylekorean")).toBe(false);
  });

  it("keeps D1 as the browser's only operational data authority", () => {
    const page = read("app/page.tsx");
    expect(page).toContain('console.error("D1 operational snapshot unavailable."');
    expect(page).not.toContain("falling back to Google Sheets");
    expect(page).not.toContain('mode: "sheets" as const');
    expect(page).not.toContain('storage: "sheets" as const');
  });

  it("supports DHL Unified tracking server-side and in the browser queue without exposing its API key", () => {
    const command = read("worker/tracking-command.ts");
    const tracking = read("worker/carrier-tracking.ts");
    const liveMap = read("app/live-map.tsx");
    const page = read("app/page.tsx");
    const env = read("worker-configuration.d.ts");

    expect(command).toContain('"dhl"');
    expect(tracking).toContain('"dhl"');
    expect(tracking).toContain("DHL-API-Key");
    expect(tracking).toContain("api-eu.dhl.com/track/shipments");
    expect(liveMap).toContain('"dhl"');
    expect(page).toContain('normalized.includes("dhl")');
    expect(env).toContain("DHL_API_KEY?: string");
  });

  it("treats UPS warning responses as explicit tracking errors", () => {
    const tracking = read("worker/carrier-tracking.ts");
    expect(tracking).toContain("shipment?.warnings");
    expect(tracking).toContain("Tracking Information Not Found");
  });
});
