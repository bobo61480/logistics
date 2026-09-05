import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Fulfillment -> logistics routing", () => {
  it("routes TK to WH Trucking and recognized parcel carriers to IMPORTS/PARCELS", () => {
    const router = read("google-apps-script/FulfillmentRouting.gs");
    expect(router).toContain("function syncFulfillmentLogistics()");
    expect(router).toContain("getSalesOverview");
    expect(router).toContain("getSalesInvoiceDetail");
    expect(router).toContain('"TK"');
    for (const carrier of ["FEDEX", "UPS", "USPS", "AMAZON", "DHL"]) expect(router).toContain(`"${carrier}"`);
    expect(router).toContain('getSheetByName("WH Trucking Request")');
    expect(router).toContain('getSheetByName("IMPORTS")');
    expect(router).toContain('"PARCELS"');
  });

  it("uses stable source tokens and upserts instead of repeat appends", () => {
    const router = read("google-apps-script/FulfillmentRouting.gs");
    expect(router).toContain("[FULFILLMENT:");
    expect(router).toContain("fulfillmentStableId_");
    expect(router).toContain("upsertFulfillmentTrucking_");
    expect(router).toContain("upsertFulfillmentParcel_");
    expect(router).toContain("findFulfillmentTokenRow_");
    expect(router).toContain("appendRow");
    expect(router).toContain("existingRow");
    expect(router).toContain("if (method === \"TK\")");
    expect(router).toContain("else if (parcelCarrier)");
  });

  it("preserves distinct destinations and maps operational shipment details", () => {
    const router = read("google-apps-script/FulfillmentRouting.gs");
    for (const field of [
      "customer", "deliveryAddress", "invoice", "shipDate", "amount", "trackingNumber",
      "dimensions", "weight", "quantity", "status", "locationHint",
    ]) expect(router).toContain(field);
    expect(router).toContain("normalizeFulfillmentDestination_");
    expect(router).toContain("totalFulfillmentQuantity_");
    expect(router).toContain("formatFulfillmentDimensions_");
    expect(router).toContain("normalizeFulfillmentDate_");
  });

  it("runs every 15 minutes under the canonical trigger owner", () => {
    const triggers = read("google-apps-script/Triggers.gs");
    expect(triggers).toContain('{ handler: "syncFulfillmentLogistics", minutes: 15 }');
    expect(triggers).toMatch(/TRIGGER_CLEANUP_HANDLERS[\s\S]*"syncFulfillmentLogistics"/);
  });
});