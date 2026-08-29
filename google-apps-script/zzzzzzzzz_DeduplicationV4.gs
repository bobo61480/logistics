/**
 * zzzzzzzzz_DeduplicationV4.gs
 *
 * System rule: one shipment/event, one canonical operational record.
 * - Prevent duplicate PENDING VERIFICATION / COMMITTED audit rows.
 * - Remove exact duplicate rows from operational source tabs.
 * - Remove sparse duplicate rows only when a richer row with the same strong
 *   shipment identity contains every non-empty value from the sparse row.
 * - Never merge conflicting rows automatically; conflicts remain visible for
 *   review rather than silently discarding information.
 */
/* eslint-disable no-unused-vars */

var DEDUPLICATION_V4_VERSION = "2026-08-29-v1-canonical-no-copies";
var DEDUPLICATION_V4_SHEETS = [
  "IMPORTS",
  "WH Trucking Request",
  "ULTA",
  "IHERB",
  "TJX/ROSS",
  "TRANSFERS",
  "B2B/E-COM TRUCKING",
  "TRUCKING"
];

function dedupeV4Norm_(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function dedupeV4Compact_(value) {
  return dedupeV4Norm_(value).replace(/[\s-]+/g, "");
}

function dedupeV4FirstToken_(value) {
  var parts = String(value || "").split(/[\n,;|]+/);
  for (var i = 0; i < parts.length; i++) if (String(parts[i] || "").trim()) return String(parts[i]).trim();
  return "";
}

function dedupeV4FindHeader_(data) {
  for (var r = 0; r < Math.min(data.length, 8); r++) {
    var row = data[r].map(dedupeV4Norm_);
    if (row.indexOf("CUSTOMER") !== -1 || row.indexOf("SHIPMENT") !== -1 || row.indexOf("CONTAINER") !== -1 || row.indexOf("INVOICE") !== -1 || row.indexOf("INVOICE NO.") !== -1) return r;
  }
  return 0;
}

function dedupeV4HeaderMap_(header) {
  var map = {};
  header.forEach(function (value, index) {
    var key = dedupeV4Norm_(value);
    if (key && map[key] === undefined) map[key] = index;
  });
  return map;
}

function dedupeV4Value_(row, map, names) {
  for (var i = 0; i < names.length; i++) {
    var index = map[dedupeV4Norm_(names[i])];
    if (index !== undefined && String(row[index] || "").trim()) return String(row[index]).trim();
  }
  return "";
}

function dedupeV4StrongKey_(sheetName, row, map) {
  var fields = [
    ["CONTAINER", "CONTAINER NO", "CONTAINER RAW (SYSTEM)"],
    ["HBL", "HOUSE B/L", "HOUSE BL"],
    ["MBL", "MASTER B/L", "MASTER BL"],
    ["PRO#", "PRO", "PRO #", "BOL", "B/L", "TRACKING", "TRACKING #", "TRACKING#"],
    ["SHIPMENT", "SHIPMENT #", "SHIPMENT NO", "SHIPMENT NO."],
    ["PO#", "PO", "PO #"]
  ];
  for (var f = 0; f < fields.length; f++) {
    var candidate = dedupeV4Compact_(dedupeV4FirstToken_(dedupeV4Value_(row, map, fields[f])));
    if (candidate && candidate.length >= 5 && /\d/.test(candidate)) return fields[f][0] + ":" + candidate;
  }
  var invoice = dedupeV4Compact_(dedupeV4FirstToken_(dedupeV4Value_(row, map, ["INVOICE", "INVOICE#", "INVOICE NO.", "INVOICE NO", "PI NO."])));
  var customer = dedupeV4Norm_(dedupeV4Value_(row, map, ["CUSTOMER", "CUSTOMER NAME"]));
  var date = dedupeV4Compact_(dedupeV4Value_(row, map, ["SHIP DATE", "SHIPPING DATE", "PICK UP DATE", "PU DATE", "ETA"]));
  if (invoice && customer && date) return "INV-CUST-DATE:" + invoice + "|" + customer + "|" + date;
  return "";
}

function dedupeV4ExactFingerprint_(row) {
  return row.map(dedupeV4Norm_).join("\u001f");
}

function dedupeV4Subset_(sparse, rich) {
  var width = Math.max(sparse.length, rich.length);
  var hasValue = false;
  for (var c = 0; c < width; c++) {
    var a = dedupeV4Norm_(sparse[c]);
    var b = dedupeV4Norm_(rich[c]);
    if (!a) continue;
    hasValue = true;
    if (!b || a !== b) return false;
  }
  return hasValue;
}

function dedupeV4NonEmptyCount_(row) {
  return row.reduce(function (count, cell) { return count + (String(cell || "").trim() ? 1 : 0); }, 0);
}

function dedupeOperationalSheetV4_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return { removed: 0, conflicts: 0 };
  var data = sheet.getDataRange().getDisplayValues();
  var headerIndex = dedupeV4FindHeader_(data);
  var map = dedupeV4HeaderMap_(data[headerIndex] || []);
  var exact = {};
  var byKey = {};
  var deleteRows = {};
  var conflicts = 0;

  for (var r = headerIndex + 1; r < data.length; r++) {
    var row = data[r];
    if (!row.some(function (cell) { return String(cell || "").trim(); })) continue;
    var first = dedupeV4Norm_(row[0]);
    if (first === "SCHEDULING" || first === "PARCELS") continue;

    var fp = dedupeV4ExactFingerprint_(row);
    if (exact[fp] !== undefined) {
      deleteRows[r + 1] = true;
      continue;
    }
    exact[fp] = r;

    var key = dedupeV4StrongKey_(sheet.getName(), row, map);
    if (!key) continue;
    if (byKey[key] === undefined) {
      byKey[key] = r;
      continue;
    }

    var priorIndex = byKey[key];
    var prior = data[priorIndex];
    if (dedupeV4Subset_(row, prior)) {
      deleteRows[r + 1] = true;
    } else if (dedupeV4Subset_(prior, row)) {
      deleteRows[priorIndex + 1] = true;
      byKey[key] = r;
    } else if (dedupeV4ExactFingerprint_(prior) === fp) {
      deleteRows[r + 1] = true;
    } else {
      conflicts++;
      // Keep both conflicting rows. A strong-key conflict is evidence to
      // reconcile, not permission to discard one side silently.
      if (dedupeV4NonEmptyCount_(row) > dedupeV4NonEmptyCount_(prior)) byKey[key] = r;
    }
  }

  var rows = Object.keys(deleteRows).map(Number).sort(function (a, b) { return b - a; });
  rows.forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
  return { removed: rows.length, conflicts: conflicts };
}

