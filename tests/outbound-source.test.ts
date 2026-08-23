import { describe, expect, it } from "vitest";
import { selectOutboundSource } from "../worker/sources";

const blankRows = (count: number) => Array.from({ length: count }, () => ["", "", "", ""]);

describe("effective outbound source selection", () => {
  it("uses the generated schedule when it contains operational rows", () => {
    const schedule = [...blankRows(3), ["Customer", "INV-1", "", "8/13/2026"]];
    const trucking = [...blankRows(2), ["Fallback", "INV-2", "", "8/14/2026"]];
    const selected = selectOutboundSource(schedule, trucking);

    expect(selected.rows).toBe(schedule);
    expect(selected.meta).toMatchObject({
      sheetName: "Outbound Shipping Schedule",
      rowCount: 1,
      fallback: false,
    });
  });

  it("uses schedule rows immediately after the sheet's single header row (regression: bug reported 2 rows too many were skipped, permanently falling back to WH Trucking Request)", () => {
    // Outbound Shipping Schedule (gid 20260708) has exactly one header row —
    // see e2e/dashboard.spec.ts's outboundCsv() fixture. A row of real data
    // sitting immediately after that single header row must be picked up.
    const schedule = [["CUSTOMER", "INVOICE NO.", "", "SHIP DATE"], ["ULTA BEAUTY", "IN12345", "", "8/13/2026"]];
    const trucking = [...blankRows(2), ["Fallback", "INV-2", "", "8/14/2026"]];
    const selected = selectOutboundSource(schedule, trucking);

    expect(selected.rows).toBe(schedule);
    expect(selected.meta).toMatchObject({
      sheetName: "Outbound Shipping Schedule",
      headerRow: 1,
      rowCount: 1,
      fallback: false,
    });
  });

  it("falls back to uncombined trucking rows when the generated schedule is empty", () => {
    const schedule = blankRows(4);
    const trucking = [...blankRows(2), ["Customer A", "INV-1", "", "8/13/2026"], ["Customer A", "INV-2", "", "8/13/2026"]];
    const selected = selectOutboundSource(schedule, trucking);

    expect(selected.rows).toBe(trucking);
    expect(selected.meta).toMatchObject({
      sheetName: "WH Trucking Request",
      rowCount: 2,
      fallback: true,
    });
  });

  it("reports zero usable rows instead of treating blank source ranges as data", () => {
    expect(selectOutboundSource(blankRows(4), blankRows(3)).meta.rowCount).toBe(0);
  });
});
