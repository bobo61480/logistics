import { describe, expect, it } from "vitest";
import { reconcileInventory } from "../app/inventory-reconciliation-card";

describe("inventory reconciliation", () => {
  it("aggregates matching SKU lots and explains differences", () => {
    const warehouse = [{ id: "1", shipmentNo: "IB1", productName: "Cream", sku: "SKU1", upc: "123", expirationDate: "2027-01-01", quantity: 12, location: "A1", status: "" }];
    const cms = [{ productName: "Cream", sku: "SKU1", upc: "123", expirationDate: "2027-01-01", quantity: 10 }];
    expect(reconcileInventory(warehouse, cms)).toEqual([expect.objectContaining({ warehouseQuantity: 12, cmsQuantity: 10, difference: 2, potentialCause: expect.stringContaining("Receiving") })]);
  });
});
