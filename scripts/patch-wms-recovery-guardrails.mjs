import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, from, to) {
  const source = readFileSync(path, "utf8");
  if (!source.includes(from)) throw new Error(`Missing patch anchor in ${path}: ${from.slice(0, 100)}`);
  const next = source.replace(from, to);
  if (next === source) throw new Error(`No change made in ${path}`);
  writeFileSync(path, next);
}

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `  for (var i = 0; i < rows.length; i++) {\n    var row = rows[i];\n    for (var j = 0; j < row.invoices.length; j++) {\n      if (wanted.has(String(row.invoices[j] || "").trim().toUpperCase())) return row;\n    }\n  }\n\n  for (var k = 0; k < rows.length; k++) {`,
  `  for (var i = 0; i < rows.length; i++) {\n    var row = rows[i];\n    var hasWantedInvoice = false;\n    for (var j = 0; j < row.invoices.length; j++) {\n      if (wanted.has(String(row.invoices[j] || "").trim().toUpperCase())) {\n        hasWantedInvoice = true;\n        break;\n      }\n    }\n    if (!hasWantedInvoice) continue;\n    if (row.key === groupKey) return row;\n    if (row.operationallyLocked) return row;\n    var hasConflictingInvoice = row.invoices.some(function (invoice) {\n      return !wanted.has(String(invoice || "").trim().toUpperCase());\n    });\n    if (!hasConflictingInvoice) return row;\n  }\n\n  for (var k = 0; k < rows.length; k++) {`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `        invoices: splitWmsInvoices_(invoiceCell),\n        active: isWmsActiveStatus_(status),\n        status: status`,
  `        invoices: splitWmsInvoices_(invoiceCell),\n        active: isWmsActiveStatus_(status),\n        operationallyLocked: !shouldWmsOverwriteShipDate_(targetRow, targetMap),\n        status: status`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `    var repaired = 0;\n    var skippedTerminal = 0;\n    var pendingRows = [];`,
  `    var repaired = 0;\n    var skippedTerminal = 0;\n    var skippedOperational = 0;\n    var pendingRows = [];`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `        if (!match.active) {\n          skippedTerminal++;\n          return;\n        }\n\n        var current = targetSheet.getRange(match.rowNumber, 1, 1, width).getValues()[0];`,
  `        if (!match.active) {\n          skippedTerminal++;\n          return;\n        }\n        if (match.operationallyLocked && match.key !== key) {\n          skippedOperational++;\n          return;\n        }\n\n        var current = targetSheet.getRange(match.rowNumber, 1, 1, width).getValues()[0];`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `      ", repaired=" + repaired +\n      ", skippedTerminal=" + skippedTerminal +\n      ", skippedBeforeCutoff=" + skippedBeforeCutoff`,
  `      ", repaired=" + repaired +\n      ", skippedTerminal=" + skippedTerminal +\n      ", skippedOperational=" + skippedOperational +\n      ", skippedBeforeCutoff=" + skippedBeforeCutoff`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `      repaired: repaired,\n      skippedTerminal: skippedTerminal,\n      skippedBeforeCutoff: skippedBeforeCutoff,`,
  `      repaired: repaired,\n      skippedTerminal: skippedTerminal,\n      skippedOperational: skippedOperational,\n      skippedBeforeCutoff: skippedBeforeCutoff,`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  ` *  - groups only by canonical customer + exact ship date\n *  - never reuses a target row whose exact customer/date key differs`,
  ` *  - groups by canonical customer + exact ship date + explicit destination when present\n *  - cross-date invoice matching rejects rows that contain conflicting invoices`,
);

replaceOnce(
  "tests/apps-script-integrity.test.ts",
  `  it("re-enables the hardened WMS trucking importer in dry-run mode with the customer-canonicalization fix", () => {`,
  `  it("runs the hardened WMS trucking importer live only with destination/date safeguards", () => {`,
);

replaceOnce(
  "tests/apps-script-integrity.test.ts",
  `    expect(importer).toContain("var WMS_TRUCKING_DRY_RUN = true;");\n    expect(importer).toContain("function logWmsDryRun_(");\n    expect(importer).toContain("function wouldChangeMappedValue_(");`,
  `    expect(importer).toContain("var WMS_TRUCKING_DRY_RUN = false;");\n    expect(importer).toContain("function wmsDestinationHint_(");\n    expect(importer).toContain("function shouldWmsOverwriteShipDate_(");\n    expect(importer).toContain("skippedOperational");`,
);

console.log("Applied WMS recovery guardrails.");
