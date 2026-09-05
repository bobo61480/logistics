/**
 * GmailXpoV2.gs — XPO LTL status adapter for GmailIngestionV2.
 *
 * This is intentionally carrier-specific rather than a second generic Gmail
 * pipeline. It handles XPO Shipment Progress notices, resolves the canonical
 * source row by PO / PRO, and never inserts a new shipment from a tracking
 * email. Ambiguous or unmatched notices go to PENDING VERIFICATION.
 */

/* eslint-disable no-unused-vars */

var GMAIL_XPO_V2_VERSION = "2026-09-04-v4-late-source-retry";
var GMAIL_XPO_V2_LOOKBACK_DAYS = 4;
var GMAIL_XPO_V2_SEEN_PREFIX = "GMAIL_XPO_V4_SEEN_";
var GMAIL_XPO_V2_ATTEMPT_PREFIX = "GMAIL_XPO_V4_ATTEMPT_";
var GMAIL_XPO_V2_RETRY_AT_PREFIX = "GMAIL_XPO_V4_RETRY_AT_";
var GMAIL_XPO_V2_MAX_UNMATCHED_ATTEMPTS = 4;
// One-time v4 recovery boundary: old carrier notices stay consumed; only
// notices dated September 4 or later are replayed under the retry policy.
var GMAIL_XPO_V2_REPLAY_CUTOFF_MS = 1788505200000; // 2026-09-04 00:00 America/Los_Angeles
var GMAIL_XPO_V2_MAX_MESSAGES = 100;
var GMAIL_XPO_SOURCE_SHEETS = [
  "ULTA",
  "IHERB",
  "TJX/ROSS",
  "TRANSFERS",
  "B2B/E-COM TRUCKING",
  "WH Trucking Request"
];

function processXpoTrackingEmailsV2() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    recordTriggerLockSkip_("processXpoTrackingEmailsV2");
    return { skipped: "locked" };
  }
  var stats;
  var shouldRefreshD1 = false;
  try {
    ensureCanonicalTriggersForVersion_();
    var query = "newer_than:" + GMAIL_XPO_V2_LOOKBACK_DAYS +
      'd -in:spam -in:trash from:no-reply@xpo.com subject:"Shipment Progress for Pro"';
    var byId = {};
    GmailApp.search(query, 0, 50).forEach(function (thread) {
      thread.getMessages().forEach(function (message) {
        if (Date.now() - message.getDate().getTime() > GMAIL_XPO_V2_LOOKBACK_DAYS * 86400000) return;
        byId[message.getId()] = message;
      });
    });
    var messages = Object.keys(byId).map(function (id) { return byId[id]; });
    messages.sort(function (a, b) { return a.getDate().getTime() - b.getDate().getTime(); });
    messages = messages.slice(-GMAIL_XPO_V2_MAX_MESSAGES);

    stats = { messages: 0, updated: 0, noop: 0, pending: 0, retryDeferred: 0, errors: 0, priorLockSkips: consumeTriggerLockSkips_("processXpoTrackingEmailsV2") };
    messages.forEach(function (message) {
      var id = message.getId();
      if (gmailXpoSeenV2_(id)) return;
      if (gmailXpoPredatesReplayCutoverV2_(message.getDate())) {
        gmailXpoMarkSeenV2_(id);
        gmailXpoClearRetryV2_(id);
        return;
      }
      if (gmailXpoRetryDeferredV2_(id)) { stats.retryDeferred++; return; }
      stats.messages++;
      try {
        var record = parseXpoMessageV2_(message);
        if (!record.pro || !record.status) {
          addPendingRow_({
            kind: "outbound",
            issues: ["XPO notice did not contain a usable PRO and canonical status."],
            record: record,
            meta: { messageId: id, subject: message.getSubject(), permalink: record._sourceEmail },
            driveUrl: ""
          });
          stats.pending++;
          gmailXpoMarkSeenV2_(id);
          return;
        }

        var result = upsertXpoSourceV2_(record);
        if (!result.matched) {
          var disposition = gmailXpoUnmatchedDispositionV2_(id);
          if (!disposition.pending) {
            stats.retryDeferred++;
            logPipeline_("XPO MATCH RETRY", id, JSON.stringify({ attempts: disposition.attempts, retryAt: disposition.retryAt, pro: record.pro, po: record.po }));
            return;
          }
          addPendingRow_({
            kind: "outbound",
            issues: [result.reason || "XPO notice could not be uniquely matched to a source row."],
            record: record,
            meta: { messageId: id, subject: message.getSubject(), permalink: record._sourceEmail },
            driveUrl: ""
          });
          stats.pending++;
          gmailXpoMarkSeenV2_(id);
          return;
        } else {
          gmailXpoClearRetryV2_(id);
          stats[result.action] = (stats[result.action] || 0) + 1;
          if (result.action !== "noop") {
            addCommittedAuditRow_({
              kind: "outbound",
              record: record,
              meta: { messageId: id, subject: message.getSubject(), permalink: record._sourceEmail },
              driveUrl: "",
              note: "Changed: " + result.changes.join(", ") + " (" + result.sheet + " row " + result.row + ")"
            });
          }
          logPipeline_("XPO INGEST COMMIT", message.getSubject(), JSON.stringify({
            action: result.action,
            sheet: result.sheet,
            row: result.row,
            pro: record.pro,
            po: record.po,
            rawStatus: record.rawStatus,
            status: record.status,
            sourceEmail: record._sourceEmail
          }));
        }
        gmailXpoMarkSeenV2_(id);
      } catch (error) {
        stats.errors++;
        logPipeline_("XPO INGEST ERROR", id, String(error && error.stack || error));
      }
    });
    shouldRefreshD1 = stats.updated > 0 || stats.pending > 0;
    logPipeline_("XPO V2 RUN", GMAIL_XPO_V2_VERSION, JSON.stringify(stats));
  } finally {
    lock.releaseLock();
  }
  if (shouldRefreshD1) gmailSafetyV4RefreshD1_("processXpoTrackingEmailsV2");
  return stats;
}

