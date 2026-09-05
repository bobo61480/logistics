/**
 * FulfillmentSync.gs — StyleKorean US
 * Routes Fulfillment Sheet entries to operational destinations:
 *   - Method "TK"                           → WH Trucking Request sheet
 *   - FedEx / UPS / USPS / Amazon / DHL    → Small Parcels sheet
 *
 * Idempotent — upserts on stable sourceRowRef so repeated runs are safe.
 * Issue: bobo61480/logistics#156
 */

var LOGISTICS_SPREADSHEET_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
// WMS_SPREADSHEET_ID is declared once in Code.gs as a const and read from the
// shared global scope here, as InventorySync.gs and WmsTruckingSyncV2.gs do.
// Re-declaring it with `var` threw "Identifier 'WMS_SPREADSHEET_ID' has already
// been declared" at load time, which fails the WHOLE project — every trigger,
// not just this file.
var FULFILLMENT_SHEET_NAME   = "Fulfillment";
var TRUCKING_SHEET_NAME      = "WH Trucking Request";
var PARCELS_SHEET_NAME       = "Small Parcels";

var PARCEL_CARRIERS  = ["fedex", "ups", "usps", "amazon", "dhl"];
var TERMINAL_STATUSES = ["SHIPPED", "DELIVERED", "RECEIVED", "COMPLETED", "CANCELLED"];

var TRACKING_PATTERNS = [
  { re: /^1Z[A-Z0-9]{16}$/i,              carrier: "UPS"    },
  { re: /^\d{12}$|^\d{15}$|^\d{22}$/,      carrier: "FedEx"  },
  { re: /^94\d{18,20}$|^92\d{18,20}$/,     carrier: "USPS"   },
  { re: /^TBA\d{12,16}$/i,                 carrier: "Amazon" },
  { re: /^\d{10,11}$/,                      carrier: "DHL"    },
];

function syncFulfillmentToOperational() {
  var startTime = new Date();
  var log = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  try {
    var rows = readFulfillmentRows_();
    if (!rows.length) { appendSyncLog_(startTime, log, "No fulfillment rows found"); return; }
    var truckingRows = [], parcelRows = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      try {
        var dest = classifyRow_(row);
        if (dest === "TRUCKING")     truckingRows.push(row);
        else if (dest === "PARCELS") parcelRows.push(row);
        else { console.log("Skipped " + row.sourceRowRef + ": unrecognized '" + row.method + "'"); log.skipped++; }
      } catch (e) { log.errors.push({ ref: row.sourceRowRef, error: e.message }); log.skipped++; }
    }
    syncToTruckingRequest_(truckingRows, log);
    syncToSmallParcels_(parcelRows, log);
  } catch (e) { log.errors.push({ ref: "GLOBAL", error: e.message }); }
  appendSyncLog_(startTime, log, "");
}

function classifyRow_(row) {
  var method = (row.method || "").trim().toUpperCase();
  if (method === "TK") return "TRUCKING";
  if (isParcelCarrier_(method)) return "PARCELS";
  var inferred = inferCarrierFromTracking_(row.trackingNumber);
  if (inferred) { if (!row.carrier) row.carrier = inferred; if (isParcelCarrier_(inferred)) return "PARCELS"; }
  if (row.carrier && isParcelCarrier_(row.carrier)) return "PARCELS";
  return null;
}

function isParcelCarrier_(v) { return PARCEL_CARRIERS.some(function(c) { return (v||"").toLowerCase().indexOf(c) !== -1; }); }

function inferCarrierFromTracking_(tn) {
  if (!tn) return null;
  tn = tn.trim();
  for (var i = 0; i < TRACKING_PATTERNS.length; i++) { if (TRACKING_PATTERNS[i].re.test(tn)) return TRACKING_PATTERNS[i].carrier; }
  return null;
}

