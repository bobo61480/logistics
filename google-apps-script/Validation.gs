/**
 * Validation.gs — data validation & manual verification workflow
 *
 * validateRecord_() scores every record extracted from email before it may
 * touch the live schedules. Records that fail are written to the
 * PENDING VERIFICATION sheet (yellow rows) for a human to approve.
 * processApprovedPending() (time-driven) commits rows marked APPROVED.
 */

/* eslint-disable no-unused-vars */

var VALIDATION = {
  pendingSheetName: "PENDING VERIFICATION",
  pendingHeaders: ["Timestamp", "Kind", "Status", "Issues", "Customer", "Invoice / PI", "BL / PRO", "Container", "Ship Date / ETA", "Qty", "Carrier / Vessel", "Note", "Source Email", "Drive File", "Raw JSON"],
  statusValues: ["NEEDS REVIEW", "APPROVED", "REJECTED", "COMMITTED"],
  colors: { needsReview: "#FFF3CD", approved: "#D9EAD3", rejected: "#F4CCCC", committed: "#E8F0FE" },
  dateWindowPastDays: 45,     // reject dates further back than this
  dateWindowFutureDays: 400   // reject dates further out than this
};

/**
 * Returns { ok: boolean, issues: string[] }.
 * A record is committable only when required identifiers exist,
 * dates parse inside a sane window, and quantities are numeric.
 */
function validateRecord_(record, kind) {
  var issues = [];

  if (kind === "inbound") {
    if (!record.pro && !record.container && !record.invoice) {
      issues.push("No B/L, container, or invoice/entry number found.");
    }
    if (!record.eta && !record.shipDate) issues.push("No ETA or ship date found.");
    if (record.eta && !isSaneDate_(record.eta)) issues.push("ETA does not parse or is outside the expected window: " + record.eta);
    if (record.container && !/^[A-Z]{4}\d{7}$/.test(String(record.container).replace(/\s/g, ""))) {
      issues.push("Container number is not ISO-format (AAAA9999999): " + record.container);
    }
  } else {
    if (!record.customer) issues.push("Customer is missing.");
    if (!record.invoice && !record.pro) issues.push("Neither invoice/PO nor PRO/BOL found.");
    if (!record.shipDate) issues.push("Ship date is missing.");
    if (record.shipDate && !isSaneDate_(record.shipDate)) issues.push("Ship date does not parse or is outside the expected window: " + record.shipDate);
  }

  if (record.qty && !/^[\d,.\s]+$/.test(String(record.qty))) issues.push("Quantity is not numeric: " + record.qty);
  if (record.parseError) issues.push(record.parseError);
  if (record._rawTextSample) issues.push("PDF parsed but no reliable identifiers were found.");

  return { ok: issues.length === 0, issues: issues };
}

function isSaneDate_(value) {
  var parsed = parseFlexibleDate_(value);
  if (!parsed) return false;
  var now = new Date();
  var past = new Date(now.getTime() - VALIDATION.dateWindowPastDays * 86400000);
  var future = new Date(now.getTime() + VALIDATION.dateWindowFutureDays * 86400000);
  return parsed >= past && parsed <= future;
}