function dedupeAllOperationalSheetsV4() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, skipped: "locked" };
  try {
    var ss = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);
    var result = { ok: true, removed: 0, conflicts: 0, sheets: {} };
    DEDUPLICATION_V4_SHEETS.forEach(function (name) {
      var sheet = ss.getSheetByName(name);
      if (!sheet) return;
      var stats = dedupeOperationalSheetV4_(sheet);
      result.sheets[name] = stats;
      result.removed += stats.removed;
      result.conflicts += stats.conflicts;
    });
    SpreadsheetApp.flush();
    try { writeLog_("DEDUP V4", DEDUPLICATION_V4_VERSION, JSON.stringify(result)); } catch (e) {}
    return result;
  } finally {
    lock.releaseLock();
  }
}

function dedupeV4AuditIdentity_(entry) {
  var r = entry.record || {};
  var source = (entry.meta && entry.meta.permalink) || r._sourceEmail || "";
  var shipment = r.container || r.hbl || r.mbl || r.shipmentNo || r.pro || r.invoice || "";
  var customer = r.customer || "";
  var when = r.shipDate || r.eta || "";
  return [source, entry.kind || "", shipment, customer, when].map(dedupeV4Norm_).join("|");
}

function dedupeV4ExistingAudit_(entry, allowedStatuses) {
  var sheet = ensurePendingSheet_();
  if (sheet.getLastRow() < 2) return false;
  var wanted = dedupeV4AuditIdentity_(entry);
  if (!wanted.replace(/\|/g, "")) return false;
  var start = Math.max(2, sheet.getLastRow() - 999);
  var values = sheet.getRange(start, 1, sheet.getLastRow() - start + 1, VALIDATION.pendingHeaders.length).getDisplayValues();
  var col = {};
  VALIDATION.pendingHeaders.forEach(function (name, index) { col[name] = index; });
  for (var i = values.length - 1; i >= 0; i--) {
    var status = dedupeV4Norm_(values[i][col["Status"]]);
    if (allowedStatuses.indexOf(status) === -1) continue;
    var synthetic = {
      kind: values[i][col["Kind"]],
      record: {
        customer: values[i][col["Customer"]],
        invoice: values[i][col["Invoice / PI"]],
        pro: values[i][col["BL / PRO"]],
        container: values[i][col["Container"]],
        shipDate: values[i][col["Ship Date / ETA"]],
        _sourceEmail: values[i][col["Source Email"]]
      },
      meta: { permalink: values[i][col["Source Email"]] }
    };
    if (dedupeV4AuditIdentity_(synthetic) === wanted) return true;
  }
  return false;
}

function dedupeV4InstallAuditGuards_() {
  if (typeof addPendingRow_ === "function" && !addPendingRow_._dedupeV4) {
    var originalPending = addPendingRow_;
    var wrappedPending = function (entry) {
      if (dedupeV4ExistingAudit_(entry, ["NEEDS REVIEW", "NEEDS CORRECTION", "APPROVED", "COMMITTED"])) return { duplicate: true };
      return originalPending(entry);
    };
    wrappedPending._dedupeV4 = true;
    addPendingRow_ = wrappedPending;
  }

  if (typeof addCommittedAuditRow_ === "function" && !addCommittedAuditRow_._dedupeV4) {
    var originalCommitted = addCommittedAuditRow_;
    var wrappedCommitted = function (entry) {
      if (dedupeV4ExistingAudit_(entry, ["COMMITTED"])) return { duplicate: true };
      return originalCommitted(entry);
    };
    wrappedCommitted._dedupeV4 = true;
    addCommittedAuditRow_ = wrappedCommitted;
  }
  return DEDUPLICATION_V4_VERSION;
}

var DEDUPLICATION_V4_INSTALLED = dedupeV4InstallAuditGuards_();