function readFulfillmentRows_() {
  var ss = SpreadsheetApp.openById(WMS_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(FULFILLMENT_SHEET_NAME);
  if (!sheet) throw new Error("Fulfillment sheet not found: " + FULFILLMENT_SHEET_NAME);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var raw = data[i];
    var get = function(names) {
      var arr = Array.isArray(names) ? names : [names];
      for (var n = 0; n < arr.length; n++) { var idx = headers.indexOf(arr[n]); if (idx >= 0 && raw[idx] !== "" && raw[idx] !== null && raw[idx] !== undefined) return String(raw[idx]).trim(); }
      return "";
    };
    var customer = get(["customer","company","consignee"]);
    var invoiceNo = get(["invoice no","invoice","invoice #","po#","po number"]);
    var method = get(["method","shipping method","ship method"]);
    var carrier = get(["carrier","carrier name"]);
    var trackingNo = get(["tracking #","tracking number","tracking","pro #","pro number"]);
    var shipDate = get(["ship date","ship-out date","shipdate","shipped date"]);
    var eta = get(["eta","estimated delivery","delivery date"]);
    var address = get(["address","delivery address","ship to address","ship to"]);
    var qty = get(["qty","quantity","total qty"]);
    var amount = get(["amount","invoice amount","total amount","value"]);
    var status = get(["status","shipment status"]);
    if (!customer && !invoiceNo && !method) continue;
    rows.push({
      sourceRowRef: "row_" + (i + 1), customer: customer, invoiceNo: invoiceNo,
      method: method, carrier: carrier, trackingNumber: trackingNo,
      shipDate: normalizeDate_(raw[headers.indexOf("ship date")] || raw[headers.indexOf("shipdate")] || null, shipDate),
      eta: normalizeDate_(null, eta), address: address,
      qty: parseQty_(qty), amount: parseAmount_(amount), status: status,
    });
  }
  return rows;
}

function syncToTruckingRequest_(rows, log) {
  if (!rows.length) return;
  var ss = SpreadsheetApp.openById(LOGISTICS_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(TRUCKING_SHEET_NAME);
  if (!sheet) throw new Error("WH Trucking Request sheet not found");
  var headers = getSheetHeaders_(sheet);
  var groups = groupTruckingRows_(rows);
  for (var gi = 0; gi < groups.length; gi++) {
    var group = groups[gi];
    var existingRowIdx = findTruckingRow_(sheet, headers, group);
    if (existingRowIdx !== -1) {
      var statusCol = headers.indexOf("status");
      var existingStatus = statusCol >= 0 ? String(sheet.getRange(existingRowIdx, statusCol + 1).getValue()).toUpperCase() : "";
      if (TERMINAL_STATUSES.indexOf(existingStatus) !== -1) { log.skipped++; continue; }
      writeTruckingRow_(sheet, existingRowIdx, headers, group); log.updated++;
    } else { appendTruckingRow_(sheet, headers, group); log.inserted++; }
  }
}

function groupTruckingRows_(rows) {
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var key = [(row.customer||"").toUpperCase().trim(), (row.shipDate||"").trim(), (row.address||"").toUpperCase().trim()].join("|~|");
    if (!map[key]) { map[key] = { customer: row.customer, invoiceNos: row.invoiceNo ? [row.invoiceNo] : [], method: row.method, carrier: row.carrier, trackingNumber: row.trackingNumber, shipDate: row.shipDate, eta: row.eta, address: row.address, qty: row.qty||0, amount: row.amount||0, sourceRowRef: row.sourceRowRef, status: row.status }; }
    else { var g = map[key]; if (row.invoiceNo && g.invoiceNos.indexOf(row.invoiceNo) === -1) g.invoiceNos.push(row.invoiceNo); g.qty += (row.qty||0); g.amount += (row.amount||0); g.sourceRowRef += "," + row.sourceRowRef; }
  }
  return Object.keys(map).map(function(k) { var g = map[k]; g.invoiceNo = g.invoiceNos.join(", "); return g; });
}

function findTruckingRow_(sheet, headers, group) {
  var data = sheet.getDataRange().getValues();
  var custCol = headers.indexOf("customer"), dateCol = headers.indexOf("ship date"), addrCol = headers.indexOf("address");
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][custCol]||"").toUpperCase().trim() === (group.customer||"").toUpperCase().trim() &&
        normalizeDate_(data[i][dateCol], String(data[i][dateCol]||"")) === (group.shipDate||"").trim() &&
        String(data[i][addrCol]||"").toUpperCase().trim() === (group.address||"").toUpperCase().trim()) return i + 1;
  }
  return -1;
}

