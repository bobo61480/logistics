import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeKpisFromRows, NON_NATIONALS_DEPTS } from "../lib/kpis/compute";

const today = { year: 2026, month: 8, day: 29, code: 20260829 };
const emptyFreight = [[""]];

function compute(nationalRows: string[][]) {
  return computeKpisFromRows({
    nationalRows,
    wmsRows: [[""]],
    truckingRows: emptyFreight,
    transferRows: emptyFreight,
    today,
  });
}

describe("Nationals KPI schema drift", () => {
  // "Amount" (col E) is unit quantity and "Amount in $" (col F) is the dollar
  // value, so a row carries both and they legitimately differ. This fixture
  // previously paired "50k" units with "50" dollars, which is not a plausible
  // pair and encoded the pre-"Amount in $" reading of the schema.
  it("finds Order Date by header after Amount in $ and a spacer were inserted", () => {
    const result = compute([
      ["Status", "Channel", "Dept", "PO#", "Amount", "Amount in $", "", "Order Date"],
      ["Shipped", "TJX", "National", "50k", "50k", "$50,000", "", "8/11/2026"],
      ["Ready for Shipment", "ROSS", "National", "32k", "32k", "32K", "", "8/14/2026"],
    ]);
    expect(result.nationalsSalesMtd).toBe(82_000);
    expect(result.nationalsSalesYtd).toBe(82_000);
  });

  // Guards against reading unit quantities as revenue: on the current schema a
  // blank dollar cell means "no dollar value recorded yet", not "use the units
  // column". Converting 50K units into $50,000 would invent money.
  it("never falls back to the unit-quantity column when the dollar cell is blank", () => {
    const result = compute([
      ["Status", "Channel", "Dept", "PO#", "Amount", "Amount in $", "", "Order Date"],
      ["Shipped", "TJX", "National", "#1", "50K", "", "", "8/11/2026"],
    ]);
    expect(result.nationalsSalesMtd).toBe(0);
    expect(result.nationalsSalesYtd).toBe(0);
  });

  // Early-schema rows put a retailer name in Dept instead of "National".
  // They are still Nationals orders, so requiring the literal label would drop
  // real historical revenue out of the headline YTD total.
  it("counts early-schema rows whose Dept mirrors the retailer name", () => {
    const result = compute([
      ["Status", "Channel", "Dept", "PO#", "Amount", "Amount in $", "", "Order Date"],
      ["Shipped", "ROSS", "ROSS", "#1", "40K", "$40,000", "", "8/11/2026"],
      ["Shipped", "TJX", "TJX", "#2", "10K", "$10,000", "", "8/12/2026"],
      ["Shipped", "TARGET", "MBX", "#3", "99K", "$99,000", "", "8/13/2026"],
    ]);
    expect(result.nationalsSalesMtd).toBe(50_000);
  });

  // If the dollar column is renamed or dropped, the unit-quantity column must
  // not quietly stand in for it — that would report quantities as money.
  it("reports zero rather than reading units as revenue when no dollar column exists", () => {
    const result = compute([
      ["Status", "Channel", "Dept", "PO#", "Amount", "Spacer", "Order Date"],
      ["Shipped", "TJX", "National", "#1", "50K", "", "8/11/2026"],
    ]);
    expect(result.nationalsSalesMtd).toBe(0);
  });

  it("keeps compatibility with the older workbook layout", () => {
    const result = compute([
      ["Overall PO Status", "Channel", "Department", "Order#", "Total Order Amount", "PO#", "Order Date"],
      ["Shipped", "ROSS", "National", "A", "103K", "PO1", "6/3/2026"],
    ]);
    expect(result.nationalsSalesYtd).toBe(103_000);
  });

  // Dollars belong in "Amount in $"; "Amount" is unit quantity. This fixture
  // previously left the dollar column empty on every row and put dollars in
  // "Amount" (including "$347,918.62"), which only summed correctly while the
  // engine misread the units column as revenue.
  it("excludes MBX, Iherb, and cancelled rows from the Nationals card", () => {
    const result = compute([
      ["Status", "Channel", "Dept", "PO#", "Amount", "Amount in $", "", "Order Date"],
      ["Shipped", "TARGET", "MBX", "#1", "600K", "$1,200,000", "", "8/1/2026"],
      ["Shipped", "IHERB", "Iherb", "", "180K", "$347,918.62", "", "8/14/2026"],
      ["Cancelled", "ULTA-STY", "National", "#100", "60K", "$120,000", "", "8/4/2026"],
      ["Shipped", "TJX", "National", "50k", "50K", "$50,000", "", "8/11/2026"],
    ]);
    expect(result.nationalsSalesMtd).toBe(50_000);
  });
});

// The operator-facing methodology note is how someone reconciles the headline
// KPI by hand. It has drifted from the filter twice, so tie the two together:
// every department the card excludes must be named in the note.
describe("Nationals methodology note", () => {
  it("names every department the headline total excludes", () => {
    const page = readFileSync("app/page.tsx", "utf8");
    const note = page.slice(page.indexOf("Methodology notes"));
    for (const dept of NON_NATIONALS_DEPTS) {
      expect(note, `methodology note does not mention excluded dept ${dept}`).toContain(dept);
    }
  });
});
