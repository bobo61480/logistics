import { describe, expect, it } from "vitest";
import { computeInventoryAlerts, dashboardAlertInputs, type InventoryItem } from "../app/page";

function item(partial: Partial<InventoryItem> & { quantity: number }): InventoryItem {
  return {
    id: partial.id ?? `${partial.sku ?? partial.upc ?? partial.productName ?? "x"}-${partial.quantity}`,
    shipmentNo: partial.shipmentNo ?? "",
    productName: partial.productName ?? "",
    sku: partial.sku ?? "",
    upc: partial.upc ?? "",
    expirationDate: partial.expirationDate ?? "",
    palletNumber: partial.palletNumber,
    quantity: partial.quantity,
    location: partial.location ?? "",
    status: partial.status ?? "",
  };
}

// Builds a gviz-shaped table: { cols: [{label}], rows: [{c:[{v}]}] }.
function gvizTable(labels: string[], rows: Array<Array<string | number>>) {
  return {
    cols: labels.map((label) => ({ label })),
    rows: rows.map((cells) => ({ c: cells.map((v) => ({ v })) })),
  };
}

describe("dashboardAlertInputs: zero-retention + AVAILABLE preference", () => {
  const table = gvizTable(
    ["SKU", "PRODUCT NAME", "AVAILABLE", "ON HAND ACTUAL", "REMAINING TO RECEIVE", "STATUS"],
    [
      // 100 physical on hand but 0 available (all allocated): must read as 0.
      ["S1", "Fully allocated", 0, 100, 0, ""],
      // Oversold: negative available is retained.
      ["S2", "Oversold", -5, 0, 0, ""],
      // Out of stock with inbound cover.
      ["S3", "Awaiting restock", 0, 0, 500, ""],
      // Healthy.
      ["S4", "Plenty", 4000, 4000, 0, ""],
    ],
  );

  it("prefers AVAILABLE over physical on-hand and keeps zero/negative rows", () => {
    const { available } = dashboardAlertInputs(table);
    const bySku = Object.fromEntries(available.map((row) => [row.sku, row.quantity]));
    expect(bySku.S1).toBe(0); // NOT 100 — allocated stock is not available
    expect(bySku.S2).toBe(-5);
    expect(bySku.S3).toBe(0);
    expect(bySku.S4).toBe(4000);
    // Every product row is retained, regardless of sign.
    expect(available).toHaveLength(4);
  });

  it("extracts inbound only for rows with remaining-to-receive > 0", () => {
    const { inbound } = dashboardAlertInputs(table);
    expect(inbound.map((row) => row.sku)).toEqual(["S3"]);
    expect(inbound[0].quantity).toBe(500);
  });

  it("falls back to on-hand columns when AVAILABLE is absent", () => {
    const noAvailable = gvizTable(
      ["SKU", "ON HAND ACTUAL", "REMAINING TO RECEIVE"],
      [["S9", 0, 0]],
    );
    const { available } = dashboardAlertInputs(noAvailable);
    expect(available).toHaveLength(1);
    expect(available[0].quantity).toBe(0);
  });
});

describe("computeInventoryAlerts: severity + cross-identifier reconciliation", () => {
  it("flags a true stockout with no inbound as CRIT (needs zero-retaining input)", () => {
    const alerts = computeInventoryAlerts(
      [item({ sku: "OUT1", productName: "Gone", quantity: 0 })],
      [],
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("crit");
    expect(alerts[0].available).toBe(0);
  });

  it("flags oversold (negative available) as CRIT", () => {
    const alerts = computeInventoryAlerts(
      [item({ sku: "NEG1", quantity: -12 })],
      [],
    );
    expect(alerts[0].severity).toBe("crit");
    expect(alerts[0].available).toBe(-12);
  });

  it("flags out-of-stock-with-inbound as INB", () => {
    const alerts = computeInventoryAlerts(
      [item({ sku: "INB1", quantity: 0 })],
      [item({ sku: "INB1", quantity: 300 })],
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("inb");
    expect(alerts[0].inbound).toBe(300);
  });

  it("flags low-but-positive available as LOW", () => {
    const alerts = computeInventoryAlerts(
      [item({ sku: "LOW1", quantity: 40 })],
      [],
    );
    expect(alerts[0].severity).toBe("low");
  });

  it("emits no alert for healthy stock", () => {
    const alerts = computeInventoryAlerts(
      [item({ sku: "OK1", quantity: 5000 })],
      [],
    );
    expect(alerts).toHaveLength(0);
  });

  it("merges a stock row and an inbound row that share only a UPC into ONE alert", () => {
    // Stock row keyed by SKU, inbound row carries no SKU but the same UPC.
    const alerts = computeInventoryAlerts(
      [item({ sku: "SKU-A", upc: "UPC-1", productName: "Serum", quantity: 0 })],
      [item({ sku: "", upc: "UPC-1", quantity: 800 })],
    );
    // Without alias matching this would split into a CRIT + an INB (two alerts).
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("inb");
    expect(alerts[0].available).toBe(0);
    expect(alerts[0].inbound).toBe(800);
  });

  it("sorts CRIT before LOW before INB", () => {
    const alerts = computeInventoryAlerts(
      [
        item({ sku: "L", quantity: 50 }),
        item({ sku: "C", quantity: 0 }),
      ],
      [item({ sku: "I", quantity: 100 })],
    );
    expect(alerts.map((a) => a.severity)).toEqual(["crit", "low", "inb"]);
  });
});
