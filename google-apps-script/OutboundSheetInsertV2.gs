/**
 * OutboundSheetInsertV2.gs — generalized Gmail-ingestion insert/update
 * across WH Trucking Request, IHERB, ULTA, and TJX/ROSS.
 *
 * Before this file, only WH Trucking Request had any insert-row capability
 * (GmailPipelineV2.gs's upsertOutboundEmailV2_, whose insert branch was
 * unreachable dead code because nothing ever set record.customer). This
 * generalizes that same header-name-driven matching/insert shape — modeled
 * on WmsTruckingSyncV2.gs's exemplar-row insert pattern — across the other
 * three sheets, each using its own real, live-confirmed header instead of
 * a guessed generic "customer" column:
 *
 *  - WH Trucking Request: a real CUSTOMER column (unchanged matching logic,
 *    just rewritten to look up columns by header name instead of hardcoded
 *    index — verified byte-equivalent against the live header).
 *  - IHERB: no customer column at all — every row is implicitly IHERB, so
 *    record.customer is set to the literal string "IHERB" purely for
 *    routing/validation, never written to any sheet cell.
 *  - ULTA / TJX/ROSS: no customer-name column — their real identity column
 *    is a store/DC value ("ULTA (FRESNO)", a bare DC# number), supplied by
 *    GmailStoreResolverV2.gs and carried in record.customer the same way a
 *    real customer name is for WH Trucking Request.
 *
 * TRANSFERS was evaluated and excluded: its real header
 * (NOTE/PLT/VENDOR-SUPPLIER-ORIGIN/FROM/TO/PU/TRUCKING/BOL#/...) is an
 * internal BP<->NJ warehouse-transfer log with no customer/shipper concept
 * at all — there is nothing for an external email to identify against.
 *
 * Ships behind OUTBOUND_INSERT_DRY_RUN_V2 = true: every scan runs and
 * matches for real, but an insert is logged to PIPELINE LOG instead of
 * written, the same rollout discipline WmsTruckingSyncV2.gs and
 * CustomerBackfill.gs used before their own live-write flips.
 */

var OUTBOUND_INSERT_DRY_RUN_V2 = true;
var OUTBOUND_INSERT_SHEETS_V2 = ["WH Trucking Request", "IHERB", "ULTA", "TJX/ROSS"];

function findIherbHeader_(rows) {
  for (var r = 0; r < Math.min(rows.length, 3); r++) {
    var map = headerMap_(rows[r]);
    if (map["PO#"] !== undefined && map["BOL"] !== undefined && map["STATUS"] !== undefined) {
      return { rowIndex: r, map: map };
    }
  }
  throw new Error("Could not locate the IHERB header row.");
}

function findUltaHeader_(rows) {
  for (var r = 0; r < Math.min(rows.length, 3); r++) {
    var map = headerMap_(rows[r]);
    if (map["DC"] !== undefined && map["PO#"] !== undefined && map["STATUS"] !== undefined) {
      return { rowIndex: r, map: map };
    }
  }
  throw new Error("Could not locate the ULTA header row.");
}

function findTjxRossHeader_(rows) {
  for (var r = 0; r < Math.min(rows.length, 3); r++) {
    var map = headerMap_(rows[r]);
    if (map["DC#"] !== undefined && map["STATUS"] !== undefined && map["WEBSITE STATUS"] !== undefined) {
      return { rowIndex: r, map: map };
    }
  }
  throw new Error("Could not locate the TJX/ROSS header row.");
}

/**
 * One entry per insertable sheet. matchers score candidate rows for the
 * update path (highest unique score wins, a tie is treated as no match —
 * same discipline as upsertOutboundEmailV2_/upsertInboundEmailV2_ already
 * use). updateFields are blank-fill (overwrite:false) or always-refresh
 * (overwrite:true) exactly like the pre-existing per-sheet upsert
 * functions. insertFields maps sheet column name -> record field, used
 * only when no existing row matched and the record clears insertEligible.
 *
 * ULTA/TJX-ROSS deliberately omit a ship-date insert field beyond what's
 * listed: their real headers hold that date under whitespace/newline-laden
 * column names ("ship date" duplicated against a separate "Date" column on
 * ULTA; a literal embedded newline in "SHIPOUT \nDATE" on TJX/ROSS) that
 * are too easy to get subtly wrong without being able to test against the
 * live sheet directly — safer to leave those blank on insert than risk a
 * silent mismatched write.
 */
