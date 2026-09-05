/**
 * zzzzzzzz_GmailSafetyV4.gs
 *
 * Pure production hardening helpers for Gmail V2. Canonical entry points call
 * these helpers explicitly; this file must never replace another function at
 * load time because Apps Script does not guarantee file evaluation order.
 */
/* eslint-disable no-unused-vars */

var GMAIL_SAFETY_V4_VERSION = "2026-08-29-v4-canonical-dedupe";
var GMAIL_SAFETY_V4_NEEDS_CORRECTION = "NEEDS CORRECTION";
var GMAIL_SAFETY_V4_D1_REFRESH_URL = "https://stylekorean.dpdns.org/api/logistics/snapshot?refresh=1&source=apps-script-gmail";

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
  var file = Drive.Files.create({ name: "TMP-email-import-" + Date.now(), mimeType: targetMime }, blob, { fields: "id" });
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

function gmailSafetyV4RefreshD1_(reason) {
  SpreadsheetApp.flush();
  try {
    var response = UrlFetchApp.fetch(GMAIL_SAFETY_V4_D1_REFRESH_URL + "&reason=" + encodeURIComponent(String(reason || "gmail")), {
      method: "get",
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { "User-Agent": "StyleKorean-AppsScript-DualWrite/2026-08-29" }
    });
    var code = response.getResponseCode();
    var body = response.getContentText();
    var parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch (ignored) {}
    if (code < 200 || code >= 300 || parsed.ok !== true || parsed.storage !== "d1" || parsed.frontendSource !== "d1") {
      throw new Error("D1 refresh rejected: HTTP " + code + " " + String(body || "").slice(0, 300));
    }
    try { writeLog_("D1 DUAL WRITE", String(reason || "gmail"), JSON.stringify({ ok: true, generatedAt: parsed.generatedAt })); } catch (ignored2) {}
    return { ok: true, generatedAt: parsed.generatedAt };
  } catch (error) {
    try { writeLog_("D1 DUAL WRITE ERROR", String(reason || "gmail"), String(error && error.stack || error)); } catch (ignored3) {}
    return { ok: false, error: String(error && error.message || error) };
  }
}

