/*
 * WmsLocationSafetyV5.gs
 *
 * Production guard for WH Trucking Request.
 *
 * Rules:
 *  - customer + ship date alone is never enough to merge freight when a
 *    destination/location is known;
 *  - Yixi/Fanloli's Stonestown, Hillsdale/Readyspaces, Japan Center, and
 *    Chinatown locations are four distinct delivery identities;
 *  - repeated copies of the same invoice/date/location are removed without
 *    collapsing split loads with different PROs or different locations;
 *  - a 15-minute safety sweep protects the sheet even if a legacy/external
 *    writer appends a duplicate outside the canonical V2 importer.
 */
/* eslint-disable no-unused-vars */

var WMS_LOCATION_SAFETY_V5_VERSION = "2026-08-31-v5-yixi-location-aware";
var WMS_LOCATION_TARGET_BY_ROW_INVOICE_V5 = {};

function whLocationNormV5_(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim();
}

function whYixiLocationAliasV5_(value) {
  var text = whLocationNormV5_(value);
  if (!text) return "";
  if (/STONESTOWN|3251 20TH/.test(text)) return "STONESTOWN GALLERIA";
  if (/HILLSDALE|READYSPACE|245 S SPRUCE/.test(text)) return "HILLSDALE READYSPACES";
  if (/JAPAN CENTER|1737 POST/.test(text)) return "JAPAN CENTER";
  if (/CHINATOWN|953 GRANT/.test(text)) return "CHINATOWN";
  return "";
}

function whLocationIdentityV5_(customer, address, store, note) {
  var customerKey = whLocationNormV5_(customer);
  var combined = [store, address, note].map(whLocationNormV5_).filter(Boolean).join(" | ");
  if (/YIXI|FANLOLI/.test(customerKey)) {
    var yixi = whYixiLocationAliasV5_(combined);
    if (yixi) return "YIXI:" + yixi;
  }
  return whLocationNormV5_(store) || whLocationNormV5_(address) || "";
}

function whLocationFromGroupKeyV5_(groupKey) {
  var text = String(groupKey || "");
  var marker = "___DEST_";
  var index = text.indexOf(marker);
  return index === -1 ? "" : whLocationNormV5_(text.slice(index + marker.length));
}

function whInvoiceTokensV5_(value) {
  return String(value || "").toUpperCase().split(/[\r\n,;·/]+/).map(function (item) {
    return item.trim();
  }).filter(Boolean).sort();
}

function whDedupeKeyV5_(row, map) {
  var customer = map["CUSTOMER"] !== undefined ? row[map["CUSTOMER"]] : "";
  var invoice = map["INVOICE NO"] !== undefined ? row[map["INVOICE NO"]] : "";
  var shipDate = map["SHIP DATE"] !== undefined ? row[map["SHIP DATE"]] : "";
  var address = map["ADDRESS"] !== undefined ? row[map["ADDRESS"]] : "";
  var store = map["LOCATION STORE"] !== undefined ? row[map["LOCATION STORE"]] : "";
  var note = map["NOTE"] !== undefined ? row[map["NOTE"]] : "";
  var pro = map["PRO"] !== undefined ? row[map["PRO"]] : "";
  var invoices = whInvoiceTokensV5_(invoice);
  if (!customer || !shipDate || !invoices.length) return "";
  var location = whLocationIdentityV5_(customer, address, store, note);
  return [whLocationNormV5_(customer), whLocationNormV5_(shipDate), invoices.join("+"), location, whLocationNormV5_(pro)].join("|");
}

function whRowSubsetV5_(sparse, rich) {
  var width = Math.max(sparse.length, rich.length);
  var hasValue = false;
  for (var c = 0; c < width; c++) {
    var a = whLocationNormV5_(sparse[c]);
    var b = whLocationNormV5_(rich[c]);
    if (!a) continue;
    hasValue = true;
    if (!b || a !== b) return false;
  }
  return hasValue;
}

function whNonEmptyV5_(row) {
  return row.reduce(function (count, cell) { return count + (String(cell || "").trim() ? 1 : 0); }, 0);
}

function whHeaderMapV5_(header) {
  var map = {};
  (header || []).forEach(function (value, index) {
    var key = whLocationNormV5_(value);
    if (key && map[key] === undefined) map[key] = index;
  });
  return map;
}

function whFindHeaderIndexV5_(data) {
  for (var r = 0; r < Math.min(data.length, 8); r++) {
    var normalized = (data[r] || []).map(whLocationNormV5_);
    if (normalized.indexOf("CUSTOMER") !== -1 && normalized.indexOf("INVOICE NO") !== -1 && normalized.indexOf("SHIP DATE") !== -1) return r;
  }
  return 1;
}