function writeTruckingRow_(sheet, rowIdx, headers, group) {
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MM/dd/yy HH:mm");
  setCell_(sheet, rowIdx, headers, "customer", group.customer); setCell_(sheet, rowIdx, headers, "invoice no", group.invoiceNo);
  setCell_(sheet, rowIdx, headers, "ship date", group.shipDate); setCell_(sheet, rowIdx, headers, "address", group.address||"");
  setCell_(sheet, rowIdx, headers, "carrier", group.carrier||"TK"); setCell_(sheet, rowIdx, headers, "tracking #", group.trackingNumber||"");
  setCell_(sheet, rowIdx, headers, "qty", group.qty>0?group.qty:""); setCell_(sheet, rowIdx, headers, "amount", group.amount>0?group.amount:"");
  setCell_(sheet, rowIdx, headers, "source ref", group.sourceRowRef); setCell_(sheet, rowIdx, headers, "last synced", now);
}

function appendTruckingRow_(sheet, headers, group) {
  var newRow = new Array(headers.length).fill(""), now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MM/dd/yy HH:mm");
  setArr_(newRow, headers, "customer", group.customer); setArr_(newRow, headers, "invoice no", group.invoiceNo);
  setArr_(newRow, headers, "ship date", group.shipDate); setArr_(newRow, headers, "address", group.address||"");
  setArr_(newRow, headers, "carrier", group.carrier||"TK"); setArr_(newRow, headers, "tracking #", group.trackingNumber||"");
  setArr_(newRow, headers, "qty", group.qty>0?group.qty:""); setArr_(newRow, headers, "amount", group.amount>0?group.amount:"");
  setArr_(newRow, headers, "source ref", group.sourceRowRef); setArr_(newRow, headers, "last synced", now);
  sheet.appendRow(newRow);
}

function syncToSmallParcels_(rows, log) {
  if (!rows.length) return;
  var ss = SpreadsheetApp.openById(LOGISTICS_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PARCELS_SHEET_NAME);
  if (!sheet) throw new Error("Small Parcels sheet not found");
  var headers = getSheetHeaders_(sheet);
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i], existingRowIdx = findParcelRow_(sheet, headers, row);
    if (existingRowIdx !== -1) {
      var statusCol = headers.indexOf("status");
      var existingStatus = statusCol >= 0 ? String(sheet.getRange(existingRowIdx, statusCol+1).getValue()).toUpperCase() : "";
      if (TERMINAL_STATUSES.indexOf(existingStatus) !== -1) { log.skipped++; continue; }
      writeParcelRow_(sheet, existingRowIdx, headers, row); log.updated++;
    } else { appendParcelRow_(sheet, headers, row); log.inserted++; }
  }
}

function findParcelRow_(sheet, headers, row) {
  if (row.trackingNumber) {
    var data = sheet.getDataRange().getValues(), trackCol = headers.indexOf("tracking #");
    if (trackCol >= 0) for (var i = 1; i < data.length; i++) if (String(data[i][trackCol]).trim() === row.trackingNumber.trim()) return i + 1;
  }
  var data2 = sheet.getDataRange().getValues(), custCol = headers.indexOf("customer"), invCol = headers.indexOf("invoice no"), dateCol = headers.indexOf("ship date");
  for (var j = 1; j < data2.length; j++) {
    if (String(data2[j][custCol]||"").trim() === (row.customer||"").trim() &&
        String(data2[j][invCol]||"").trim()  === (row.invoiceNo||"").trim() &&
        normalizeDate_(data2[j][dateCol], String(data2[j][dateCol]||"")) === (row.shipDate||"")) return j + 1;
  }
  return -1;
}