var OUTBOUND_SHEET_SPECS_V2 = {
  "WH Trucking Request": {
    headerFinder: findWhTruckingHeader_,
    matchers: [
      { col: "PRO#", field: "pro", weight: 120 },
      { col: "INVOICE NO.", field: "invoice", weight: 80, multiline: true }
    ],
    updateFields: [
      { col: "CARRIER", field: "carrier", label: "Carrier", overwrite: false },
      { col: "PRO#", field: "pro", label: "PRO #", overwrite: false },
      { col: "SHIP DATE", field: "shipDate", label: "Ship Date", overwrite: true }
    ],
    invoiceCol: "INVOICE NO.",
    noteCol: "NOTE",
    statusCol: "STATUS",
    insertFields: { "CUSTOMER": "customer", "INVOICE NO.": "invoice", "SHIP DATE": "shipDate", "CARRIER": "carrier", "PRO#": "pro" },
    insertEligible: function (record) {
      return Boolean(record.customer && record.shipDate && (record.invoice || record.pro));
    }
  },
  "IHERB": {
    headerFinder: findIherbHeader_,
    matchers: [
      { col: "BOL", field: "pro", weight: 120 },
      { col: "PO#", field: "invoice", weight: 80, multiline: true }
    ],
    updateFields: [
      { col: "TRUCKING", field: "carrier", label: "Carrier", overwrite: false },
      { col: "BOL", field: "pro", label: "BOL", overwrite: false }
    ],
    invoiceCol: "PO#",
    noteCol: null,
    statusCol: "STATUS",
    insertFields: { "PO#": "invoice", "BOL": "pro", "TRUCKING": "carrier" },
    insertEligible: function (record) {
      return Boolean(record.invoice || record.pro);
    }
  },
  "ULTA": {
    headerFinder: findUltaHeader_,
    matchers: [
      { col: "PRO#", field: "pro", weight: 120 },
      { col: "PO#", field: "invoice", weight: 80 }
    ],
    updateFields: [
      { col: "TRUCKING", field: "carrier", label: "Carrier", overwrite: false },
      { col: "PRO#", field: "pro", label: "PRO #", overwrite: false },
      { col: "SHIP DATE", field: "shipDate", label: "Ship Date", overwrite: true }
    ],
    invoiceCol: null,
    noteCol: "NOTE",
    statusCol: "STATUS",
    insertFields: { "DC": "customer", "PO#": "invoice", "SHIP DATE": "shipDate", "TRUCKING": "carrier", "PRO#": "pro" },
    insertEligible: function (record) {
      return Boolean(record.customer && record.shipDate && (record.invoice || record.pro));
    }
  },
  "TJX/ROSS": {
    headerFinder: findTjxRossHeader_,
    matchers: [
      { col: "BOL", field: "pro", weight: 120 },
      { col: "PO#", field: "invoice", weight: 80 }
    ],
    updateFields: [
      { col: "CARRIER", field: "carrier", label: "Carrier", overwrite: false },
      { col: "BOL", field: "pro", label: "BOL", overwrite: false }
    ],
    invoiceCol: null,
    noteCol: null,
    statusCol: "STATUS",
    insertFields: { "DC#": "customer", "PO#": "invoice", "SHIPMENT #": "shipmentNo", "BOL": "pro", "CARRIER": "carrier" },
    insertEligible: function (record) {
      return Boolean(record.customer && (record.invoice || record.pro || record.shipmentNo));
    }
  }
};

/**
 * Picks the target sheet purely from data already on the record — never
 * re-runs an email resolver. This is what every caller uses (the live
 * ingestion path, GmailXpoV2.gs's fallback, and a human-approved PENDING
 * VERIFICATION row), so a customer/DC identity resolved once at ingestion
 * time (or typed by hand during manual review) routes consistently
 * everywhere. sheetNames scopes which sheets a given caller is allowed to
 * reach — the single-sheet upsertOutboundEmailV2_ shim passes only
 * ["WH Trucking Request"], preserving its exact existing reach.
 */
