/**
 * Vitest tests for the updated sales KPI compute engine:
 * - Amount in $ column fix (col 5 vs old col 4)
 * - Retailer breakdown (TJX, Ross, Macy's, Nordstrom, iHerb, Ulta)
 * - Department breakdown (Nationals, MBX, iHerb, Wholesale B2B/B2C, Moida)
 * - 2026 YTD only
 *
 * Issue: bobo61480/logistics (sales KPI recalculation)
 */
import { describe, it, expect } from "vitest";
import { computeKpisFromRows, type KpiToday } from "../lib/kpis/compute";

// Fixed today: September 2, 2026
const TODAY: KpiToday = { year: 2026, month: 9, day: 2, code: 20260902 };

/** Build a National sheet row. Column indices:
 *  [0]=Status [1]=Channel [2]=Dept [3]=PO# [4]=Amount(units) [5]=Amount in $ [6]='' [7]=Order Date
 */
function nationalRow(
  status: string,
  channel: string,
  dept: string,
  amountUnits: string,
  amountDollars: string,
  orderDate: string,
): string[] {
  return [status, channel, dept, "PO-001", amountUnits, amountDollars, "", orderDate, "", "", "", "", "", ""];
}

const HEADER = ["Status", "Channel", "Dept", "PO#", "Amount", "Amount in $", "", "Order Date", "SSD", "CXL Date", "Pick up Date", "Routing", "Ship Via", "Remark"];

function makeRows(dataRows: string[][]): string[][] {
  return [HEADER, ...dataRows];
}

describe("Amount column fix — uses 'Amount in $' (col 5), not 'Amount' (col 4)", () => {
  it("reads dollar amount from col 5, not unit qty from col 4", () => {
    const rows = makeRows([
      nationalRow("Shipped", "ROSS", "National", "103K", "$613,881.32", "9/1/2026"),
    ]);
    const result = computeKpisFromRows({
      nationalRows: rows,
      wmsRows: [["Date", "", "", "", "", "", "Value"]],
      truckingRows: [[], []],
      transferRows: [[]],
      today: TODAY,
    });
    // Should be $613,881.32, NOT 103,000 (unit qty)
    expect(result.nationalsSalesMtd).toBeCloseTo(613_881.32, 0);
    expect(result.nationalsSalesYtd).toBeCloseTo(613_881.32, 0);
  });

  it("parses K-suffixed dollar amounts in Amount in $ column", () => {
    const rows = makeRows([
      nationalRow("Shipped", "TJX", "National", "20K", "45K", "9/2/2026"),
    ]);
    const result = computeKpisFromRows({
      nationalRows: rows,
      wmsRows: [["Date", "", "", "", "", "", "Value"]],
      truckingRows: [[], []],
      transferRows: [[]],
      today: TODAY,
    });
    expect(result.nationalsSalesMtd).toBeCloseTo(45_000, 0);
  });
});

describe("Retailer breakdown — MTD and YTD per Channel", () => {
  const rows = makeRows([
    nationalRow("Shipped", "TJX",       "National", "20K", "45000",      "9/1/2026"),
    nationalRow("Shipped", "Tjx",       "National", "5K",  "12000",      "9/2/2026"),   // variant casing
    nationalRow("Shipped", "ROSS",      "National", "103K","613881.32",  "8/15/2026"),  // MTD=Aug, YTD
    nationalRow("Shipped", "MACY`S",    "MBX",      "2K",  "8000",       "9/1/2026"),
    nationalRow("Shipped", "NORDSTROM", "MBX",      "23k", "85000",      "7/10/2026"),  // YTD only
    nationalRow("Shipped", "IHERB",     "Iherb",    "",    "613881.32",  "6/24/2026"),  // YTD only
    nationalRow("Shipped", "ULTA STY",  "Ulta",     "",    "22000",      "9/2/2026"),
    nationalRow("Cancelled","TJX",      "National", "10K", "30000",      "9/1/2026"),   // cancelled — skip
  ]);

  it("groups TJX variants together", () => {
    const r = computeKpisFromRows({
      nationalRows: rows, wmsRows: [["Date","","","","","","Value"]],
      truckingRows: [[], []], transferRows: [[]], today: TODAY,
    });
    // MTD: TJX $45,000 + Tjx $12,000 = $57,000
    expect(r.retailerSalesMtd["TJX"]).toBeCloseTo(57_000, 0);
    // YTD: same rows (both in Sep 2026)
    expect(r.retailerSalesYtd["TJX"]).toBeCloseTo(57_000, 0);
  });

  it("includes Ross in YTD but not MTD (Aug row)", () => {
    const r = computeKpisFromRows({
      nationalRows: rows, wmsRows: [["Date","","","","","","Value"]],
      truckingRows: [[], []], transferRows: [[]], today: TODAY,
    });
    // MTD = Sep 1–Sep 2 only; Ross row is Aug 15 → not MTD
    expect(r.retailerSalesMtd["Ross"] ?? 0).toBe(0);
    expect(r.retailerSalesYtd["Ross"]).toBeCloseTo(613_881.32, 0);
  });

  it("normalizes Macy's variant", () => {
    const r = computeKpisFromRows({
      nationalRows: rows, wmsRows: [["Date","","","","","","Value"]],
      truckingRows: [[], []], transferRows: [[]], today: TODAY,
    });
    expect(r.retailerSalesMtd["Macy's"]).toBeCloseTo(8_000, 0);
  });

  it("excludes cancelled rows from retailer totals", () => {
    const r = computeKpisFromRows({
      nationalRows: rows, wmsRows: [["Date","","","","","","Value"]],
      truckingRows: [[], []], transferRows: [[]], today: TODAY,
    });
    // TJX cancelled row ($30,000) must not be included
    expect(r.retailerSalesMtd["TJX"]).toBeCloseTo(57_000, 0);
  });

  it("excludes 2025 rows from YTD", () => {
    const oldRows = makeRows([
      nationalRow("Shipped", "TJX", "National", "50K", "150000", "12/31/2025"),
    ]);
    const r = computeKpisFromRows({
      nationalRows: oldRows, wmsRows: [["Date","","","","","","Value"]],
      truckingRows: [[], []], transferRows: [[]], today: TODAY,
    });
    expect(r.retailerSalesYtd["TJX"] ?? 0).toBe(0);
  });
});