function writeParcelRow_(sheet, rowIdx, headers, row) {
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MM/dd/yy HH:mm");
  setCell_(sheet, rowIdx, headers, "customer", row.customer); setCell_(sheet, rowIdx, headers, "invoice no", row.invoiceNo);
  setCell_(sheet, rowIdx, headers, "carrier", row.carrier); setCell_(sheet, rowIdx, headers, "tracking #", row.trackingNumber||"");
  setCell_(sheet, rowIdx, headers, "ship date", row.shipDate); setCell_(sheet, rowIdx, headers, "eta", row.eta||"");
  setCell_(sheet, rowIdx, headers, "address", row.address||""); setCell_(sheet, rowIdx, headers, "qty", row.qty>0?row.qty:"");
  setCell_(sheet, rowIdx, headers, "amount", row.amount>0?row.amount:""); setCell_(sheet, rowIdx, headers, "status", row.status||"");
  setCell_(sheet, rowIdx, headers, "source ref", row.sourceRowRef); setCell_(sheet, rowIdx, headers, "last synced", now);
}

function appendParcelRow_(sheet, headers, row) {
  var newRow = new Array(headers.length).fill(""), now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MM/dd/yy HH:mm");
  setArr_(newRow, headers, "customer", row.customer); setArr_(newRow, headers, "invoice no", row.invoiceNo);
  setArr_(newRow, headers, "carrier", row.carrier); setArr_(newRow, headers, "tracking #", row.trackingNumber||"");
  setArr_(newRow, headers, "ship date", row.shipDate); setArr_(newRow, headers, "eta", row.eta||"");
  setArr_(newRow, headers, "address", row.address||""); setArr_(newRow, headers, "qty", row.qty>0?row.qty:"");
  setArr_(newRow, headers, "amount", row.amount>0?row.amount:""); setArr_(newRow, headers, "status", row.status||"");
  setArr_(newRow, headers, "source ref", row.sourceRowRef); setArr_(newRow, headers, "last synced", now);
  sheet.appendRow(newRow);
}

function appendSyncLog_(startTime, log, note) {
  try {
    var ss = SpreadsheetApp.openById(LOGISTICS_SPREADSHEET_ID);
    var logSheet = ss.getSheetByName("Sync Log");
    if (!logSheet) { logSheet = ss.insertSheet("Sync Log"); logSheet.appendRow(["Timestamp","Duration (s)","Inserted","Updated","Skipped","Errors","Note"]); }
    var duration = ((new Date() - startTime) / 1000).toFixed(1);
    logSheet.appendRow([Utilities.formatDate(startTime, Session.getScriptTimeZone(), "MM/dd/yy HH:mm:ss"), parseFloat(duration), log.inserted, log.updated, log.skipped, log.errors.map(function(e){return e.ref+": "+e.error;}).join(" | ")||"", note||""]);
  } catch(e) { console.error("Sync log failed: " + e.message); }
}

function installFulfillmentSyncTrigger() {
  ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==="syncFulfillmentToOperational";}).forEach(function(t){ScriptApp.deleteTrigger(t);});
  ScriptApp.newTrigger("syncFulfillmentToOperational").timeBased().everyMinutes(15).create();
  console.log("Trigger installed: syncFulfillmentToOperational every 15 minutes");
}

function getSheetHeaders_(sheet) { return sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(function(h){return String(h).trim().toLowerCase();}); }
function setCell_(sheet, rowIdx, headers, col, val) { var idx = headers.indexOf(col); if (idx>=0) sheet.getRange(rowIdx, idx+1).setValue(val!==undefined?val:""); }
function setArr_(arr, headers, col, val) { var idx = headers.indexOf(col); if (idx>=0) arr[idx] = val!==undefined?val:""; }

function normalizeDate_(raw, str) {
  var s = (str||"").trim(); if (!s) return "";
  if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(s)) return s;
  var long = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (long) return long[1]+"/"+long[2]+"/"+long[3].slice(2);
  if (raw instanceof Date && !isNaN(raw.getTime())) return Utilities.formatDate(raw, Session.getScriptTimeZone(), "MM/dd/yy");
  if (typeof raw === "number" && raw > 40000) { var d = new Date((raw-25569)*86400*1000); return Utilities.formatDate(d, Session.getScriptTimeZone(), "MM/dd/yy"); }
  var parsed = new Date(s); if (!isNaN(parsed.getTime())) return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "MM/dd/yy");
  return s;
}

function parseQty_(val) { var n = parseFloat(String(val).replace(/[^0-9.]/g,"")); return isNaN(n)?0:n; }
function parseAmount_(val) { var n = parseFloat(String(val).replace(/[^0-9.]/g,"")); return isNaN(n)?0:n; }
