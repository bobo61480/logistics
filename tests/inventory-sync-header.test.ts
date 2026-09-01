import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Helpers = {
  findHeaderRowIdx_: (rows: unknown[][]) => number;
};

function loadHelpers(): Helpers {
  const source = readFileSync("google-apps-script/InventorySync.gs", "utf8");
  const context = vm.createContext({ console, Date, Map, Set });
  vm.runInContext(
    `${source}\n;globalThis.__helpers = { findHeaderRowIdx_ };`,
    context,
  );
  return (context as typeof context & { __helpers: Helpers }).__helpers;
}

describe("inventory sync IMPORTS header detection", () => {
  const { findHeaderRowIdx_ } = loadHelpers();

  it("finds the primary header after title and blank rows", () => {
    const rows = [
      ["IMPORT SCHEDULE 2026"],
      [],
      ["SCHEDULING"],
      ["Shipment", "MBL", "ETA", "Website Status"],
      ["TW 12", "ONEY123", "09/05/2026", "Shipping"],
    ];

    expect(findHeaderRowIdx_(rows)).toBe(3);
  });

  it("rejects an ETA-only section row", () => {
    const rows = [
      ["IMPORTS"],
      ["ETA"],
      ["PARCELS"],
      ["UPS", "Tracking #"],
    ];

    expect(findHeaderRowIdx_(rows)).toBe(-1);
  });

  it("chooses the strongest valid header candidate", () => {
    const rows = [
      ["Shipment", "ETA"],
      ["Shipment", "Invoice", "MBL", "Container", "ETA", "Status"],
    ];

    expect(findHeaderRowIdx_(rows)).toBe(1);
  });

  it("matches normalized header casing and whitespace", () => {
    const rows = [[" shipment no. ", " eta ", " shipment status "]];

    expect(findHeaderRowIdx_(rows)).toBe(0);
  });
});
