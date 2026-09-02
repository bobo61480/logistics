import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeKpisFromRows, selectedMonthBounds } from "../lib/kpis/compute";

const page = readFileSync("app/page.tsx", "utf8");

function row(size: number, values: Record<number, string>) {
  const output = Array.from({ length: size }, () => "");
  for (const [index, value] of Object.entries(values)) output[Number(index)] = value;
  return output;
}

describe("shared MTD month selection", () => {
  it("filters every MTD KPI to the selected month while YTD still includes later completed months through today", () => {
    const result = computeKpisFromRows({
      today: { year: 2026, month: 9, day: 15, code: 20260915 },
      selectedMonth: "2026-08",
      nationalRows: [
        ["Status", "Channel", "Dept", "PO#", "Amount", "Spacer", "Order Date"],
        ["Open", "", "National", "AUG", "1000", "", "08/10/2026"],
        ["Open", "", "National", "SEP", "2000", "", "09/10/2026"],
      ],
      wmsRows: [
        ["DATE", "B", "C", "D", "E", "F", "INVOICE AMOUNT"],
        ["08/11/2026", "", "", "", "", "", "3000"],
        ["09/11/2026", "", "", "", "", "", "4000"],
      ],
      truckingRows: [
        row(22, {}),
        row(22, {}),
        row(22, { 2: "Los Angeles, CA", 3: "08/12/2026", 4: "2 pallets", 16: "RXO", 21: "$100" }),
        row(22, { 2: "Los Angeles, CA", 3: "09/12/2026", 4: "2 pallets", 16: "RXO", 21: "$200" }),
      ],
      transferRows: [
        row(10, {}),
        row(10, { 4: "New Jersey", 5: "08/13/2026", 6: "RXO", 9: "$300" }),
        row(10, { 4: "New Jersey", 5: "09/13/2026", 6: "RXO", 9: "$400" }),
      ],
    });

    expect(result.nationalsSalesMtd).toBe(1000);
    expect(result.nationalsSalesYtd).toBe(3000);
    expect(result.wmsSalesMtd).toBe(3000);
    expect(result.wmsSalesYtd).toBe(7000);
    expect(result.shippingMtd).toBe(400);
    expect(result.shippingYtd).toBe(1000);
    expect(result.transfersMtd).toBe(300);
    expect(result.transfersYtd).toBe(700);
    expect(result.njTransferMtd).toBe(300);
    expect(result.njTransferYtd).toBe(700);
    expect(result.truckingMtd).toBe(100);
    expect(result.truckingYtd).toBe(300);
    expect(result.totalLocalMtd).toBe(100);
    expect(result.totalLocal).toBe(300);
  });

  it("rejects future and cross-year month selections", () => {
    const today = { year: 2026, month: 9, day: 15, code: 20260915 };
    expect(() => selectedMonthBounds(today, "2026-10")).toThrow("KPI_MONTH_INVALID");
    expect(() => selectedMonthBounds(today, "2025-12")).toThrow("KPI_MONTH_INVALID");
  });

  it("uses one dashboard month dropdown for all MTD cards", () => {
    expect(page).toContain("selectedMtdMonth");
    expect(page).toContain('aria-label="MTD month"');
    expect(page).toContain("/api/logistics/monthly-kpis?month=");
    expect(page).toContain("setSelectedMtdMonth");
    expect(page).toContain('period === "mtd"');
  });
});