describe("Department breakdown — MTD and YTD per Dept", () => {
  const rows = makeRows([
    nationalRow("Shipped", "ROSS",      "National", "103K", "613881.32", "9/1/2026"),
    nationalRow("Shipped", "MINISO",    "MBX",      "18k",  "72000",     "8/20/2026"),
    nationalRow("Shipped", "IHERB",     "Iherb",    "",     "613881.32", "9/2/2026"),
    nationalRow("Shipped", "NORDSTROM", "MBX",      "23k",  "85000",     "9/1/2026"),
    nationalRow("Shipped", "TJX",       "National", "20K",  "45000",     "7/15/2026"),
  ]);

  it("groups 'National' dept rows correctly (MTD)", () => {
    const r = computeKpisFromRows({
      nationalRows: rows, wmsRows: [["Date","","","","","","Value"]],
      truckingRows: [[], []], transferRows: [[]], today: TODAY,
    });
    // Sep 1 ROSS $613,881.32 in National dept
    expect(r.deptSalesMtd["Nationals"]).toBeCloseTo(613_881.32, 0);
  });

  it("groups 'National' dept rows correctly (YTD)", () => {
    const r = computeKpisFromRows({
      nationalRows: rows, wmsRows: [["Date","","","","","","Value"]],
      truckingRows: [[], []], transferRows: [[]], today: TODAY,
    });
    // Sep 1 ROSS + Jul 15 TJX = $613,881.32 + $45,000
    expect(r.deptSalesYtd["Nationals"]).toBeCloseTo(658_881.32, 0);
  });

  it("groups 'MBX' dept rows correctly", () => {
    const r = computeKpisFromRows({
      nationalRows: rows, wmsRows: [["Date","","","","","","Value"]],
      truckingRows: [[], []], transferRows: [[]], today: TODAY,
    });
    // MTD: Nordstrom MBX $85,000 (Sep 1)
    expect(r.deptSalesMtd["MBX"]).toBeCloseTo(85_000, 0);
    // YTD: Miniso MBX $72,000 (Aug) + Nordstrom MBX $85,000 (Sep)
    expect(r.deptSalesYtd["MBX"]).toBeCloseTo(157_000, 0);
  });

  it("groups 'iHerb' dept rows correctly", () => {
    const r = computeKpisFromRows({
      nationalRows: rows, wmsRows: [["Date","","","","","","Value"]],
      truckingRows: [[], []], transferRows: [[]], today: TODAY,
    });
    expect(r.deptSalesMtd["iHerb"]).toBeCloseTo(613_881.32, 0);
    expect(r.deptSalesYtd["iHerb"]).toBeCloseTo(613_881.32, 0);
  });
});

describe("MTD boundary — only selected month rows count", () => {
  it("MTD uses the selected month (default = current month)", () => {
    const rows = makeRows([
      nationalRow("Shipped", "TJX", "National", "", "10000", "9/1/2026"),  // Sep — MTD
      nationalRow("Shipped", "TJX", "National", "", "20000", "8/31/2026"), // Aug — YTD only
    ]);
    const r = computeKpisFromRows({
      nationalRows: rows, wmsRows: [["Date","","","","","","Value"]],
      truckingRows: [[], []], transferRows: [[]], today: TODAY,
    });
    expect(r.retailerSalesMtd["TJX"]).toBeCloseTo(10_000, 0);
    expect(r.retailerSalesYtd["TJX"]).toBeCloseTo(30_000, 0);
  });

  it("selecting a past month (Aug) limits MTD to Aug 1–31", () => {
    const rows = makeRows([
      nationalRow("Shipped", "TJX", "National", "", "10000", "9/1/2026"),   // Sep — not in Aug MTD
      nationalRow("Shipped", "TJX", "National", "", "20000", "8/15/2026"),  // Aug — in MTD
    ]);
    const r = computeKpisFromRows({
      nationalRows: rows, wmsRows: [["Date","","","","","","Value"]],
      truckingRows: [[], []], transferRows: [[]], today: TODAY,
      selectedMonth: "2026-08",
    });
    expect(r.retailerSalesMtd["TJX"]).toBeCloseTo(20_000, 0);
    expect(r.retailerSalesYtd["TJX"]).toBeCloseTo(30_000, 0);
  });
});