function dedupeWhTruckingLocationSafeV5_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName("WH Trucking Request");
  if (!sheet || sheet.getLastRow() < 3) return { removed: 0, conflicts: 0 };
  var data = sheet.getDataRange().getDisplayValues();
  var headerIndex = whFindHeaderIndexV5_(data);
  var map = whHeaderMapV5_(data[headerIndex] || []);
  var keeperByKey = {};
  var deleteRows = {};
  var conflicts = 0;

  for (var r = headerIndex + 1; r < data.length; r++) {
    var row = data[r];
    var key = whDedupeKeyV5_(row, map);
    if (!key) continue;
    if (keeperByKey[key] === undefined) {
      keeperByKey[key] = r;
      continue;
    }
    var priorIndex = keeperByKey[key];
    var prior = data[priorIndex];
    var rowSubset = whRowSubsetV5_(row, prior);
    var priorSubset = whRowSubsetV5_(prior, row);
    if (rowSubset) {
      deleteRows[r + 1] = true;
    } else if (priorSubset) {
      deleteRows[priorIndex + 1] = true;
      keeperByKey[key] = r;
    } else {
      conflicts++;
      if (whNonEmptyV5_(row) > whNonEmptyV5_(prior)) keeperByKey[key] = r;
    }
  }

  Object.keys(deleteRows).map(Number).sort(function (a, b) { return b - a; }).forEach(function (rowNumber) {
    sheet.deleteRow(rowNumber);
  });
  SpreadsheetApp.flush();
  return { removed: Object.keys(deleteRows).length, conflicts: conflicts };
}

function dedupeWhTruckingLocationSafeV5() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, skipped: "locked" };
  try {
    var result = dedupeWhTruckingLocationSafeV5_();
    try { logPipeline_("WH TRUCKING LOCATION DEDUPE", WMS_LOCATION_SAFETY_V5_VERSION, JSON.stringify(result)); } catch (ignored) {}
    return { ok: true, removed: result.removed, conflicts: result.conflicts };
  } finally {
    lock.releaseLock();
  }
}

function whBuildTargetLocationIndexV5_() {
  WMS_LOCATION_TARGET_BY_ROW_INVOICE_V5 = {};
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName("WH Trucking Request");
  if (!sheet || sheet.getLastRow() < 3) return WMS_LOCATION_TARGET_BY_ROW_INVOICE_V5;
  var data = sheet.getDataRange().getDisplayValues();
  var headerIndex = whFindHeaderIndexV5_(data);
  var map = whHeaderMapV5_(data[headerIndex] || []);
  for (var r = headerIndex + 1; r < data.length; r++) {
    var row = data[r];
    var customer = map["CUSTOMER"] !== undefined ? row[map["CUSTOMER"]] : "";
    var address = map["ADDRESS"] !== undefined ? row[map["ADDRESS"]] : "";
    var store = map["LOCATION STORE"] !== undefined ? row[map["LOCATION STORE"]] : "";
    var note = map["NOTE"] !== undefined ? row[map["NOTE"]] : "";
    var location = whLocationIdentityV5_(customer, address, store, note);
    var invoiceCell = map["INVOICE NO"] !== undefined ? row[map["INVOICE NO"]] : "";
    whInvoiceTokensV5_(invoiceCell).forEach(function (invoice) {
      WMS_LOCATION_TARGET_BY_ROW_INVOICE_V5[(r + 1) + "|" + invoice] = location;
    });
  }
  return WMS_LOCATION_TARGET_BY_ROW_INVOICE_V5;
}

function whBackfillLocationStoreV5_() {
  if (typeof WMS_SPREADSHEET_ID === "undefined" || typeof SPREADSHEET_ID === "undefined") return 0;
  var sourceSpreadsheet = SpreadsheetApp.openById(WMS_SPREADSHEET_ID);
  var targetSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sourceSheet = sourceSpreadsheet.getSheetByName("Stylekorean");
  var targetSheet = targetSpreadsheet.getSheetByName("WH Trucking Request");
  if (!sourceSheet || !targetSheet) return 0;

  var sourceData = sourceSheet.getDataRange().getDisplayValues();
  var sourceHeader = findWmsTruckingHeader_(sourceData);
  var sourceMap = sourceHeader.map;
  var destinationByInvoice = {};
  for (var s = sourceHeader.rowIndex + 1; s < sourceData.length; s++) {
    var sourceRow = sourceData[s];
    var method = sourceMap["SHIPPING METHOD"] !== undefined ? String(sourceRow[sourceMap["SHIPPING METHOD"]] || "").trim().toUpperCase() : "";
    if (typeof isWmsFreightMethod_ === "function" && !isWmsFreightMethod_(method)) continue;
    var invoice = sourceMap["INVOICE#"] !== undefined ? String(sourceRow[sourceMap["INVOICE#"]] || "").trim().toUpperCase() : "";
    if (!invoice) continue;
    var destination = wmsDestinationHint_(sourceRow, sourceMap);
    if (destination) destinationByInvoice[invoice] = destination;
  }

  var targetData = targetSheet.getDataRange().getDisplayValues();
  var headerIndex = whFindHeaderIndexV5_(targetData);
  var targetMap = whHeaderMapV5_(targetData[headerIndex] || []);
  if (targetMap["LOCATION STORE"] === undefined || targetMap["INVOICE NO"] === undefined) return 0;
  var changed = 0;
  for (var t = headerIndex + 1; t < targetData.length; t++) {
    var targetRow = targetData[t];
    if (String(targetRow[targetMap["LOCATION STORE"]] || "").trim()) continue;
    var invoices = whInvoiceTokensV5_(targetRow[targetMap["INVOICE NO"]]);
    var destinations = {};
    invoices.forEach(function (invoiceNo) {
      var destination = destinationByInvoice[invoiceNo];
      if (destination) destinations[destination] = true;
    });
    var keys = Object.keys(destinations);
    if (keys.length !== 1) continue;
    targetSheet.getRange(t + 1, targetMap["LOCATION STORE"] + 1).setValue(keys[0]);
    changed++;
  }
  if (changed) SpreadsheetApp.flush();
  return changed;
}

