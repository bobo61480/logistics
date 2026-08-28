import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type ContextHelpers = {
  extractEmailContextV2_: (subject: string, body: string) => Record<string, unknown>;
  pdfTextRecordV2_: (text: string, context: Record<string, unknown>, sourceName: string) => Record<string, unknown>;
};

function loadHelpers() {
  const pipeline = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
  const context = vm.createContext({ console, writeLog_: () => {} });
  vm.runInContext(
    `${pipeline}\n;globalThis.__ctx = { extractEmailContextV2_, pdfTextRecordV2_ };`,
    context,
  );
  return context.__ctx as ContextHelpers;
}

// Regression for a Codex review finding: tableToShipmentRecordsV2_'s
// specialized IHERB/ULTA/TJX-ROSS column aliases (PO#/BOL/PU) only apply to
// CSV/XLSX tables — a converted PDF's plain text goes through
// extractEmailContextV2_/pdfTextRecordV2_ instead, which recognized IN########
// invoices and PRO# but nothing else, so a PDF whose only identifiers were
// PO#/BOL/PU produced no usable record and was discarded to pending review.
describe("extractEmailContextV2_ recognizes specialized PDF labels", () => {
  it("falls back to PO# when no StyleKorean-format invoice number is present", () => {
    const helpers = loadHelpers();
    const context = helpers.extractEmailContextV2_("New shipment", "PO#: 4500999999\nPU: 08/25/2026");
    expect(context.invoice).toBe("4500999999");
    expect(context.shipDate).toBe("08/25/26");
  });

  it("prefers a real IN######## invoice number over a PO# mention", () => {
    const helpers = loadHelpers();
    const context = helpers.extractEmailContextV2_("Invoice", "Invoice IN00404691, PO# 4500999999");
    expect(context.invoice).toBe("IN00404691");
  });

  it("recognizes BOL as a PRO fallback", () => {
    const helpers = loadHelpers();
    const context = helpers.extractEmailContextV2_("Shipment", "BOL: BOL12345");
    expect(context.pro).toBe("BOL12345");
  });

  it("does not treat a bare 'PO Box' mention as a PO# identifier", () => {
    const helpers = loadHelpers();
    const context = helpers.extractEmailContextV2_("Update", "Please mail to PO Box 12345, Anytown.");
    expect(context.invoice).toBe("");
  });

  it("carries the PO#/BOL/PU fallback through the PDF extraction path", () => {
    const helpers = loadHelpers();
    const record = helpers.pdfTextRecordV2_("PO#: 4500999999\nBOL: BOL12345\nPU: 08/25/2026", {}, "shipment.pdf");
    expect(record.invoice).toBe("4500999999");
    expect(record.pro).toBe("BOL12345");
    expect(record.shipDate).toBe("08/25/26");
  });
});