function gmailXpoSeenV2_(messageId) {
  return Boolean(PropertiesService.getScriptProperties().getProperty(GMAIL_XPO_V2_SEEN_PREFIX + messageId));
}

function gmailXpoMarkSeenV2_(messageId) {
  PropertiesService.getScriptProperties().setProperty(GMAIL_XPO_V2_SEEN_PREFIX + messageId, String(Date.now()));
}

function gmailXpoPredatesReplayCutoverV2_(messageDate) {
  return messageDate && messageDate.getTime() < GMAIL_XPO_V2_REPLAY_CUTOFF_MS;
}

function gmailXpoRetryDeferredV2_(messageId) {
  var retryAt = Number(PropertiesService.getScriptProperties().getProperty(GMAIL_XPO_V2_RETRY_AT_PREFIX + messageId) || 0);
  return retryAt > Date.now();
}

function gmailXpoClearRetryV2_(messageId) {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(GMAIL_XPO_V2_ATTEMPT_PREFIX + messageId);
  props.deleteProperty(GMAIL_XPO_V2_RETRY_AT_PREFIX + messageId);
}

function gmailXpoUnmatchedDispositionV2_(messageId) {
  var props = PropertiesService.getScriptProperties();
  var attempts = Number(props.getProperty(GMAIL_XPO_V2_ATTEMPT_PREFIX + messageId) || 0) + 1;
  props.setProperty(GMAIL_XPO_V2_ATTEMPT_PREFIX + messageId, String(attempts));
  if (attempts < GMAIL_XPO_V2_MAX_UNMATCHED_ATTEMPTS) {
    var delayMinutes = 15 * Math.pow(2, attempts - 1);
    var retryAt = Date.now() + delayMinutes * 60000;
    props.setProperty(GMAIL_XPO_V2_RETRY_AT_PREFIX + messageId, String(retryAt));
    return { pending: false, attempts: attempts, retryAt: retryAt };
  }
  gmailXpoClearRetryV2_(messageId);
  return { pending: true, attempts: attempts, retryAt: 0 };
}