/** Accepts M/D, M/D/YY, M/D/YYYY, YYYY-MM-DD, "Aug 3", 2026.08.03 etc. */
function parseFlexibleDate_(value) {
  var s = String(value || "").trim();
  if (!s) return null;
  var m = s.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/);
  if (m) {
    var year = m[3] ? Number(m[3].length === 2 ? "20" + m[3] : m[3]) : new Date().getFullYear();
    var d = new Date(year, Number(m[1]) - 1, Number(m[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
  if (m) {
    var d2 = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d2.getTime()) ? null : d2;
  }
  var d3 = new Date(s);
  return isNaN(d3.getTime()) ? null : d3;
}

/* ------------------------------------------------------------------ */
/* Pending Verification sheet                                          */
/* ------------------------------------------------------------------ */

function ensurePendingSheet_() {
  var ss = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);
  var sheet = ss.getSheetByName(VALIDATION.pendingSheetName);
  if (!sheet) {
    sheet = ss.insertSheet(VALIDATION.pendingSheetName);
    sheet.appendRow(VALIDATION.pendingHeaders);
    sheet.getRange(1, 1, 1, VALIDATION.pendingHeaders.length).setFontWeight("bold").setBackground("#EFEFEF");
    sheet.setFrozenRows(1);
    var statusCol = VALIDATION.pendingHeaders.indexOf("Status") + 1;
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(VALIDATION.statusValues, true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, statusCol, 1000, 1).setDataValidation(rule);
  }
  return sheet;
}

/** Parks a questionable record for manual review (yellow row). */
function addPendingRow_(entry) {
  var sheet = ensurePendingSheet_();
  var r = entry.record || {};
  sheet.appendRow([
    new Date(),
    entry.kind || "",
    "NEEDS REVIEW",
    (entry.issues || []).join(" | "),
    r.customer || "",
    r.invoice || "",
    r.pro || "",
    r.container || "",
    r.shipDate || r.eta || "",
    r.qty || "",
    r.carrier || r.vessel || "",
    r.note || "",
    (entry.meta && entry.meta.permalink) || r._sourceEmail || "",
    entry.driveUrl || r._driveFile || "",
    JSON.stringify(Object.assign({}, r, { _sender: (entry.meta && entry.meta.from) || "" })).slice(0, 5000)
  ]);
  sheet.getRange(sheet.getLastRow(), 1, 1, VALIDATION.pendingHeaders.length)
    .setBackground(VALIDATION.colors.needsReview);
}

/**
 * Records an already-committed (never reviewed) email-ingestion event as its
 * own PENDING VERIFICATION row, Status written straight to COMMITTED. Today
 * the dashboard's Shipment Notices card only ever sees rows that failed
 * validation or were later approved — a record that matched cleanly and
 * committed silently (the common case) has no visible trace anywhere. This
 * shares the same sheet/columns as addPendingRow_, so no worker-side parsing
 * changes are needed to surface it.
 */
function addCommittedAuditRow_(entry) {
  var sheet = ensurePendingSheet_();
  var r = entry.record || {};
  // Inbound records identify themselves via shipmentNo/mbl/hbl, not `pro`
  // (an outbound/trucking concept) — without this fallback, an inbound
  // update matched solely on one of those fields writes no BL/PRO value,
  // and the worker (which derives shipmentId from Invoice / BL-PRO /
  // Container only) shows the notice as "Unidentified shipment".
  var blOrPro = r.pro || r.shipmentNo || r.mbl || r.hbl || "";
  sheet.appendRow([
    new Date(),
    entry.kind || "",
    "COMMITTED",
    "",
    r.customer || "",
    r.invoice || "",
    blOrPro,
    r.container || "",
    r.shipDate || r.eta || "",
    r.qty || "",
    r.carrier || r.vessel || "",
    entry.note || "",
    (entry.meta && entry.meta.permalink) || r._sourceEmail || "",
    entry.driveUrl || r._driveFolder || "",
    JSON.stringify(Object.assign({}, r, { _sender: (entry.meta && entry.meta.from) || "" })).slice(0, 5000)
  ]);
  sheet.getRange(sheet.getLastRow(), 1, 1, VALIDATION.pendingHeaders.length)
    .setBackground(VALIDATION.colors.committed);
}

/**
 * Commits one PENDING VERIFICATION row (Status already APPROVED) into the
 * live Imports / WH Trucking Request sheet, then recolors it COMMITTED.
 * Shared by the 30-minute batch job (processApprovedPending) and the instant
 * single-row path (reviewPendingRow_) so both write the exact same way and
 * can never drift apart.
 */
function commitApprovedPendingRow_(sheet, rowIndex1based, data, col) {
  var record;
  try { record = JSON.parse(data[col["Raw JSON"]] || "{}"); }
  catch (e) { record = {}; }
  // Prefer manually corrected cell values over the original extraction.
  record.customer = data[col["Customer"]] || record.customer;
  record.invoice = data[col["Invoice / PI"]] || record.invoice;
  record.pro = data[col["BL / PRO"]] || record.pro;
  record.container = data[col["Container"]] || record.container;
  record.qty = data[col["Qty"]] || record.qty;
  record.note = data[col["Note"]] || record.note;
  var when = data[col["Ship Date / ETA"]];
  var kind = String(data[col["Kind"]] || "outbound").toLowerCase();
  if (kind === "inbound") { record.eta = when || record.eta; upsertInboundEmailV2_(record, true); }
  else { record.shipDate = when || record.shipDate; upsertOutboundEmailV2_(record, true); }
  sheet.getRange(rowIndex1based, col["Status"] + 1).setValue("COMMITTED");
  sheet.getRange(rowIndex1based, 1, 1, VALIDATION.pendingHeaders.length).setBackground(VALIDATION.colors.committed);
}

/**
 * Time-driven: commits every pending row whose Status was manually set to
 * APPROVED, then re-colors it. REJECTED rows are greyed out and left in place
 * as an audit trail.
 */
function processApprovedPending() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var sheet = ensurePendingSheet_();
    var data = sheet.getDataRange().getDisplayValues();
    if (data.length < 2) return { committed: 0 };
    var col = {};
    VALIDATION.pendingHeaders.forEach(function (h, i) { col[h] = i; });

    var committed = 0;
    for (var r = 1; r < data.length; r++) {
      var status = String(data[r][col["Status"]] || "").trim().toUpperCase();
      var rowRange = sheet.getRange(r + 1, 1, 1, VALIDATION.pendingHeaders.length);
      if (status === "APPROVED") {
        commitApprovedPendingRow_(sheet, r + 1, data[r], col);
        committed++;
      } else if (status === "REJECTED") {
        rowRange.setBackground(VALIDATION.colors.rejected).setFontColor("#999999");
      }
    }
    return { committed: committed };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Recomputes the same composite key the dashboard derives in
 * deriveGmailIngestion/pendingEventsFromTable (worker/sources.ts):
 * kind|customer|invoice|blOrPro|container, uppercased. Deliberately excludes
 * Timestamp — gviz's date rendering and getDisplayValues() can format the
 * same cell differently, so a string-exact timestamp match would be fragile.
 */
function reviewKeyForRow_(data, col) {
  var parts = [
    data[col["Kind"]], data[col["Customer"]], data[col["Invoice / PI"]],
    data[col["BL / PRO"]], data[col["Container"]]
  ];
  return parts.map(function (v) { return String(v || "").trim().toUpperCase(); }).join("|");
}

/**
 * Instant dashboard-driven approve/reject for one PENDING VERIFICATION row,
 * called from Code.gs's doPost({action:"reviewPending"}). Only ever acts on
 * a row currently in NEEDS REVIEW, matched by reviewKeyForRow_. When repeated
 * emails produced more than one open row for the same shipment identifiers,
 * the newest appended row wins because it represents the latest email state.
 * Older rows remain as an audit trail and can still be resolved separately.
 */
function reviewPendingRow_(payload) {
  var reviewKey = String(payload.reviewKey || "").trim();
  var decision = String(payload.decision || "").trim().toLowerCase();
  if (!reviewKey) throw new Error("A review key is required.");
  if (decision !== "approve" && decision !== "reject") throw new Error("Decision must be approve or reject.");

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error("Server busy, please retry.");
  try {
    var sheet = ensurePendingSheet_();
    var data = sheet.getDataRange().getDisplayValues();
    if (data.length < 2) throw new Error("No pending rows to review.");
    var col = {};
    VALIDATION.pendingHeaders.forEach(function (h, i) { col[h] = i; });

    var matches = [];
    for (var r = 1; r < data.length; r++) {
      var status = String(data[r][col["Status"]] || "").trim().toUpperCase();
      if (status !== "NEEDS REVIEW") continue;
      if (reviewKeyForRow_(data[r], col) === reviewKey) matches.push(r);
    }
    if (matches.length === 0) {
      throw new Error("That review row is no longer open — someone may have already resolved it. Refresh and retry.");
    }
    // PENDING VERIFICATION is append-only. Selecting the last matching row
    // deterministically applies the decision to the latest notice instead of
    // blocking the operator when the same shipment received repeated emails.
    var r0 = matches[matches.length - 1];
    var rowIndex1based = r0 + 1;
    var rowRange = sheet.getRange(rowIndex1based, 1, 1, VALIDATION.pendingHeaders.length);
    if (decision === "approve") {
      sheet.getRange(rowIndex1based, col["Status"] + 1).setValue("APPROVED");
      commitApprovedPendingRow_(sheet, rowIndex1based, data[r0], col);
      SpreadsheetApp.flush();
      return { ok: true, action: "approved", row: rowIndex1based, status: "COMMITTED", matchedRows: matches.length };
    }
    sheet.getRange(rowIndex1based, col["Status"] + 1).setValue("REJECTED");
    rowRange.setBackground(VALIDATION.colors.rejected).setFontColor("#999999");
    SpreadsheetApp.flush();
    return { ok: true, action: "rejected", row: rowIndex1based, status: "REJECTED", matchedRows: matches.length };
  } finally {
    lock.releaseLock();
  }
}

/** Count of rows still needing review — consumed by the KPI dashboard. */
function pendingVerificationCount_() {
  try {
    var sheet = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId).getSheetByName(VALIDATION.pendingSheetName);
    if (!sheet || sheet.getLastRow() < 2) return 0;
    var statusCol = VALIDATION.pendingHeaders.indexOf("Status") + 1;
    return sheet.getRange(2, statusCol, sheet.getLastRow() - 1, 1).getDisplayValues()
      .filter(function (row) { return String(row[0]).trim().toUpperCase() === "NEEDS REVIEW"; }).length;
  } catch (e) { return 0; }
}
