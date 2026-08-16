import { describe, expect, it } from "vitest";
import { normalizeImportsParcelRows } from "../worker/sources";

describe("Worker IMPORTS parcel normalization", () => {
  it("promotes a strong UPS tracking number from column C over an ambiguous number in B", () => {
    const rows = [
      ["SHIPMENT", "DOCS", "INVOICE", "DEPARTMENT", "ETA"],
      ["PARCELS"],
      ["UPS", "TRACKING#", "INVOICE#", "DEPARTMENT", "ESTIMATED ARRIVAL"],
      ["", "4035336068715417909", "1ZR08J349024359054", "WHOLESALE", "08/14/2026", "", "", "", "", "", ""],
    ];

    const normalized = normalizeImportsParcelRows(rows);
    expect(normalized[3][1]).toBe("1ZR08J349024359054");
    expect(normalized[3][2]).toBe("");
  });

  it("preserves a real invoice when tracking is already in B", () => {
    const rows = [
      ["SHIPMENT", "DOCS", "INVOICE", "DEPARTMENT", "ETA"],
      ["PARCELS"],
      ["UPS", "TRACKING#", "INVOICE#", "DEPARTMENT", "ESTIMATED ARRIVAL"],
      ["", "1ZR08J349024359054", "IN00464263", "WHOLESALE", "08/14/2026"],
    ];

    const normalized = normalizeImportsParcelRows(rows);
    expect(normalized[3][1]).toBe("1ZR08J349024359054");
    expect(normalized[3][2]).toBe("IN00464263");
  });

  it("does not relabel ambiguous numeric tracking when no strong candidate exists", () => {
    const rows = [
      ["SHIPMENT", "DOCS", "INVOICE", "DEPARTMENT", "ETA"],
      ["PARCELS"],
      ["FEDEX", "TRACKING#", "INVOICE#", "DEPARTMENT", "ESTIMATED ARRIVAL"],
      ["", "4035336068715417909", "IN00464263", "WHOLESALE", "08/14/2026"],
    ];

    const normalized = normalizeImportsParcelRows(rows);
    expect(normalized[3][1]).toBe("4035336068715417909");
    expect(normalized[3][2]).toBe("IN00464263");
  });
});
