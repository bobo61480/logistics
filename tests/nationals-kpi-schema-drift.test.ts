import { describe, expect, it } from "vitest";
import { computeKpisFromRows } from "../lib/kpis/compute";

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
  it("finds Order Date by header after Amount in $ and a spacer were inserted", () => {
    const result = compute([
      ["Status", "Channel", "Dept", "PO#", "Amount", "Amount in $", "", "Order Date"],
      ["Shipped", "TJX", "National", "50k", "50k", "50", "", "8/11/2026"],
      ["Ready for Shipment", "ROSS", "National", "32k", "32k", "32", "", "8/14/2026"],
    ]);
    expect(result.nationalsSalesMtd).toBe(82_000);
    expect(result.nationalsSalesYtd).toBe(82_000);
  });

  it("keeps compatibility with the older workbook layout", () => {
    const result = compute([
      ["Overall PO Status", "Channel", "Department", "Order#", "Total Order Amount", "PO#", "Order Date"],
      ["Shipped", "ROSS", "National", "A", "103K", "PO1", "6/3/2026"],
    ]);
    expect(result.nationalsSalesYtd).toBe(103_000);
  });

  it("excludes MBX, Iherb, and cancelled rows from the Nationals card", () => {
    const result = compute([
      ["Status", "Channel", "Dept", "PO#", "Amount", "Amount in $", "", "Order Date"],
      ["Shipped", "TARGET", "MBX", "#1", "600K", "", "", "8/1/2026"],
      ["Shipped", "IHERB", "Iherb", "", "$347,918.62", "", "", "8/14/2026"],
      ["Cancelled", "ULTA-STY", "National", "#100", "60K", "", "", "8/4/2026"],
      ["Shipped", "TJX", "National", "50k", "50k", "", "", "8/11/2026"],
    ]);
    expect(result.nationalsSalesMtd).toBe(50_000);
  });
});
