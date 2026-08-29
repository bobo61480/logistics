/**
 * zzzzzzzz_GmailSafetyV4.gs
 *
 * One late-loaded production hardening layer for Gmail V2. Keep the safety
 * rules in one place rather than creating parallel parser copies.
 */
/* eslint-disable no-unused-vars */

var GMAIL_SAFETY_V4_VERSION = "2026-08-29-v4-canonical-dedupe";
var GMAIL_SAFETY_V4_NEEDS_CORRECTION = "NEEDS CORRECTION";
var GMAIL_SAFETY_V4_LAST_UPSERT = null;

function gmailSafetyV4ValidFreightId_(value) {
  var id = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!id) return false;
  if (/^(?:DUCTID|HIBITED|PRODUCTID|TRACKING|TRACKINGNO|SHIPMENT|DELIVERY|STATUS|UNKNOWN|NONE|N\/A)$/i.test(id)) return false;
  if (/^STY-?\d{3,}$/.test(id)) return true;
  if (/^1Z[A-Z0-9]{16}$/.test(id)) return true;
  if (/^\d{8,12}$/.test(id)) return true;
  return /^[A-Z0-9-]{6,24}$/.test(id) && /\d/.test(id);
}

function gmailSafetyV4StrongIdentity_(record) {
  var r = record || {};
  var container = String(r.container || "").replace(/\s/g, "").toUpperCase();
  if (/^[A-Z]{4}\d{7}$/.test(container)) return true;
  if (/^IN\d{8}$/i.test(String(r.invoice || "").replace(/\s/g, ""))) return true;
  if (r.pro && gmailSafetyV4ValidFreightId_(r.pro)) return true;
  var hbl = String(r.hbl || "").replace(/[\s-]+/g, "").toUpperCase();
  var mbl = String(r.mbl || "").replace(/[\s-]+/g, "").toUpperCase();
  var shipment = String(r.shipmentNo || "").replace(/[\s-]+/g, "").toUpperCase();
  return (hbl.length >= 5 && /\d/.test(hbl)) || (mbl.length >= 7 && /\d/.test(mbl)) || (shipment.length >= 5 && /\d/.test(shipment));
}

function gmailSafetyV4ApplyRecord_(record, meta) {
  var r = record || {};
  if (r.pro && !gmailSafetyV4ValidFreightId_(r.pro)) {
    r._rejectedPro = r.pro;
    r.pro = "";
  }
  var from = String((meta && meta.from) || r._sender || "");
  if (/@stylekoreanus\.com\b/i.test(from) && !gmailSafetyV4StrongIdentity_(r)) {
    r.parseError = r.parseError || "Sent-mail instruction lacks a strong shipment identifier; confirmation or manual review is required.";
    r.status = "";
  }
  if (String(r.status || "").toUpperCase() === "CANCELLED" && !gmailSafetyV4StrongIdentity_(r)) {
    r.parseError = r.parseError || "Cancellation lacks an exact shipment identifier and requires review.";
    r.status = "";
  }
  return r;
}

function gmailSafetyV4ConvertBlob_(blob, targetMime) {
  var file = Drive.Files.create({
    name: "TMP-email-import-" + Date.now(),
    mimeType: targetMime
  }, blob, { fields: "id" });
  if (!file || !file.id) throw new Error("Drive conversion returned no file ID.");
  return file.id;
}

function gmailSafetyV4PdfText_(blob) {
  var id = gmailSafetyV4ConvertBlob_(blob, "application/vnd.google-apps.document");
  try {
    var exported = Drive.Files.export(id, "text/plain");
    if (exported && typeof exported.getDataAsString === "function") return exported.getDataAsString();
    if (typeof exported === "string") return exported;
    throw new Error("Drive text export returned an unsupported response.");
  } finally {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {}
  }
}