var WMS_LOCATION_BASE_DEST_NORMALIZER_V5 = typeof normalizeWmsDestinationHint_ === "function" ? normalizeWmsDestinationHint_ : null;
if (WMS_LOCATION_BASE_DEST_NORMALIZER_V5) {
  normalizeWmsDestinationHint_ = function (value) {
    var yixi = whYixiLocationAliasV5_(value);
    return yixi || WMS_LOCATION_BASE_DEST_NORMALIZER_V5(value);
  };
}

if (typeof wmsInvoiceSignatureFromKey_ === "function") {
  wmsInvoiceSignatureFromKey_ = function (groupKey, invoice) {
    var cleanInvoice = String(invoice || "").trim().toUpperCase();
    if (!groupKey || !cleanInvoice) return "";
    return String(groupKey) + "___INV_" + cleanInvoice;
  };
}

var WMS_LOCATION_BASE_CHOOSE_V5 = typeof chooseWmsTargetRow_ === "function" ? chooseWmsTargetRow_ : null;
if (WMS_LOCATION_BASE_CHOOSE_V5) {
  chooseWmsTargetRow_ = function (groupKey, invoices, rows) {
    var desired = whLocationFromGroupKeyV5_(groupKey);
    if (!desired) return WMS_LOCATION_BASE_CHOOSE_V5(groupKey, invoices, rows);
    var wanted = {};
    (invoices || []).forEach(function (invoice) { wanted[String(invoice || "").trim().toUpperCase()] = true; });
    var filtered = (rows || []).filter(function (row) {
      var matchedInvoice = "";
      for (var i = 0; i < (row.invoices || []).length; i++) {
        var candidate = String(row.invoices[i] || "").trim().toUpperCase();
        if (wanted[candidate]) { matchedInvoice = candidate; break; }
      }
      if (!matchedInvoice) return true;
      var actual = WMS_LOCATION_TARGET_BY_ROW_INVOICE_V5[row.rowNumber + "|" + matchedInvoice] || "";
      return !actual || actual === desired || actual === ("YIXI:" + desired);
    });
    return WMS_LOCATION_BASE_CHOOSE_V5(groupKey, invoices, filtered);
  };
}

var WMS_LOCATION_BASE_SCAN_V5 = typeof scanAndImportWmsTruckingOrdersV2 === "function" ? scanAndImportWmsTruckingOrdersV2 : null;
if (WMS_LOCATION_BASE_SCAN_V5) {
  scanAndImportWmsTruckingOrdersV2 = function () {
    whBuildTargetLocationIndexV5_();
    var result = WMS_LOCATION_BASE_SCAN_V5.apply(this, arguments);
    try { whBackfillLocationStoreV5_(); } catch (backfillError) { Logger.log("Location backfill failed: " + backfillError.message); }
    try { dedupeWhTruckingLocationSafeV5_(); } catch (dedupeError) { Logger.log("Location-safe dedupe failed: " + dedupeError.message); }
    return result;
  };
}

if (typeof TRIGGER_PLAN !== "undefined") {
  var hasLocationDedupeV5 = TRIGGER_PLAN.some(function (item) { return item.handler === "dedupeWhTruckingLocationSafeV5"; });
  if (!hasLocationDedupeV5) TRIGGER_PLAN.push({ handler: "dedupeWhTruckingLocationSafeV5", minutes: 15 });
}
if (typeof TRIGGER_CLEANUP_HANDLERS !== "undefined" && TRIGGER_CLEANUP_HANDLERS.indexOf("dedupeWhTruckingLocationSafeV5") === -1) {
  TRIGGER_CLEANUP_HANDLERS.push("dedupeWhTruckingLocationSafeV5");
}
if (typeof GMAIL_PIPELINE_TRIGGER_SYNC_VERSION !== "undefined") {
  GMAIL_PIPELINE_TRIGGER_SYNC_VERSION = "2026-08-31-central-v6-yixi-location-safe";
}
