import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const card = readFileSync("app/ShipmentEventTrackerCard.tsx", "utf8");

describe("Tracked Shipment Updates display", () => {
  it("does not display the source sheet or imported-from location", () => {
    expect(card).not.toContain("sheetUrl(event)");
    expect(card).not.toContain("source sheet</a>");
    expect(card).not.toContain("{event.sheet}");
    expect(card).not.toContain("{event.row ?");
  });
});
