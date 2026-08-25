import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type ExtractionHelpers = {
  tableToShipmentRecordsV2_: (
    rows: unknown[][],
    context: Record<string, unknown>,
    sourceName: string,
  ) => Record<string, unknown>[];
  findLogisticsHeaderRowV2_: (rows: unknown[][]) => number;
};

function loadExtractionHelpers() {
  const pipeline = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
  const context = vm.createContext({ console, writeLog_: () => {} });
  vm.runInContext(
    `${pipeline}\n;globalThis.__extraction = { tableToShipmentRecordsV2_, findLogisticsHeaderRowV2_ };`,
    context,
  );
  return context.__extraction as ExtractionHelpers;
}

// Regression for a Codex round-5 finding on PR #103: the attachment table
// extractor only recognized inbound-shaped headers (CONTAINER/INVOICE/MBL/
// HBL/ETA/ETD/VSL/SKU/QTY) — a real IHERB/ULTA/TJX-ROSS export (PO#/BOL/
// PRO#/DC#/TRUCKING/SHIP DATE) either failed header detection outright
// (fewer than 2 keyword hits) or, once detected, mapped none of its
// identifier columns into record.invoice/record.pro/record.carrier/
// record.shipDate — the exact fields OutboundSheetInsertV2.gs's matchers
// and insertEligible checks require.
describe("tableToShipmentRecordsV2_ recognizes specialized-sheet headers", () => {
  it("detects an IHERB-shaped header row and maps PO#/BOL/TRUCKING/PU/QTY", () => {
    const helpers = loadExtractionHelpers();
    const rows = [
      ["PO#", "BOL", "QTY", "FROM", "TO", "APPT #", "PU", "DELIVERY APPT", "VALUE", "TRUCKING", "RATE", "INVOICE", "STATUS"],
      ["4500999999", "BOL12345", "18", "LA", "IHERB", "", "08/25/2026", "", "", "Sunset Pacific", "", "", ""],
    ];
    const records = helpers.tableToShipmentRecordsV2_(rows, {}, "iherb.csv");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      invoice: "4500999999",
      pro: "BOL12345",
      carrier: "Sunset Pacific",
      shipDate: "08/25/26",
      qty: "18",
    });
  });

  it("detects a TJX/ROSS-shaped header row and maps DC#-adjacent identifiers", () => {
    const helpers = loadExtractionHelpers();
    const rows = [
      ["Order Received", "Order Name", "DC#", "PO#", "SHIPMENT #", "BOL", "CARRIER", "STATUS", "WEBSITE STATUS"],
      ["", "Ross 92k", "1234", "PO-555", "SHIP555", "BOL-777", "XPO", "", ""],
    ];
    const records = helpers.tableToShipmentRecordsV2_(rows, {}, "tjx.csv");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ invoice: "PO-555", pro: "BOL-777", carrier: "XPO" });
  });

  it("still detects the original inbound header shape unaffected by the new aliases", () => {
    const helpers = loadExtractionHelpers();
    const rows = [
      ["CONTAINER#", "INVOICE#", "MBL", "ETA", "SKU"],
      ["ABCU1234567", "INV-1", "MBL-1", "09/01/2026", "SKU-1"],
    ];
    const records = helpers.tableToShipmentRecordsV2_(rows, {}, "imports.csv");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ container: "ABCU1234567", invoice: "INV-1", mbl: "MBL-1" });
  });
});