function parseXpoMessageV2_(message) {
  var subject = String(message.getSubject() || "").trim();
  var body = String(message.getPlainBody() || "");
  var subjectPro = subject.match(/\bPro\s+([0-9]{8,12})\b/i);
  var shipmentPro = body.match(/\bShipment\s*:\s*([0-9]{3}-[0-9]{6})\b/i);
  var proNumber = body.match(/\bPro Number\s*:\s*([0-9]{8,12})\b/i);
  var po = body.match(/\bPO#\s*(?:PO#\s*)?([0-9]{7,})\b/i);
  var pickup = body.match(/\bPickup\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})\b/i);
  var rawStatusMatch = subject.match(/\s-\s([^\r\n]+)$/) || body.match(/^Status\s*:\s*([^\r\n]+)/im);
  var rawStatus = rawStatusMatch ? String(rawStatusMatch[1]).trim() : "";
  var status = xpoCanonicalStatusV2_(rawStatus, body);

  return {
    kind: "outbound",
    carrier: "XPO",
    pro: shipmentPro ? shipmentPro[1] : xpoDisplayProV2_((proNumber && proNumber[1]) || (subjectPro && subjectPro[1]) || ""),
    rawPro: (proNumber && proNumber[1]) || (subjectPro && subjectPro[1]) || "",
    po: po ? po[1] : "",
    shipDate: pickup ? normalizeEmailDateV2_(pickup[1]) : "",
    status: status,
    rawStatus: rawStatus,
    note: "XPO: " + (rawStatus || status || "Shipment update"),
    _sourceEmail: "https://mail.google.com/mail/u/0/#all/" + message.getId(),
    _emailSubject: subject
  };
}

function xpoCanonicalStatusV2_(rawStatus, body) {
  var signal = String(rawStatus || "") + "\n" + String(body || "");
  if (/\bDELIVERED\b/i.test(rawStatus)) return "Delivered";
  if (/\bCOMPLETED\b/i.test(rawStatus)) return "Completed";
  if (/\b(?:POTENTIAL DELAY|DELAYED|EXCEPTION OCCURRED|EXCEPTION OCCURED|DELIVERY ATTEMPTED|ATTEMPTED DELIVERY|ATTEMPTED)\b/i.test(signal)) return "Delayed";
  if (/\bARRIVED AT INTERIM\b/i.test(rawStatus) && /\b(?:POSSIBLE DELAY NOTIFICATION|THIS SHIPMENT MAY BE DELAYED|CURRENT ESTIMATED DELIVERY DATE OF THE SHIPMENT IS NOW)\b/i.test(signal)) return "Delayed";
  if (/\b(?:OUT FOR DELIVERY|PICKED UP|ARRIVED AT INTERIM|IN TRANSIT|SHIPPED)\b/i.test(rawStatus)) return "Shipping";
  return "";
}

function xpoDisplayProV2_(value) {
  var digits = String(value || "").replace(/\D/g, "");
  if (!digits) return String(value || "").trim();

  // XPO's own "Shipment : XXX-YYYYYY" body field already matches the source
  // sheets' PRO# format directly (see parseXpoMessageV2_'s shipmentPro regex)
  // and is preferred over this function. This function only runs as a
  // fallback when that field is missing and we're left with the continuous
  // digit string from the email subject ("Pro NNNNNNNNNN") or the "Pro
  // Number : NNNNNNNNNN" body field instead.
  //
  // That continuous string is NOT the same digits as the sheet's "XXX-YYYYYY"
  // PRO# with the dash removed -- XPO's format embeds one extra "0" after the
  // first 3 digits (e.g. body "Shipment : 755-361935" vs. subject
  // "Pro 07550361935" for the identical shipment). Left unconverted, this
  // fallback never matches any source row (xpoKeyV2_ strips non-alphanumerics
  // from both sides before comparing, so the extra digit alone breaks the
  // match) and the notice piles up in PENDING VERIFICATION as
  // "No source row matched XPO PO ... / PRO ...". Confirmed against 573
  // historical XPO "Delivered" notices: 573/574 fit this exact pattern.
  var normalized = digits;
  if (normalized.length === 11 && normalized.charAt(0) === "0") {
    normalized = normalized.slice(1); // drop XPO's leading zero -> 10 digits
  }
  if (normalized.length === 10 && normalized.charAt(3) === "0") {
    return normalized.slice(0, 3) + "-" + normalized.slice(4); // XXX0YYYYYY -> XXX-YYYYYY
  }
  return digits;
}

function xpoKeyV2_(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function xpoHeaderV2_(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "").replace(/\./g, "");
}

