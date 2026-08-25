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
 * Ships behind an explicit dryRun parameter, threaded from
 * OUTBOUND_INSERT_DRY_RUN_V2 (= true) only for the automatic-ingestion
 * caller — every match/insert scan still runs for real, but neither a
 * matched-row update nor a new insert ever calls setValue while dry-run is
 * on; both are logged to PIPELINE LOG instead ("OUTBOUND UPDATE DRY RUN" /
 * "OUTBOUND INSERT DRY RUN"), the same rollout discipline
 * WmsTruckingSyncV2.gs and CustomerBackfill.gs used before their own
 * live-write flips. Critically, a dry-run outcome always returns
 * `matched: false` — never a false "inserted"/"updated" — so the caller
 * treats it exactly like a genuine non-match: falls through to
 * validateRecord_ and PENDING VERIFICATION, rather than marking the Gmail
 * message committed for a write that never happened.
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
    // PU is IHERB's scheduling date and QTY its pallet count (confirmed
    // against scripts/all-outbound-pallets.mjs's IHERB aggregation) —
    // omitting them left every inserted row invisible to that existing
    // aggregation and unschedulable from the row (Codex review on PR #103).
    insertFields: { "PO#": "invoice", "BOL": "pro", "TRUCKING": "carrier", "PU": "shipDate", "QTY": "qty" },
    // record.shipDate is required here even though it's never written to a
    // sheet cell (see the file-level comment on why): validateRecord_'s
    // outbound branch always requires a ship date regardless of target
    // sheet, and insert only ever runs after that validation passes — an
    // eligibility rule looser than validateRecord_'s own gate would just be
    // unreachable dead code (Codex review on PR #103).
    insertEligible: function (record) {
      return Boolean(record.shipDate && (record.invoice || record.pro));
    }
  },
  "ULTA": {
    headerFinder: findUltaHeader_,
    matchers: [
      { col: "PRO#", field: "pro", weight: 120 },
      { col: "PO#", field: "invoice", weight: 80 }
    ],
    updateFields: [
      // Blank-fill only, matching every other identifier field here — a
      // row uniquely matched by PRO# with no PO# on file yet should still
      // pick one up, or a later PO#-only notice can never find it (Codex
      // review on PR #103: PO# was scored as a matcher and written on
      // insert, but never persisted on an update matched via PRO#).
      { col: "PO#", field: "invoice", label: "PO#", overwrite: false },
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
      // SHIPMENT # is this pipeline's own persisted identifier (written on
      // every insert below) and the most stable one once assigned — a
      // later email correcting the PO or BOL for the same shipment still
      // carries the same shipment number, and without this matcher neither
      // BOL nor PO# alone could find the row, so the live insert path
      // would create a duplicate (Codex review on PR #103).
      { col: "SHIPMENT #", field: "shipmentNo", weight: 130 },
      { col: "BOL", field: "pro", weight: 120 },
      { col: "PO#", field: "invoice", weight: 80 }
    ],
    updateFields: [
      // Same reasoning as ULTA above: PO# is a matcher and an insert
      // field, so a row matched via BOL alone should still pick up a PO#
      // it didn't already have on file.
      { col: "PO#", field: "invoice", label: "PO#", overwrite: false },
      { col: "SHIPMENT #", field: "shipmentNo", label: "Shipment #", overwrite: false },
      { col: "CARRIER", field: "carrier", label: "Carrier", overwrite: false },
      { col: "BOL", field: "pro", label: "BOL", overwrite: false }
    ],
    invoiceCol: null,
    noteCol: null,
    statusCol: "STATUS",
    insertFields: { "DC#": "customer", "PO#": "invoice", "SHIPMENT #": "shipmentNo", "BOL": "pro", "CARRIER": "carrier" },
    // Same reasoning as IHERB above: validateRecord_ requires a ship date
    // for every outbound record regardless of target sheet.
    insertEligible: function (record) {
      return Boolean(record.customer && record.shipDate && (record.invoice || record.pro || record.shipmentNo));
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
  // Case-insensitive: a human typing "iHerb"/"Iherb" during PENDING
  // VERIFICATION approval must still route here, not fall through to the
  // WH Trucking Request default below (Codex review on PR #103).
  if (sheetNames.indexOf("IHERB") !== -1 && customer.toUpperCase() === "IHERB") return "IHERB";
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

  // ULTA/TJX-ROSS/IHERB are evaluated together, not as a fixed priority
  // chain: a bare DC# number is a coincidence-prone signal (TJX/ROSS's
  // directory is just numbers 3-6 digits long), so an IHERB notice whose
  // "DC #" happens to also be a real TJX/ROSS store number must not
  // silently lose to whichever resolver was checked first. Exactly one
  // candidate firing is trusted; two or more is genuine conflicting
  // evidence and must not be guessed between (Codex review on PR #103).
  var haystack = gmailCustomerResolutionTextV2_(meta, context, record);
  var candidates = [];
  var ultaHit = resolveUltaDcFromEmailV2_(haystack);
  if (ultaHit) candidates.push({ sheet: "ULTA", customer: ultaHit.customer });
  var tjxHit = resolveTjxDcFromEmailV2_(haystack);
  if (tjxHit) candidates.push({ sheet: "TJX/ROSS", customer: tjxHit.customer });
  if (isIherbContextV2_(meta)) candidates.push({ sheet: "IHERB", customer: "IHERB" });

  if (candidates.length !== 1) return null;
  return candidates[0];
}

function isIherbContextV2_(meta) {
  var text = (String(meta && meta.subject || "") + " " + String(meta && meta.body || "")).toUpperCase();
  return /\bIHERB\b/.test(text);
}

/**
 * Which sheet to even ATTEMPT matching an existing row in — deliberately
 * more permissive than chooseOutboundSheetV2_ (routing for a NEW/insert
 * candidate), which requires a resolved customer/DC identity. The
 * pre-existing upsertOutboundEmailV2_ this generalizes matched WH Trucking
 * Request rows by PRO#/invoice alone, with no customer requirement at all
 * — only its insert branch required one. Requiring an identity before even
 * scanning for a match broke that (an outbound carrier notice with a clear
 * PRO#/invoice but no confidently resolved customer could no longer update
 * its own existing row, and GmailXpoV2.gs's fallback — which always calls
 * with an unset record.customer — could never match anything at all;
 * Codex review on PR #103). ULTA/IHERB/TJX-ROSS still require a resolved
 * identity even to attempt a match: without one there is no principled way
 * to know which of several sheets' PRO#/invoice namespace a bare
 * identifier belongs to, unlike WH Trucking Request, which every caller
 * already treats as the single default outbound sheet.
 */
function chooseOutboundMatchSheetV2_(record, sheetNames) {
  var customer = String(record.customer || "").trim();
  if (customer) return chooseOutboundSheetV2_(record, sheetNames);
  return sheetNames.indexOf("WH Trucking Request") !== -1 ? "WH Trucking Request" : null;
}

/**
 * dryRun is explicit, not read from the OUTBOUND_INSERT_DRY_RUN_V2 global
 * directly, so each caller controls its own safety posture:
 *  - processLogisticsMessageV2_ (automatic ingestion) passes the global
 *    flag — the only path this rollout gate is meant to protect.
 *  - upsertOutboundEmailV2_'s single-sheet shim (GmailXpoV2.gs's fallback)
 *    and Validation.gs's human-approval commit both pass false: a human
 *    approving a PENDING VERIFICATION row has already exercised the
 *    judgment this flag exists to substitute for, and GmailXpoV2.gs
 *    already writes live everywhere else in that file.
 */
function upsertOutboundEmailAcrossSheetsV2_(record, allowInsert, sheetNames, dryRun) {
  var matchSheetName = chooseOutboundMatchSheetV2_(record, sheetNames);
  var insertSheetName = chooseOutboundSheetV2_(record, sheetNames);

  if (matchSheetName) {
    var matchSpec = OUTBOUND_SHEET_SPECS_V2[matchSheetName];
    var ss = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);
    var sheet = ss.getSheetByName(matchSheetName);
    if (sheet && matchSpec) {
      var scanRows = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 10), Math.max(sheet.getLastColumn(), 1)).getDisplayValues();
      var header = matchSpec.headerFinder(scanRows);
      var lastRow = Math.max(sheet.getLastRow(), header.rowIndex + 1);
      var lastCol = Math.max(sheet.getLastColumn(), 24);
      var data = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();

      var candidates = [];
      for (var r = header.rowIndex + 1; r < data.length; r++) {
        var score = outboundMatchScoreV2_(data[r], record, header.map, matchSpec.matchers);
        if (score) candidates.push({ row: r + 1, score: score });
      }
      candidates.sort(function (a, b) { return b.score - a.score; });

      if (candidates.length) {
        if (candidates[1] && candidates[0].score === candidates[1].score) {
          // Tied match: never guess which row is right, and never insert a
          // duplicate either — a tie among existing candidates means this
          // identifier is already ambiguous on the sheet, a data problem
          // an insert would only make worse (Codex review on PR #103).
          return { matched: false, action: "noop" };
        }
        var rowNumber = candidates[0].row;
        if (dryRun) {
          logOutboundUpdateDryRunV2_(matchSheetName, rowNumber, record);
          return { matched: false, action: "noop" };
        }
        var oldRow = data[rowNumber - 1];
        var updateResult = updateOutboundRowV2_(sheet, rowNumber, oldRow, record, header.map, matchSpec);
        return { matched: true, action: updateResult.changed ? "updated" : "noop", row: rowNumber, changes: updateResult.changes };
      }
    }
  }

  if (!allowInsert || !insertSheetName) return { matched: false, action: "noop" };
  var insertSpec = OUTBOUND_SHEET_SPECS_V2[insertSheetName];
  if (!insertSpec || !insertSpec.insertEligible(record)) return { matched: false, action: "noop" };

  var insertSs = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);
  var insertSheet = insertSs.getSheetByName(insertSheetName);
  if (!insertSheet) return { matched: false, action: "noop" };
  var insertScanRows = insertSheet.getRange(1, 1, Math.min(insertSheet.getLastRow(), 10), Math.max(insertSheet.getLastColumn(), 1)).getDisplayValues();
  var insertHeader = insertSpec.headerFinder(insertScanRows);
  return insertOutboundRowV2_(insertSheetName, insertSheet, insertHeader, record, insertSpec, dryRun);
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