function chooseOutboundSheetV2_(record, sheetNames) {
  var customer = String(record.customer || "").trim();
  if (!customer) return null;
  if (sheetNames.indexOf("ULTA") !== -1 && /^ULTA\s*\(/i.test(customer)) return "ULTA";
  if (sheetNames.indexOf("TJX/ROSS") !== -1 && /^\d{3,6}$/.test(customer)) return "TJX/ROSS";
  if (sheetNames.indexOf("IHERB") !== -1 && customer === "IHERB") return "IHERB";
  if (sheetNames.indexOf("WH Trucking Request") !== -1) return "WH Trucking Request";
  return null;
}

/**
 * Runs the customer/store resolvers once, at ingestion time, to decide
 * which of the 4 sheets (if any) a brand-new outbound record belongs to.
 * Only ever called from processLogisticsMessageV2_, which has meta/context
 * available — every other caller of upsertOutboundEmailAcrossSheetsV2_
 * routes off record.customer alone via chooseOutboundSheetV2_ above.
 */
function resolveOutboundTargetV2_(record, meta, context) {
  var customerHit = resolveCustomerFromEmailV2_(meta, context, record);
  if (customerHit) return { sheet: "WH Trucking Request", customer: customerHit.customer };

  var haystack = gmailCustomerResolutionTextV2_(meta, context, record);
  var ultaHit = resolveUltaDcFromEmailV2_(haystack);
  if (ultaHit) return { sheet: "ULTA", customer: ultaHit.customer };

  var tjxHit = resolveTjxDcFromEmailV2_(haystack);
  if (tjxHit) return { sheet: "TJX/ROSS", customer: tjxHit.customer };

  if (isIherbContextV2_(meta)) return { sheet: "IHERB", customer: "IHERB" };

  return null;
}

function isIherbContextV2_(meta) {
  var text = (String(meta && meta.subject || "") + " " + String(meta && meta.body || "")).toUpperCase();
  return /\bIHERB\b/.test(text);
}

function upsertOutboundEmailAcrossSheetsV2_(record, allowInsert, sheetNames) {
  var sheetName = chooseOutboundSheetV2_(record, sheetNames);
  if (!sheetName) return { matched: false, action: "noop" };
  var spec = OUTBOUND_SHEET_SPECS_V2[sheetName];
  if (!spec) return { matched: false, action: "noop" };

  var ss = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { matched: false, action: "noop" };

  var scanRows = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 10), Math.max(sheet.getLastColumn(), 1)).getDisplayValues();
  var header = spec.headerFinder(scanRows);
  var lastRow = Math.max(sheet.getLastRow(), header.rowIndex + 1);
  var lastCol = Math.max(sheet.getLastColumn(), 24);
  var data = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();

  var candidates = [];
  for (var r = header.rowIndex + 1; r < data.length; r++) {
    var score = outboundMatchScoreV2_(data[r], record, header.map, spec.matchers);
    if (score) candidates.push({ row: r + 1, score: score });
  }
  candidates.sort(function (a, b) { return b.score - a.score; });

  if (candidates.length && (!candidates[1] || candidates[0].score > candidates[1].score)) {
    var rowNumber = candidates[0].row;
    var oldRow = data[rowNumber - 1];
    var updateResult = updateOutboundRowV2_(sheet, rowNumber, oldRow, record, header.map, spec);
    return { matched: true, action: updateResult.changed ? "updated" : "noop", row: rowNumber, changes: updateResult.changes };
  }

  if (!allowInsert) return { matched: false, action: "noop" };
  if (!spec.insertEligible(record)) return { matched: false, action: "noop" };

  return insertOutboundRowV2_(sheetName, sheet, header, record, spec);
}

function outboundMatchScoreV2_(row, record, map, matchers) {
  var score = 0;
  matchers.forEach(function (m) {
    var col = map[m.col];
    if (col === undefined) return;
    var wanted = record[m.field];
    if (!wanted) return;
    var isMatch = m.multiline ? multilineHasV2_(row[col], wanted) : sameEmailIdV2_(row[col], wanted);
    if (isMatch) score += m.weight;
  });
  return score;
}