function gmailSafetyV4Install_() {
  if (typeof LOGISTICS_STATUS_ALIASES_ !== "undefined") {
    LOGISTICS_STATUS_ALIASES_["FDA RELEASED"] = "FDA Released / Scheduled";
    LOGISTICS_STATUS_ALIASES_["FDA RELEASED/SCHEDULED"] = "FDA Released / Scheduled";
    LOGISTICS_STATUS_ALIASES_["FDA RELEASED / SCHEDULED"] = "FDA Released / Scheduled";
  }

  if (typeof VALIDATION !== "undefined") {
    if (VALIDATION.statusValues.indexOf(GMAIL_SAFETY_V4_NEEDS_CORRECTION) === -1) VALIDATION.statusValues.splice(1, 0, GMAIL_SAFETY_V4_NEEDS_CORRECTION);
    VALIDATION.colors.needsCorrection = "#FCE8B2";
  }

  if (typeof mergeRecordContextV2_ === "function" && !mergeRecordContextV2_._gmailSafetyV4) {
    var baseMerge = mergeRecordContextV2_;
    var wrappedMerge = function (record, context, meta) {
      return gmailSafetyV4ApplyRecord_(baseMerge(record, context, meta), meta || {});
    };
    wrappedMerge._gmailSafetyV4 = true;
    mergeRecordContextV2_ = wrappedMerge;
  }

  if (typeof upsertInboundEmailV2_ === "function" && !upsertInboundEmailV2_._gmailSafetyV4) {
    var baseInbound = upsertInboundEmailV2_;
    var wrappedInbound = function (record, allowInsert) {
      var result = baseInbound(record, allowInsert);
      GMAIL_SAFETY_V4_LAST_UPSERT = result || { matched: false, action: "noop" };
      return result;
    };
    wrappedInbound._gmailSafetyV4 = true;
    upsertInboundEmailV2_ = wrappedInbound;
  }

  if (typeof upsertOutboundEmailV2_ === "function" && !upsertOutboundEmailV2_._gmailSafetyV4) {
    var baseOutbound = upsertOutboundEmailV2_;
    var wrappedOutbound = function (record, allowInsert) {
      var result = baseOutbound(record, allowInsert);
      GMAIL_SAFETY_V4_LAST_UPSERT = result || { matched: false, action: "noop" };
      return result;
    };
    wrappedOutbound._gmailSafetyV4 = true;
    upsertOutboundEmailV2_ = wrappedOutbound;
  }

  if (typeof commitApprovedPendingRow_ === "function" && !commitApprovedPendingRow_._gmailSafetyV4) {
    var baseCommit = commitApprovedPendingRow_;
    var wrappedCommit = function (sheet, rowIndex1based, data, col) {
      GMAIL_SAFETY_V4_LAST_UPSERT = null;
      baseCommit(sheet, rowIndex1based, data, col);
      var result = GMAIL_SAFETY_V4_LAST_UPSERT;
      if (!result || result.matched !== true) {
        var statusCell = sheet.getRange(rowIndex1based, col["Status"] + 1);
        statusCell.setValue(GMAIL_SAFETY_V4_NEEDS_CORRECTION);
        var issueCell = sheet.getRange(rowIndex1based, col["Issues"] + 1);
        var priorIssue = String(issueCell.getDisplayValue() || "").trim();
        var issue = "Approved record could not be uniquely matched or safely inserted. Correct identifiers/customer/date, then approve again.";
        if (priorIssue.indexOf(issue) === -1) issueCell.setValue(priorIssue ? priorIssue + " | " + issue : issue);
        sheet.getRange(rowIndex1based, 1, 1, VALIDATION.pendingHeaders.length).setBackground(VALIDATION.colors.needsCorrection);
        return { committed: false, matched: false, action: "needs-correction" };
      }
      return { committed: true, matched: true, action: result.action, row: result.row, changes: result.changes || [] };
    };
    wrappedCommit._gmailSafetyV4 = true;
    commitApprovedPendingRow_ = wrappedCommit;
  }

  if (typeof reviewPendingRow_ === "function" && !reviewPendingRow_._gmailSafetyV4) {
    var baseReview = reviewPendingRow_;
    var wrappedReview = function (payload) {
      var result = baseReview(payload);
      if (result && result.action === "approved" && result.row) {
        var pending = ensurePendingSheet_();
        var statusColumn = VALIDATION.pendingHeaders.indexOf("Status") + 1;
        var actualStatus = String(pending.getRange(result.row, statusColumn).getDisplayValue() || "").trim();
        result.status = actualStatus || result.status;
        result.ok = actualStatus === "COMMITTED";
        if (!result.ok) result.error = "Approved review could not be committed safely; row moved to " + actualStatus + ".";
      }
      return result;
    };
    wrappedReview._gmailSafetyV4 = true;
    reviewPendingRow_ = wrappedReview;
  }

  if (typeof Drive !== "undefined" && Drive.Files && typeof Drive.Files.create === "function") {
    if (typeof convertBlobWithDriveRestV2_ === "function") convertBlobWithDriveRestV2_ = gmailSafetyV4ConvertBlob_;
    if (typeof pdfTextV2_ === "function") pdfTextV2_ = gmailSafetyV4PdfText_;
  }

  return GMAIL_SAFETY_V4_VERSION;
}

var GMAIL_SAFETY_V4_INSTALLED = gmailSafetyV4Install_();
