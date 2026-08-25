import { describe, expect, it } from "vitest";
import { computeKpisFromRows } from "../lib/kpis/compute";

describe("snapshot KPI calculation", () => {
  it("includes all numeric WMS invoice amounts regardless of shipping method", () => {
    const result = computeKpisFromRows({
      nationalRows: [["STATUS", "", "", "", "AMOUNT", "", "ORDER DATE"]],
      wmsRows: [
        ["Date", "Invoice#", "Customer", "Sales", "Ship out Date", "SHIPPING METHOD", "INVOICE AMOUNT"],
        ["08/01/2026", "IN1", "A", "", "08/01/2026", "UPS", "100.25"],
        ["08/02/2026", "IN2", "B", "", "08/02/2026", "TRUCKING", "200.75"],
        ["08/03/2026", "IN3", "C", "", "08/03/2026", "TK", "300.00"],
        ["08/04/2026", "IN4", "D", "", "08/04/2026", "UPS", "FREE SAMPLE"],
      ],
      truckingRows: [["CUSTOMER", "INVOICE NO.", "ADDRESS", "SHIP DATE"]],
      transferRows: [["", "", "", "", "", ""]],
      today: { year: 2026, month: 8, day: 12, code: 20260812 },
    });

    expect(result.wmsSalesMtd).toBe(601);
    expect(result.wmsSalesYtd).toBe(601);
  });

  it("uses freight invoice first then rate fallback for trucking cost", () => {
    const row = new Array(22).fill("");
    row[2] = "Cerritos, CA";
    row[3] = "08/10/2026";
    row[4] = "2 pallets";
    row[16] = "Carrier A";
    row[17] = "$500";
    row[21] = "$450";
    const result = computeKpisFromRows({
      nationalRows: [[]],
      wmsRows: [[], []],
      truckingRows: [[], [], row],
      transferRows: [[]],
      today: { year: 2026, month: 8, day: 12, code: 20260812 },
    });
    expect(result.shippingMtd).toBe(450);
  });
});