function xpoFindHeaderV2_(rows) {
  var aliases = {
    po: ["PO#", "PO", "PONO", "PURCHASEORDER", "PURCHASEORDER#"],
    pro: ["PRO#", "PRO", "PRONO", "TRACKING#", "TRACKINGNO"],
    status: ["STATUS", "WEBSITESTATUS"],
    carrier: ["CARRIER", "TRUCKING"],
    shipDate: ["SHIPDATE", "PICKUPDATE", "DATE"]
  };
  for (var r = 0; r < Math.min(rows.length, 8); r++) {
    var map = {};
    rows[r].forEach(function (cell, index) {
      var normalized = xpoHeaderV2_(cell);
      Object.keys(aliases).forEach(function (field) {
        if (map[field] !== undefined) return;
        if (aliases[field].indexOf(normalized) !== -1) map[field] = index;
      });
    });
    if (map.status !== undefined && (map.pro !== undefined || map.po !== undefined)) return { row: r, map: map };
  }
  return null;
}

function xpoValidatedStatusV2_(cell, canonicalStatus) {
  var rule = cell.getDataValidation();
  if (!rule) return canonicalStatus;
  try {
    if (rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
      var criteria = rule.getCriteriaValues();
      var values = criteria && criteria[0] ? criteria[0] : [];
      for (var i = 0; i < values.length; i++) {
        if (String(values[i]).trim().toUpperCase() === String(canonicalStatus).trim().toUpperCase()) return String(values[i]);
      }
    }
  } catch (e) { /* use canonical fallback */ }
  return canonicalStatus;
}

function upsertXpoSourceV2_(record) {
  var ss = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);
  var candidates = [];

  GMAIL_XPO_SOURCE_SHEETS.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) return;
    var data = sheet.getDataRange().getDisplayValues();
    var header = xpoFindHeaderV2_(data);
    if (!header) return;
    var map = header.map;
    for (var r = header.row + 1; r < data.length; r++) {
      var score = 0;
      var rowPo = map.po !== undefined ? String(data[r][map.po] || "").trim() : "";
      var rowPro = map.pro !== undefined ? String(data[r][map.pro] || "").trim() : "";
      if (record.po && xpoKeyV2_(rowPo) === xpoKeyV2_(record.po)) score += 180;
      if (record.pro && xpoKeyV2_(rowPro) === xpoKeyV2_(record.pro)) score += 160;
      if (score) candidates.push({ sheet: sheet, sheetName: name, row: r + 1, score: score, old: data[r], map: map });
    }
  });

  candidates.sort(function (a, b) { return b.score - a.score; });
  if (!candidates.length) {
    var wh = upsertOutboundEmailV2_(record, false);
    if (wh.matched) {
      wh.sheet = "WH Trucking Request";
      wh.changes = wh.changes || [];
      return wh;
    }
    return { matched: false, reason: "No source row matched XPO PO " + (record.po || "—") + " / PRO " + (record.pro || record.rawPro || "—") + "." };
  }
  if (candidates[1] && candidates[0].score === candidates[1].score) {
    return { matched: false, reason: "XPO PO/PRO matched more than one source row; manual verification required." };
  }

  var hit = candidates[0];
  var sheet = hit.sheet;
  var map = hit.map;
  var old = hit.old;
  var changed = false;
  var changes = [];

  function setField(field, value, overwrite, label) {
    if (map[field] === undefined || value === undefined || value === null || String(value).trim() === "") return;
    var prior = String(old[map[field]] || "").trim();
    var next = String(value).trim();
    if (prior === next) return;
    if (prior && !overwrite) return;
    sheet.getRange(hit.row, map[field] + 1).setValue(next);
    old[map[field]] = next;
    changed = true;
    changes.push(label + " " + (prior || "—") + " → " + next);
  }

  setField("pro", record.pro, false, "PRO #");
  setField("carrier", "XPO", false, "Carrier");
  setField("shipDate", record.shipDate, false, "Ship Date");
  if (record.status && map.status !== undefined) {
    var currentStatus = String(old[map.status] || "").trim();
    if (canAutoTransitionLogisticsStatus_(currentStatus, record.status)) {
      var statusCell = sheet.getRange(hit.row, map.status + 1);
      setField("status", xpoValidatedStatusV2_(statusCell, record.status), true, "Status");
    }
  }

  if (changed && map.status !== undefined && isTerminalLogisticsStatus_(String(old[map.status] || ""))) {
    sheet.getRange(hit.row, 1, 1, sheet.getLastColumn()).setBackground("#E8EAED").setFontColor("#5F6368");
  }
  return { matched: true, action: changed ? "updated" : "noop", sheet: hit.sheetName, row: hit.row, changes: changes };
}