function insertOutboundRowV2_(sheetName, sheet, header, record, spec, dryRun) {
  if (dryRun) {
    logOutboundInsertDryRunV2_(sheetName, record);
    // matched:false, not true — a dry-run "would insert" is not a commit.
    // Returning matched:true here (as an earlier revision did) made every
    // caller treat this record as fully handled: the Gmail message gets
    // marked seen, an "INGEST COMMIT" log entry and a Shipment Notices
    // "Received:" row get written for a shipment that was never actually
    // inserted anywhere, and a human-approved PENDING VERIFICATION row
    // would flip to COMMITTED without ever being written live (Codex
    // review on PR #103). Returning matched:false instead routes the
    // record through the exact same path a genuinely no-match record
    // takes — validateRecord_, then PENDING VERIFICATION — so a dry-run
    // "would insert" is still fully visible and reviewable, and nothing
    // is silently marked done.
    return { matched: false, action: "noop", dryRun: true };
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
    var exemplarRange = sheet.getRange(exemplarRow, 1, 1, width);
    var newRange = sheet.getRange(startRow, 1, 1, width);
    // All three paste types, matching WmsTruckingSyncV2.gs's exemplar-row
    // pattern — PASTE_FORMULA is what keeps formula-backed columns (e.g.
    // WH Trucking Request's VOLUME/CFT/PCF/DIMENSIONAL WEIGHT) computing
    // once dimensions are filled in later; omitting it left every inserted
    // row's calculated columns permanently blank (Codex review on PR #103).
    exemplarRange.copyTo(newRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    exemplarRange.copyTo(newRange, SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
    exemplarRange.copyTo(newRange, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }
  return { matched: true, action: "inserted", row: startRow };
}

function logOutboundUpdateDryRunV2_(sheetName, rowNumber, record) {
  try {
    writeLog_("OUTBOUND UPDATE DRY RUN", sheetName, JSON.stringify({
      sheet: sheetName,
      row: rowNumber,
      customer: record.customer || "",
      invoice: record.invoice || "",
      pro: record.pro || "",
      shipDate: record.shipDate || "",
      carrier: record.carrier || "",
      status: record.status || ""
    }));
  } catch (e) { /* logging must never break ingestion */ }
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