function updateOutboundRowV2_(sheet, rowNumber, oldRow, record, map, spec) {
  var changed = false;
  var changes = [];
  function set(colName, value, overwrite, label) {
    var col = map[colName];
    if (col === undefined || !value) return;
    var old = String(oldRow[col] || "").trim();
    if (old === String(value).trim()) return;
    if (old && !overwrite) return;
    sheet.getRange(rowNumber, col + 1).setValue(value);
    if (label) changes.push(label + " " + (old || "—") + " → " + String(value).trim());
    oldRow[col] = value;
    changed = true;
  }

  if (spec.invoiceCol && record.invoice) {
    var mergedInvoices = mergeMultilineV2_(oldRow[map[spec.invoiceCol]], record.invoice);
    set(spec.invoiceCol, mergedInvoices, true, "Invoice");
  }

  spec.updateFields.forEach(function (f) { set(f.col, record[f.field], Boolean(f.overwrite), f.label); });

  if (spec.statusCol && record.status) {
    var normalized = canonicalLogisticsStatus_(record.status);
    if (!normalized) throw new Error("Unsupported logistics status: " + record.status);
    var currentStatus = String(oldRow[map[spec.statusCol]] || "").trim();
    if (canAutoTransitionLogisticsStatus_(currentStatus, normalized)) set(spec.statusCol, normalized, true, "Status");
  }

  if (changed && spec.statusCol && map[spec.statusCol] !== undefined) {
    formatEmailStatusRowV2_(sheet, rowNumber, String(oldRow[map[spec.statusCol]] || record.status || ""));
  }

  return { changed: changed, changes: changes };
}

function insertOutboundRowV2_(sheetName, sheet, header, record, spec) {
  if (OUTBOUND_INSERT_DRY_RUN_V2) {
    logOutboundInsertDryRunV2_(sheetName, record);
    return { matched: true, action: "inserted", row: null, dryRun: true };
  }

  var width = Math.max.apply(null, Object.keys(header.map).map(function (k) { return header.map[k]; })) + 1;
  var newRow = new Array(width).fill("");
  Object.keys(spec.insertFields).forEach(function (colName) {
    var col = header.map[colName];
    var field = spec.insertFields[colName];
    if (col !== undefined && record[field]) newRow[col] = record[field];
  });
  if (spec.noteCol && header.map[spec.noteCol] !== undefined) {
    var note = emailNoteV2_(record);
    if (note) newRow[header.map[spec.noteCol]] = note;
  }
  if (spec.statusCol && header.map[spec.statusCol] !== undefined) {
    var insertStatus = record.status ? canonicalLogisticsStatus_(record.status) : "Work in Progress";
    if (record.status && !insertStatus) throw new Error("Unsupported logistics status: " + record.status);
    newRow[header.map[spec.statusCol]] = insertStatus || "Work in Progress";
  }

  var startRow = Math.max(sheet.getLastRow() + 1, header.rowIndex + 2);
  sheet.getRange(startRow, 1, 1, width).setValues([newRow]);
  var exemplarRow = startRow - 1;
  if (exemplarRow > header.rowIndex + 1) {
    sheet.getRange(exemplarRow, 1, 1, width).copyTo(sheet.getRange(startRow, 1, 1, width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sheet.getRange(exemplarRow, 1, 1, width).copyTo(sheet.getRange(startRow, 1, 1, width), SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }
  return { matched: true, action: "inserted", row: startRow };
}

function logOutboundInsertDryRunV2_(sheetName, record) {
  try {
    writeLog_("OUTBOUND INSERT DRY RUN", sheetName, JSON.stringify({
      sheet: sheetName,
      customer: record.customer || "",
      invoice: record.invoice || "",
      pro: record.pro || "",
      shipDate: record.shipDate || "",
      shipmentNo: record.shipmentNo || "",
      carrier: record.carrier || "",
      status: record.status || ""
    }));
  } catch (e) { /* logging must never break ingestion */ }
}
