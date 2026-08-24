/**
 * InventorySync.gs — live Inventory Management module + KPI dashboard
 *
 * Relationally links two raw inventory workbooks to LOGISTICS MASTER 2026:
 *
 *  A. ALLOCATION workbook (17e5EYNMr3sTPhMfFVYBg3dQDC7CWxk2StwHzt_W55dY)
 *     Per-shipment SKU allocation tabs:
 *     SKU · Product Name · Brand · Barcode · Cnfm Qty · 잔여수량 (remaining)
 *     · channel columns (CAWH / iHerb / National / BK / US_Official / Moida / NY)
 *
 *  B. WMS workbook (1tNBa7c78MGL3wBNwYsDdHcHnJZFcvxrLzn_M79vN4WY)
 *     - Live stock snapshot: SKU · Location · Expiry · Total/Actual/Hold/Avail Qty
 *     - Container receiving log: Type · 차수 · PC · 입고일 · 검수 완료일
 *     - Per-container putaway tabs keyed by PI NO. / PLT NO.
 *
 * Join model:
 *   SKU (상품코드)  → product-level join across A, B, and outbound demand
 *   차수 / PC no.  → container-level join between B's receiving log and
 *                    the IMPORTS inbound schedule in LOGISTICS MASTER
 *
 * Outputs (written into LOGISTICS MASTER 2026, read live by the website):
 *   - "INVENTORY" tab      : one row per SKU (on hand + incoming + allocation)
 *   - "KPI DASHBOARD" tab  : label/value metric block, updated each run
 */

/* eslint-disable no-unused-vars */

var INVENTORY_SYNC = {
  masterId: "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc",
  allocationId: "17e5EYNMr3sTPhMfFVYBg3dQDC7CWxk2StwHzt_W55dY",
  wmsId: "1tNBa7c78MGL3wBNwYsDdHcHnJZFcvxrLzn_M79vN4WY",
  inventoryTab: "INVENTORY",
  kpiTab: "KPI DASHBOARD",
  importsTab: "IMPORTS",
  runBudgetMs: 4.5 * 60 * 1000, // stay under the 6-minute Apps Script limit
  lowStockThreshold: 50
};

/** Entry point — run hourly from a time-driven trigger. */
function syncInventoryModule() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  var startedAt = Date.now();
  try {
    var incoming = readAllocationIncoming_(startedAt);   // SKU -> incoming/allocated (heaviest read goes first)
    var stock = readWmsStockSnapshot_();                 // SKU -> on-hand
    var containers = readWmsContainerLog_();             // 차수 -> receiving status
    writeInventoryTab_(stock, incoming, containers);
    updateKpiDashboard_(stock, incoming, containers);
    logPipeline_("INVENTORY SYNC", "ok",
      Object.keys(stock.bySku).length + " stocked SKUs · " +
      Object.keys(incoming.bySku).length + " inbound SKUs · " +
      containers.rows.length + " containers · " + (incoming.partial ? "PARTIAL (time budget)" : "full"));
  } catch (err) {
    logPipeline_("INVENTORY SYNC ERROR", "", String(err && err.message || err));
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Readers                                                             */
/* ------------------------------------------------------------------ */

/** Finds the live stock tab in the WMS workbook by its header signature. */
function readWmsStockSnapshot_() {
  var ss = SpreadsheetApp.openById(INVENTORY_SYNC.wmsId);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    if (sheet.getLastRow() < 2) continue;
    var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
      .map(function (c) { return String(c || "").trim().toUpperCase(); });
    if (header.indexOf("SKU") !== -1 && header.indexOf("AVAIL QTY") !== -1) {
      var col = {};
      header.forEach(function (h, idx) { col[h] = idx; });
      var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getDisplayValues();
      var bySku = {};
      rows.forEach(function (row) {
        var sku = String(row[col["SKU"]] || "").trim();
        if (!sku) return;
        var entry = bySku[sku] || (bySku[sku] = {
          name: "", brand: "", barcode: "", total: 0, actual: 0, hold: 0, avail: 0, locations: [], nearestExpiry: ""
        });
        entry.name = entry.name || String(row[col["PRODUCT NAME"]] || "");
        entry.brand = entry.brand || String(row[col["BRAND"]] || "");
        entry.barcode = entry.barcode || String(row[col["PRODUCT BARCODE"]] || "");
        entry.total += num_(row[col["TOTAL QTY"]]);
        entry.actual += num_(row[col["ACTUAL QTY"]]);
        entry.hold += num_(row[col["HOLD(PICKED)"]]) + num_(row[col["HOLD(REQ)"]]);
        entry.avail += num_(row[col["AVAIL QTY"]]);
        var loc = String(row[col["LOCATION"]] || "").trim();
        if (loc && entry.locations.indexOf(loc) === -1) entry.locations.push(loc);
        var expiry = String(row[col["EXPIRY DATE"]] || "").trim();
        if (expiry && (!entry.nearestExpiry || expiry < entry.nearestExpiry)) entry.nearestExpiry = expiry;
      });
      return { bySku: bySku, sheetName: sheet.getName() };
    }
  }
  throw new Error("WMS stock snapshot tab (SKU + Avail Qty headers) not found.");
}

/**
 * Reads the container receiving log (Type · 차수 · PC · 입고일 · 검수 완료일).
 * The header may not be on row 1 and column labels vary slightly, so this
 * scans the first 3 rows of the first 15 tabs for a row containing 차수.
 */
function readWmsContainerLog_() {
  var ss = SpreadsheetApp.openById(INVENTORY_SYNC.wmsId);
  var sheets = ss.getSheets();
  for (var i = 0; i < Math.min(sheets.length, 15); i++) {
    var sheet = sheets[i];
    if (sheet.getLastRow() < 2) continue;
    var scan = sheet.getRange(1, 1, Math.min(3, sheet.getLastRow()), sheet.getLastColumn()).getDisplayValues();
    for (var h = 0; h < scan.length; h++) {
      var header = scan[h].map(function (c) { return String(c || "").trim(); });
      if (header.indexOf("차수") === -1) continue;
      var col = {};
      header.forEach(function (name, idx) { if (name && col[name] === undefined) col[name] = idx; });
      var pick = function (row, names) {
        for (var n = 0; n < names.length; n++) {
          if (col[names[n]] !== undefined) return String(row[col[names[n]]] || "").trim();
        }
        return "";
      };
      var startRow = h + 2;
      if (sheet.getLastRow() < startRow) break;
      var rows = sheet.getRange(startRow, 1, sheet.getLastRow() - startRow + 1, sheet.getLastColumn()).getDisplayValues()
        .filter(function (row) { return String(row[col["차수"]] || "").trim(); })
        .map(function (row) {
          return {
            type: pick(row, ["Type", "TYPE"]) || String(row[0] || "").trim(),
            shipmentCode: String(row[col["차수"]] || "").trim(),      // e.g. "TW 12", "HJ 31"
            pcNumber: pick(row, ["PC", "PC#", "PC NO", "PC NO."]),    // e.g. "PC00146273"
            receivedDate: pick(row, ["입고일", "입고 일", "입고일자"]),
            qcDoneDate: pick(row, ["검수 완료일", "검수완료일", "검수 완료"]),
            remark: pick(row, ["WHS REMARK", "REMARK", "비고"])
          };
        });
      var byCode = {};
      rows.forEach(function (r) { byCode[r.shipmentCode.toUpperCase()] = r; });
      return { rows: rows, byCode: byCode, sheetName: sheet.getName() };
    }
  }
  return { rows: [], byCode: {}, sheetName: "" };
}

/**
 * Aggregates the allocation workbook: per SKU, confirmed inbound quantity,
 * remaining-to-receive (잔여수량), and channel allocation summary.
 * Tab names are treated as shipment identifiers.
 * Skips tabs whose shipment is already delivered/completed in IMPORTS.
 * Respects the script run budget; sets partial=true when it had to stop early.
 */
function readAllocationIncoming_(startedAt) {
  var CHANNELS = ["CAWH", "IHERB", "HQ IHERB PO", "NATIONAL", "BK", "US_OFFICIAL", "MOIDA", "NY"];
<<<<<<< HEAD
<<<<<<< HEAD
  var completedShipments = getCompletedImportShipments_();
=======
  var activeShipments = getActiveImportShipments_();
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
  var activeShipments = getActiveImportShipments_();
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
  var ss = SpreadsheetApp.openById(INVENTORY_SYNC.allocationId);
  var sheets = ss.getSheets();
  var bySku = {};
  var partial = false;

  var allocBudgetMs = INVENTORY_SYNC.runBudgetMs - 60 * 1000; // reserve a minute for WMS reads + writes
  for (var s = 0; s < sheets.length; s++) {
    if (Date.now() - startedAt > allocBudgetMs) { partial = true; break; }
    var sheet = sheets[s];
    if (sheet.getLastRow() < 2 || sheet.getLastColumn() < 4) continue;
    if (sheet.getLastColumn() > 40) continue; // skip the wide per-shipment tracker tab
<<<<<<< HEAD
<<<<<<< HEAD
    if (completedShipments.has(sheet.getName().trim().toUpperCase())) continue;
=======
    if (!allocationSheetMatchesActiveImport_(sheet.getName(), activeShipments)) continue;
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
    if (!allocationSheetMatchesActiveImport_(sheet.getName(), activeShipments)) continue;
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481

    var data = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 300), Math.min(sheet.getLastColumn(), 16)).getDisplayValues();
    // Header can be on row 1 or 2; require SKU + Cnfm Qty to treat the tab as an allocation sheet.
    var headerIdx = -1, col = {};
    for (var r = 0; r < Math.min(3, data.length); r++) {
      var upper = data[r].map(function (c) { return String(c || "").trim().toUpperCase(); });
      if (upper.indexOf("SKU") !== -1 && (upper.indexOf("CNFM QTY") !== -1 || upper.indexOf("잔여수량") !== -1)) {
        headerIdx = r;
        upper.forEach(function (h, idx) { if (h && col[h] === undefined) col[h] = idx; });
        break;
      }
    }
    if (headerIdx === -1) continue;

    var shipment = sheet.getName();
    for (var i = headerIdx + 1; i < data.length; i++) {
      var row = data[i];
      var sku = String(row[col["SKU"]] || "").trim();
      if (!sku) continue;
      var entry = bySku[sku] || (bySku[sku] = {
        name: "", brand: "", barcode: "", confirmed: 0, remaining: 0, shipments: [], channels: {}
      });
      entry.name = entry.name || String(col["PRODUCT NAME"] !== undefined ? row[col["PRODUCT NAME"]] : "");
      entry.brand = entry.brand || String(col["BRAND"] !== undefined ? row[col["BRAND"]] : "");
      entry.barcode = entry.barcode || String(col["BARCODE"] !== undefined ? row[col["BARCODE"]] : "");
      entry.confirmed += num_(col["CNFM QTY"] !== undefined ? row[col["CNFM QTY"]] : 0);
      var remaining = num_(col["잔여수량"] !== undefined ? row[col["잔여수량"]] : 0);
      entry.remaining += remaining;
      if (remaining > 0 && entry.shipments.indexOf(shipment) === -1) entry.shipments.push(shipment);
      CHANNELS.forEach(function (channel) {
        if (col[channel] === undefined) return;
        var qty = channelQty_(row[col[channel]]);
        if (qty) entry.channels[channel] = (entry.channels[channel] || 0) + qty;
      });
    }
  }
  return { bySku: bySku, partial: partial };
}

/** Channel cells look like "30 (iHerb)", "50 (NY)", or plain numbers. */
function channelQty_(value) {
  var m = String(value || "").match(/([\d,]+)/);
  return m ? num_(m[1]) : 0;
}

<<<<<<< HEAD
<<<<<<< HEAD
var TERMINAL_STATUSES_ = new Set(["SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED"]);
=======
var TERMINAL_STATUSES_ = new Set(["DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED", "FINISHED", "CLOSED", "PUTAWAY"]);
var IMPORT_CUTOFF_DATE_ = new Date(2026, 6, 1); // July 1, 2026 (local script time)
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481

/**
 * Builds an allow-list from IMPORTS. Only non-grey, non-terminal shipments
 * dated July 1, 2026 or later are eligible to contribute inbound inventory.
 */
function findImportSectionMarkerIndex_(data, marker) {
  var wanted = String(marker || "").trim().toUpperCase();
  for (var r = 0; r < data.length; r++) {
    if (String(data[r][0] || "").trim().toUpperCase() === wanted) return r;
  }
  return -1;
}

function getActiveImportShipments_() {
  var active = new Set();
  var ss = SpreadsheetApp.openById(INVENTORY_SYNC.masterId);
  var sheet = ss.getSheetByName(INVENTORY_SYNC.importsTab);
  if (!sheet || sheet.getLastRow() < 2) return active;

  var range = sheet.getDataRange();
  var data = range.getDisplayValues();
  var backgrounds = range.getBackgrounds();
  var headerIdx = findHeaderRowIdx_(data);
  if (headerIdx < 0) return active;
  var map = headerMap_(data[headerIdx]);
  var schedulingIdx = findImportSectionMarkerIndex_(data, "SCHEDULING");
  var endIdx = schedulingIdx === -1 ? data.length : schedulingIdx;

  var statusCol = firstMappedColumn_(map, ["WEBSITE STATUS", "STATUS", "SHIPMENT STATUS"]);
  var etaCol = map["ETA"];
  if (etaCol === undefined) return active;
  var idCols = ["SHIPMENT", "SHIPMENT #", "SHIPMENT NO", "SHIPMENT NO.", "DOCS",
    "INVOICE", "MBL", "HBL", "차수", "CONTAINER", "CONTAINER #", "CONTAINER NO",
    "ENTRY NUMBER", "CONTAINER RAW (SYSTEM)"]
    .map(function (name) { return map[name]; })
    .filter(function (index, position, list) { return index !== undefined && list.indexOf(index) === position; });

  for (var r = headerIdx + 1; r < endIdx; r++) {
    var row = data[r];
    if (isGreyedImportRow_(backgrounds[r] || [])) continue;

    var status = statusCol === null ? "" : String(row[statusCol] || "").trim().toUpperCase();
    if (TERMINAL_STATUSES_.has(status)) continue;

    // The website's Import Schedule is based strictly on IMPORTS ETA (column O).
    // Inventory uses the same allow-list so historical/ETD/delivery-date rows cannot leak in.
    var scheduledDate = parseImportDate_(row[etaCol]);
    if (!scheduledDate || scheduledDate < IMPORT_CUTOFF_DATE_) continue;

    for (var i = 0; i < idCols.length; i++) {
      splitImportIdentifiers_(row[idCols[i]]).forEach(function (identifier) {
        active.add(normalizeImportIdentifier_(identifier));
      });
    }
  }
  return active;
}

function allocationSheetMatchesActiveImport_(sheetName, active) {
  var normalized = normalizeImportIdentifier_(sheetName);
  if (!normalized || !active.size) return false;
  if (active.has(normalized)) return true;
  var matched = false;
  active.forEach(function (identifier) {
    if (!matched && identifier.length >= 3 &&
        (normalized.indexOf(identifier) !== -1 || identifier.indexOf(normalized) !== -1)) {
      matched = true;
    }
  });
  return matched;
}

function firstMappedColumn_(map, names) {
  for (var i = 0; i < names.length; i++) {
    if (map[names[i]] !== undefined) return map[names[i]];
  }
  return null;
}

function splitImportIdentifiers_(value) {
  return String(value || "")
    .split(/[\r\n,;|/]+/)
    .map(function (part) { return part.trim(); })
    .filter(Boolean);
}

function normalizeImportIdentifier_(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function parseImportDate_(value) {
  var text = String(value || "").trim();
  if (!text) return null;
  var parsed = new Date(text);
  if (!isNaN(parsed.getTime())) return parsed;
  var match = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!match) return null;
  var year = match[3] ? Number(match[3]) : 2026;
  if (year < 100) year += 2000;
  parsed = new Date(year, Number(match[1]) - 1, Number(match[2]));
  return isNaN(parsed.getTime()) ? null : parsed;
}

function isGreyedImportRow_(backgrounds) {
  var grey = {
    "#cccccc": true, "#d3d3d3": true, "#e8eaed": true,
    "#b7b7b7": true, "#c9c9c9": true, "#999999": true
  };
  var greyCells = 0;
  for (var i = 0; i < Math.min(backgrounds.length, 18); i++) {
    if (grey[String(backgrounds[i] || "").toLowerCase()]) greyCells++;
  }
  return greyCells >= 3;
}

/**
 * Backward-compatible terminal-set helper used by other inventory routines.
 * The allow-list above is authoritative for inbound inventory.
 */
function getCompletedImportShipments_() {
  var active = getActiveImportShipments_();
  var excluded = new Set();
  try {
    var ss = SpreadsheetApp.openById(INVENTORY_SYNC.masterId);
    var sheet = ss.getSheetByName(INVENTORY_SYNC.importsTab);
    if (!sheet) return excluded;
    var data = sheet.getDataRange().getDisplayValues();
    var headerIdx = findHeaderRowIdx_(data);
    var map = headerMap_(data[headerIdx]);
    var idCols = ["SHIPMENT", "DOCS", "INVOICE", "MBL", "HBL", "CONTAINER", "CONTAINER RAW (SYSTEM)"]
      .map(function (name) { return map[name]; }).filter(function (index) { return index !== undefined; });
    for (var r = headerIdx + 1; r < data.length; r++) {
      for (var i = 0; i < idCols.length; i++) {
        splitImportIdentifiers_(data[r][idCols[i]]).forEach(function (identifier) {
          var normalized = normalizeImportIdentifier_(identifier);
          if (normalized && !active.has(normalized)) excluded.add(String(identifier).trim().toUpperCase());
        });
      }
    }
<<<<<<< HEAD
  } catch (e) { /* non-fatal: if IMPORTS is unreadable, process all tabs */ }
  return result;
=======
var TERMINAL_STATUSES_ = new Set(["DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED", "FINISHED", "CLOSED", "PUTAWAY"]);
var IMPORT_CUTOFF_DATE_ = new Date(2026, 6, 1); // July 1, 2026 (local script time)

/**
 * Builds an allow-list from IMPORTS. Only non-grey, non-terminal shipments
 * dated July 1, 2026 or later are eligible to contribute inbound inventory.
 */
function findImportSectionMarkerIndex_(data, marker) {
  var wanted = String(marker || "").trim().toUpperCase();
  for (var r = 0; r < data.length; r++) {
    if (String(data[r][0] || "").trim().toUpperCase() === wanted) return r;
  }
  return -1;
}

function getActiveImportShipments_() {
  var active = new Set();
  var ss = SpreadsheetApp.openById(INVENTORY_SYNC.masterId);
  var sheet = ss.getSheetByName(INVENTORY_SYNC.importsTab);
  if (!sheet || sheet.getLastRow() < 2) return active;

  var range = sheet.getDataRange();
  var data = range.getDisplayValues();
  var backgrounds = range.getBackgrounds();
  var headerIdx = findHeaderRowIdx_(data);
  if (headerIdx < 0) return active;
  var map = headerMap_(data[headerIdx]);
  var schedulingIdx = findImportSectionMarkerIndex_(data, "SCHEDULING");
  var endIdx = schedulingIdx === -1 ? data.length : schedulingIdx;

  var statusCol = firstMappedColumn_(map, ["WEBSITE STATUS", "STATUS", "SHIPMENT STATUS"]);
  var etaCol = map["ETA"];
  if (etaCol === undefined) return active;
  var idCols = ["SHIPMENT", "SHIPMENT #", "SHIPMENT NO", "SHIPMENT NO.", "DOCS",
    "INVOICE", "MBL", "HBL", "차수", "CONTAINER", "CONTAINER #", "CONTAINER NO",
    "ENTRY NUMBER", "CONTAINER RAW (SYSTEM)"]
    .map(function (name) { return map[name]; })
    .filter(function (index, position, list) { return index !== undefined && list.indexOf(index) === position; });

  for (var r = headerIdx + 1; r < endIdx; r++) {
    var row = data[r];
    if (isGreyedImportRow_(backgrounds[r] || [])) continue;

    var status = statusCol === null ? "" : String(row[statusCol] || "").trim().toUpperCase();
    if (TERMINAL_STATUSES_.has(status)) continue;

    // The website's Import Schedule is based strictly on IMPORTS ETA (column O).
    // Inventory uses the same allow-list so historical/ETD/delivery-date rows cannot leak in.
    var scheduledDate = parseImportDate_(row[etaCol]);
    if (!scheduledDate || scheduledDate < IMPORT_CUTOFF_DATE_) continue;

    for (var i = 0; i < idCols.length; i++) {
      splitImportIdentifiers_(row[idCols[i]]).forEach(function (identifier) {
        active.add(normalizeImportIdentifier_(identifier));
      });
    }
  }
  return active;
}

function allocationSheetMatchesActiveImport_(sheetName, active) {
  var normalized = normalizeImportIdentifier_(sheetName);
  if (!normalized || !active.size) return false;
  if (active.has(normalized)) return true;
  var matched = false;
  active.forEach(function (identifier) {
    if (!matched && identifier.length >= 3 &&
        (normalized.indexOf(identifier) !== -1 || identifier.indexOf(normalized) !== -1)) {
      matched = true;
    }
  });
  return matched;
}

function firstMappedColumn_(map, names) {
  for (var i = 0; i < names.length; i++) {
    if (map[names[i]] !== undefined) return map[names[i]];
  }
  return null;
}

function splitImportIdentifiers_(value) {
  return String(value || "")
    .split(/[\r\n,;|/]+/)
    .map(function (part) { return part.trim(); })
    .filter(Boolean);
}

function normalizeImportIdentifier_(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function parseImportDate_(value) {
  var text = String(value || "").trim();
  if (!text) return null;
  var parsed = new Date(text);
  if (!isNaN(parsed.getTime())) return parsed;
  var match = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!match) return null;
  var year = match[3] ? Number(match[3]) : 2026;
  if (year < 100) year += 2000;
  parsed = new Date(year, Number(match[1]) - 1, Number(match[2]));
  return isNaN(parsed.getTime()) ? null : parsed;
}

function isGreyedImportRow_(backgrounds) {
  var grey = {
    "#cccccc": true, "#d3d3d3": true, "#e8eaed": true,
    "#b7b7b7": true, "#c9c9c9": true, "#999999": true
  };
  var greyCells = 0;
  for (var i = 0; i < Math.min(backgrounds.length, 18); i++) {
    if (grey[String(backgrounds[i] || "").toLowerCase()]) greyCells++;
  }
  return greyCells >= 3;
}

/**
 * Backward-compatible terminal-set helper used by other inventory routines.
 * The allow-list above is authoritative for inbound inventory.
 */
function getCompletedImportShipments_() {
  var active = getActiveImportShipments_();
  var excluded = new Set();
  try {
    var ss = SpreadsheetApp.openById(INVENTORY_SYNC.masterId);
    var sheet = ss.getSheetByName(INVENTORY_SYNC.importsTab);
    if (!sheet) return excluded;
    var data = sheet.getDataRange().getDisplayValues();
    var headerIdx = findHeaderRowIdx_(data);
    var map = headerMap_(data[headerIdx]);
    var idCols = ["SHIPMENT", "DOCS", "INVOICE", "MBL", "HBL", "CONTAINER", "CONTAINER RAW (SYSTEM)"]
      .map(function (name) { return map[name]; }).filter(function (index) { return index !== undefined; });
    for (var r = headerIdx + 1; r < data.length; r++) {
      for (var i = 0; i < idCols.length; i++) {
        splitImportIdentifiers_(data[r][idCols[i]]).forEach(function (identifier) {
          var normalized = normalizeImportIdentifier_(identifier);
          if (normalized && !active.has(normalized)) excluded.add(String(identifier).trim().toUpperCase());
        });
      }
    }
  } catch (e) { Logger.log("Could not build completed import compatibility set: " + e.message); }
  return excluded;
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
  } catch (e) { Logger.log("Could not build completed import compatibility set: " + e.message); }
  return excluded;
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
}

/* ------------------------------------------------------------------ */
/* Writers                                                             */
/* ------------------------------------------------------------------ */

function writeInventoryTab_(stock, incoming, containers) {
  var ss = SpreadsheetApp.openById(INVENTORY_SYNC.masterId);
  var sheet = ss.getSheetByName(INVENTORY_SYNC.inventoryTab) || ss.insertSheet(INVENTORY_SYNC.inventoryTab);

  var headers = ["SKU", "Product Name", "Brand", "Barcode",
    "On Hand (Actual)", "Available", "On Hold", "Incoming (Confirmed)", "Remaining To Receive",
    "Inbound Shipments (차수)", "Locations", "Nearest Expiry", "Channel Allocation", "Flag", "Updated"];

  var skus = {};
  Object.keys(stock.bySku).forEach(function (sku) { skus[sku] = true; });
  Object.keys(incoming.bySku).forEach(function (sku) { skus[sku] = true; });

  var now = new Date();
  var rows = Object.keys(skus).sort().map(function (sku) {
    var onHand = stock.bySku[sku];
    var inbound = incoming.bySku[sku];
    var avail = onHand ? onHand.avail : 0;
    var remaining = inbound ? inbound.remaining : 0;
    var flag = "";
    if (avail <= 0 && remaining <= 0) flag = "OUT OF STOCK";
    else if (avail < INVENTORY_SYNC.lowStockThreshold && remaining <= 0) flag = "LOW STOCK";
    else if (avail < INVENTORY_SYNC.lowStockThreshold && remaining > 0) flag = "LOW — INBOUND EN ROUTE";

    var shipmentsWithStatus = inbound ? inbound.shipments.map(function (code) {
      var container = containers.byCode[String(code).toUpperCase()];
      return container && container.receivedDate ? code + " (rcvd " + container.receivedDate + ")" : code;
    }).join(", ") : "";

    var channelSummary = inbound ? Object.keys(inbound.channels).map(function (channel) {
      return channel + ":" + inbound.channels[channel];
    }).join(" · ") : "";

    return [
      sku,
      (onHand && onHand.name) || (inbound && inbound.name) || "",
      (onHand && onHand.brand) || (inbound && inbound.brand) || "",
      (onHand && onHand.barcode) || (inbound && inbound.barcode) || "",
      onHand ? onHand.actual : 0,
      avail,
      onHand ? onHand.hold : 0,
      inbound ? inbound.confirmed : 0,
      remaining,
      shipmentsWithStatus,
      onHand ? onHand.locations.slice(0, 6).join(", ") : "",
      onHand ? onHand.nearestExpiry : "",
      channelSummary,
      flag,
      now
    ];
  });

  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold").setBackground("#EFEFEF");
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.setFrozenRows(1);
  SpreadsheetApp.flush();
}

function updateKpiDashboard_(stock, incoming, containers) {
  var ss = SpreadsheetApp.openById(INVENTORY_SYNC.masterId);
  var sheet = ss.getSheetByName(INVENTORY_SYNC.kpiTab) || ss.insertSheet(INVENTORY_SYNC.kpiTab);

  var stockSkus = Object.keys(stock.bySku);
  var unitsOnHand = 0, unitsAvailable = 0;
  stockSkus.forEach(function (sku) { unitsOnHand += stock.bySku[sku].actual; unitsAvailable += stock.bySku[sku].avail; });

  var incomingSkus = Object.keys(incoming.bySku);
  var unitsIncoming = 0;
  incomingSkus.forEach(function (sku) { unitsIncoming += incoming.bySku[sku].remaining; });

  var lowStock = stockSkus.filter(function (sku) {
    var e = stock.bySku[sku];
    var remaining = incoming.bySku[sku] ? incoming.bySku[sku].remaining : 0;
    return e.avail < INVENTORY_SYNC.lowStockThreshold && remaining <= 0;
  }).length;

  var pendingContainers = containers.rows.filter(function (r) { return !r.receivedDate; }).length;
  var awaitingQc = containers.rows.filter(function (r) { return r.receivedDate && !r.qcDoneDate; }).length;

  var metrics = [
    ["Metric", "Value", "Updated: " + new Date()],
    ["SKUS TRACKED", stockSkus.length + incomingSkus.filter(function (s) { return !stock.bySku[s]; }).length, ""],
    ["UNITS ON HAND", unitsOnHand, ""],
    ["UNITS AVAILABLE", unitsAvailable, ""],
    ["UNITS INBOUND (REMAINING)", unitsIncoming, ""],
    ["LOW / OUT-OF-STOCK SKUS", lowStock, "avail < " + INVENTORY_SYNC.lowStockThreshold + " with nothing inbound"],
    ["CONTAINERS IN TRANSIT", pendingContainers, "receiving log rows without 입고일"],
    ["CONTAINERS AWAITING QC", awaitingQc, "received, 검수 not complete"],
    ["PENDING VERIFICATION (EMAIL)", pendingVerificationCount_(), "rows needing manual review"]
  ];

  sheet.clearContents();
  sheet.getRange(1, 1, metrics.length, 3).setValues(metrics);
  sheet.getRange(1, 1, 1, 3).setFontWeight("bold").setBackground("#EFEFEF");
  SpreadsheetApp.flush();
}

/* ------------------------------------------------------------------ */
/* IMPORTS enrichment                                                  */
/* ------------------------------------------------------------------ */

/**
 * Optional daily job: pushes receiving/QC dates from the WMS container log
 * onto matching IMPORTS rows (matched by 차수 code or PC number appearing in
 * any cell of the row).
 */
function enrichImportsFromContainerLog() {
  var containers = readWmsContainerLog_();
  if (!containers.rows.length) return { updated: 0 };
  var ss = SpreadsheetApp.openById(INVENTORY_SYNC.masterId);
  var sheet = ss.getSheetByName(INVENTORY_SYNC.importsTab);
  if (!sheet) return { updated: 0 };

  var data = sheet.getDataRange().getDisplayValues();
  var headerIdx = findHeaderRowIdx_(data);
  var map = headerMap_(data[headerIdx]);
  var noteCol = map["NOTE"] !== undefined ? map["NOTE"] : (map["REMARK"] !== undefined ? map["REMARK"] : null);

  var statusCol = map["WEBSITE STATUS"] !== undefined ? map["WEBSITE STATUS"]
                : (map["STATUS"] !== undefined ? map["STATUS"]
                : (map["SHIPMENT STATUS"] !== undefined ? map["SHIPMENT STATUS"] : null));

  var updated = 0;
  for (var r = headerIdx + 1; r < data.length; r++) {
    if (statusCol !== null) {
      var rowStatus = String(data[r][statusCol] || "").trim().toUpperCase();
      if (TERMINAL_STATUSES_.has(rowStatus)) continue;
    }
    var rowText = data[r].join(" ").toUpperCase();
    for (var i = 0; i < containers.rows.length; i++) {
      var c = containers.rows[i];
      var hit = (c.pcNumber && rowText.indexOf(c.pcNumber.toUpperCase()) !== -1) ||
                (c.shipmentCode && rowText.indexOf(c.shipmentCode.toUpperCase()) !== -1);
      if (!hit || !c.receivedDate) continue;
      var tag = "[WMS " + c.shipmentCode + ": rcvd " + c.receivedDate + (c.qcDoneDate ? ", QC " + c.qcDoneDate : "") + "]";
      if (noteCol !== null && String(data[r][noteCol]).indexOf(tag) === -1) {
        sheet.getRange(r + 1, noteCol + 1).setValue((data[r][noteCol] ? data[r][noteCol] + " " : "") + tag);
        updated++;
      }
      break;
    }
  }
  SpreadsheetApp.flush();
  return { updated: updated };
}

function num_(value) {
  var n = Number(String(value === undefined || value === null ? "" : value).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

/**
 * Periodic job to track status updates for small parcels in the inbound schedule.
 * Queries packages marked as SCHEDULED and checks for delivery/status updates.
 * 
 * This monitors:
 * - SKW_Inbound packages awaiting delivery
 * - IMPORTS inbound schedule items in transit
 * 
 * Updates are pulled from email notifications, carrier tracking, and manual sources.
 */
<<<<<<< HEAD
<<<<<<< HEAD
=======
var SMALL_PARCEL_TRIGGER_VERSION_ = "hourly-v3-outbound-20260811";

function ensureHourlySmallParcelTrigger_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty("SMALL_PARCEL_TRIGGER_VERSION") === SMALL_PARCEL_TRIGGER_VERSION_) return;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "trackSmallParcelsStatusUpdates") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("trackSmallParcelsStatusUpdates").timeBased().everyHours(1).create();
  props.setProperty("SMALL_PARCEL_TRIGGER_VERSION", SMALL_PARCEL_TRIGGER_VERSION_);
  Logger.log("Small parcel tracker migrated to hourly trigger.");
}

>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
function trackSmallParcelsStatusUpdates() {
  var ss;
  try {
    ensureHourlySmallParcelTrigger_();
    ss = SpreadsheetApp.openById(INVENTORY_SYNC.masterId);
    var results = { checked: 0, updated: 0, errors: [] };

    results.skwUpdates = trackSkwInboundStatus_(ss);
    results.checked += results.skwUpdates.checked;
    results.updated += results.skwUpdates.updated;

    results.importsUpdates = trackImportsParcelStatus_(ss);
    results.checked += results.importsUpdates.checked;
    results.updated += results.importsUpdates.updated;

    results.outboundUpdates = trackOutboundShipmentStatus_();
    results.checked += results.outboundUpdates.checked;
    results.updated += results.outboundUpdates.updated;

    var summary = "Tracked small parcels hourly: " + results.checked + " packages, " + results.updated + " source rows updated";
    Logger.log(summary);
    appendPipelineLog_(ss, summary, "SMALL_PARCEL_TRACKING");
<<<<<<< HEAD
    
=======
var SMALL_PARCEL_TRIGGER_VERSION_ = "hourly-v3-outbound-20260811";

function ensureHourlySmallParcelTrigger_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty("SMALL_PARCEL_TRIGGER_VERSION") === SMALL_PARCEL_TRIGGER_VERSION_) return;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "trackSmallParcelsStatusUpdates") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("trackSmallParcelsStatusUpdates").timeBased().everyHours(1).create();
  props.setProperty("SMALL_PARCEL_TRIGGER_VERSION", SMALL_PARCEL_TRIGGER_VERSION_);
  Logger.log("Small parcel tracker migrated to hourly trigger.");
}

function trackSmallParcelsStatusUpdates() {
  var ss;
  try {
    ensureHourlySmallParcelTrigger_();
    ss = SpreadsheetApp.openById(INVENTORY_SYNC.masterId);
    var results = { checked: 0, updated: 0, errors: [] };

    results.skwUpdates = trackSkwInboundStatus_(ss);
    results.checked += results.skwUpdates.checked;
    results.updated += results.skwUpdates.updated;

    results.importsUpdates = trackImportsParcelStatus_(ss);
    results.checked += results.importsUpdates.checked;
    results.updated += results.importsUpdates.updated;

    results.outboundUpdates = trackOutboundShipmentStatus_();
    results.checked += results.outboundUpdates.checked;
    results.updated += results.outboundUpdates.updated;

    var summary = "Tracked small parcels hourly: " + results.checked + " packages, " + results.updated + " source rows updated";
    Logger.log(summary);
    appendPipelineLog_(ss, summary, "SMALL_PARCEL_TRACKING");
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
    return results;
  } catch (err) {
    var msg = "trackSmallParcelsStatusUpdates error: " + err.toString();
    Logger.log(msg);
<<<<<<< HEAD
<<<<<<< HEAD
    appendPipelineLog_(ss, msg, "ERROR");
=======
    if (ss) appendPipelineLog_(ss, msg, "ERROR");
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
    if (ss) appendPipelineLog_(ss, msg, "ERROR");
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
    throw err;
  }
}

/**
<<<<<<< HEAD
<<<<<<< HEAD
 * Scans SKW_Inbound sheet for SCHEDULED packages and checks for status updates.
 * Marks packages as SHIPPED/DELIVERED when their status changes.
=======
 * Tracks every active Stylekorean outbound row carrying a parcel tracking
 * number or freight PRO number. Exact-number carrier emails are always checked;
 * UPS/FedEx/USPS/DHL parcels also use the official carrier page.
 *
 * The update is stored in ISSUE as a replaceable [AUTO TRACK ...] marker. The
 * dashboard reads that marker as the live schedule status without overwriting
 * a user's existing issue note.
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
 */
function trackOutboundShipmentStatus_() {
  var workbook = SpreadsheetApp.openById(WMS_SPREADSHEET_ID);
  var sheet = workbook.getSheetByName("Stylekorean");
  if (!sheet) return { checked: 0, updated: 0 };
  var data = sheet.getDataRange().getDisplayValues();
  var header = findWmsTruckingHeader_(data);
  var map = header.map;
  var issueCol = map["ISSUE"] !== undefined ? map["ISSUE"] : 7;
  var methodCol = map["SHIPPING METHOD"] !== undefined ? map["SHIPPING METHOD"] : 5;
  var checked = 0, updated = 0;

  for (var r = header.rowIndex + 1; r < data.length; r++) {
    var method = String(data[r][methodCol] || "").trim();
    if (!/UPS|FEDEX|FED EX|USPS|DHL|AMAZON|TRUCK|LTL|FTL/i.test(method)) continue;
    var tracking = outboundTrackingCandidate_(data[r], map);
    if (!tracking) continue;
    var existing = String(data[r][issueCol] || "").trim();
    var currentStatus = parcelStatusFromText_(existing) || "Scheduled";
    if (/^(DELIVERED|RECEIVED|COMPLETED|CANCELLED)$/i.test(currentStatus)) continue;
    checked++;

    var carrier = outboundCarrier_(method, tracking);
    var signal = lookupParcelTrackingUpdate_(carrier, tracking, existing);
    if (!signal.status && !signal.eta) continue;
    var statusChanged = signal.status && shouldApplyParcelStatus_(currentStatus, signal.status);
    var etaChanged = signal.eta && signal.eta !== parcelCurrentEta_(existing);
    if (!statusChanged && !etaChanged) continue;
    var next = mergeParcelAutoTrackingNote_(existing, {
      status: signal.status || currentStatus,
      eta: signal.eta,
      source: signal.source
    });
    if (next === existing) continue;
    sheet.getRange(r + 1, issueCol + 1).setValue(next);
    data[r][issueCol] = next;
    updated++;
    Logger.log("Stylekorean outbound row " + (r + 1) + " " + tracking + " -> " + (signal.status || currentStatus) + " via " + signal.source);
  }
  if (updated) SpreadsheetApp.flush();
  return { checked: checked, updated: updated };
}

function outboundTrackingCandidate_(row, map) {
  var named = ["TRACKING#", "TRACKING #", "TRACKING NUMBER", "PRO#", "PRO #", "PRO NUMBER", "BOL#", "BOL"];
  var values = [];
  named.forEach(function (name) {
    if (map[name] !== undefined) values.push(row[map[name]]);
  });
  // The WMS export sometimes places tracking/PRO data in unnamed columns I:AF.
  for (var c = 8; c < Math.min(row.length, 32); c++) values.push(row[c]);
  for (var i = 0; i < values.length; i++) {
    var text = String(values[i] || "").trim();
    if (!text) continue;
    var match = text.match(/\b(1Z[A-Z0-9]{16}|\d{12,30}|[A-Z]{2}\d{9}[A-Z]{2}|[A-Z0-9][A-Z0-9-]{7,39})\b/i);
    if (match && !/^(YES|NO|PENDING|ISSUE|SCHEDULED|TRUCKING)$/i.test(match[1])) return match[1].toUpperCase();
  }
  return "";
}

function outboundCarrier_(method, tracking) {
  var text = String(method || "").toUpperCase();
  var number = String(tracking || "").toUpperCase();
  if (/^1Z/.test(number) || /UPS/.test(text)) return "UPS";
  if (/FEDEX|FED EX/.test(text) || /^\d{12}$/.test(number)) return "FEDEX";
  if (/USPS/.test(text) || /^\d{20,22}$/.test(number) || /^[A-Z]{2}\d{9}US$/.test(number)) return "USPS";
  if (/DHL/.test(text)) return "DHL";
  return ""; // Freight PROs are tracked through exact-number email signals.
}

function trackSkwInboundStatus_(ss) {
  var sheet = ss.getSheetByName("SKW_Inbound");
  if (!sheet) return { checked: 0, updated: 0 };
  var data = sheet.getDataRange().getDisplayValues();
  var headerIdx = findHeaderRowIdx_(data);
  if (headerIdx === -1) return { checked: 0, updated: 0 };
  var map = headerMap_(data[headerIdx]);
  var statusCol = map["STATUS"] !== undefined ? map["STATUS"] :
                  map["WEBSITE STATUS"] !== undefined ? map["WEBSITE STATUS"] : -1;
  var dateReceivedCol = map["DATE_RECEIVED"] !== undefined ? map["DATE_RECEIVED"] :
                        map["RECEIVED_DATE"] !== undefined ? map["RECEIVED_DATE"] : -1;
  if (statusCol === -1) return { checked: 0, updated: 0 };
  var checked = 0, updated = 0;
  for (var r = headerIdx + 1; r < data.length; r++) {
    var currentStatus = String(data[r][statusCol] || "").trim().toUpperCase();
    if (currentStatus !== "SCHEDULED" && currentStatus !== "WORK IN PROGRESS") continue;
    checked++;
    var dateReceived = dateReceivedCol !== -1 ? data[r][dateReceivedCol] : "";
    if (dateReceived) {
      sheet.getRange(r + 1, statusCol + 1).setValue("DELIVERED");
      updated++;
    }
  }
<<<<<<< HEAD
  
=======
 * Tracks every active Stylekorean outbound row carrying a parcel tracking
 * number or freight PRO number. Exact-number carrier emails are always checked;
 * UPS/FedEx/USPS/DHL parcels also use the official carrier page.
 *
 * The update is stored in ISSUE as a replaceable [AUTO TRACK ...] marker. The
 * dashboard reads that marker as the live schedule status without overwriting
 * a user's existing issue note.
 */
function trackOutboundShipmentStatus_() {
  var workbook = SpreadsheetApp.openById(WMS_SPREADSHEET_ID);
  var sheet = workbook.getSheetByName("Stylekorean");
  if (!sheet) return { checked: 0, updated: 0 };
  var data = sheet.getDataRange().getDisplayValues();
  var header = findWmsTruckingHeader_(data);
  var map = header.map;
  var issueCol = map["ISSUE"] !== undefined ? map["ISSUE"] : 7;
  var methodCol = map["SHIPPING METHOD"] !== undefined ? map["SHIPPING METHOD"] : 5;
  var checked = 0, updated = 0;

  for (var r = header.rowIndex + 1; r < data.length; r++) {
    var method = String(data[r][methodCol] || "").trim();
    if (!/UPS|FEDEX|FED EX|USPS|DHL|AMAZON|TRUCK|LTL|FTL/i.test(method)) continue;
    var tracking = outboundTrackingCandidate_(data[r], map);
    if (!tracking) continue;
    var existing = String(data[r][issueCol] || "").trim();
    var currentStatus = parcelStatusFromText_(existing) || "Scheduled";
    if (/^(DELIVERED|RECEIVED|COMPLETED|CANCELLED)$/i.test(currentStatus)) continue;
    checked++;

    var carrier = outboundCarrier_(method, tracking);
    var signal = lookupParcelTrackingUpdate_(carrier, tracking, existing);
    if (!signal.status && !signal.eta) continue;
    var statusChanged = signal.status && shouldApplyParcelStatus_(currentStatus, signal.status);
    var etaChanged = signal.eta && signal.eta !== parcelCurrentEta_(existing);
    if (!statusChanged && !etaChanged) continue;
    var next = mergeParcelAutoTrackingNote_(existing, {
      status: signal.status || currentStatus,
      eta: signal.eta,
      source: signal.source
    });
    if (next === existing) continue;
    sheet.getRange(r + 1, issueCol + 1).setValue(next);
    data[r][issueCol] = next;
    updated++;
    Logger.log("Stylekorean outbound row " + (r + 1) + " " + tracking + " -> " + (signal.status || currentStatus) + " via " + signal.source);
  }
  if (updated) SpreadsheetApp.flush();
  return { checked: checked, updated: updated };
}

function outboundTrackingCandidate_(row, map) {
  var named = ["TRACKING#", "TRACKING #", "TRACKING NUMBER", "PRO#", "PRO #", "PRO NUMBER", "BOL#", "BOL"];
  var values = [];
  named.forEach(function (name) {
    if (map[name] !== undefined) values.push(row[map[name]]);
  });
  // The WMS export sometimes places tracking/PRO data in unnamed columns I:AF.
  for (var c = 8; c < Math.min(row.length, 32); c++) values.push(row[c]);
  for (var i = 0; i < values.length; i++) {
    var text = String(values[i] || "").trim();
    if (!text) continue;
    var match = text.match(/\b(1Z[A-Z0-9]{16}|\d{12,30}|[A-Z]{2}\d{9}[A-Z]{2}|[A-Z0-9][A-Z0-9-]{7,39})\b/i);
    if (match && !/^(YES|NO|PENDING|ISSUE|SCHEDULED|TRUCKING)$/i.test(match[1])) return match[1].toUpperCase();
  }
  return "";
}

function outboundCarrier_(method, tracking) {
  var text = String(method || "").toUpperCase();
  var number = String(tracking || "").toUpperCase();
  if (/^1Z/.test(number) || /UPS/.test(text)) return "UPS";
  if (/FEDEX|FED EX/.test(text) || /^\d{12}$/.test(number)) return "FEDEX";
  if (/USPS/.test(text) || /^\d{20,22}$/.test(number) || /^[A-Z]{2}\d{9}US$/.test(number)) return "USPS";
  if (/DHL/.test(text)) return "DHL";
  return ""; // Freight PROs are tracked through exact-number email signals.
}

function trackSkwInboundStatus_(ss) {
  var sheet = ss.getSheetByName("SKW_Inbound");
  if (!sheet) return { checked: 0, updated: 0 };
  var data = sheet.getDataRange().getDisplayValues();
  var headerIdx = findHeaderRowIdx_(data);
  if (headerIdx === -1) return { checked: 0, updated: 0 };
  var map = headerMap_(data[headerIdx]);
  var statusCol = map["STATUS"] !== undefined ? map["STATUS"] :
                  map["WEBSITE STATUS"] !== undefined ? map["WEBSITE STATUS"] : -1;
  var dateReceivedCol = map["DATE_RECEIVED"] !== undefined ? map["DATE_RECEIVED"] :
                        map["RECEIVED_DATE"] !== undefined ? map["RECEIVED_DATE"] : -1;
  if (statusCol === -1) return { checked: 0, updated: 0 };
  var checked = 0, updated = 0;
  for (var r = headerIdx + 1; r < data.length; r++) {
    var currentStatus = String(data[r][statusCol] || "").trim().toUpperCase();
    if (currentStatus !== "SCHEDULED" && currentStatus !== "WORK IN PROGRESS") continue;
    checked++;
    var dateReceived = dateReceivedCol !== -1 ? data[r][dateReceivedCol] : "";
    if (dateReceived) {
      sheet.getRange(r + 1, statusCol + 1).setValue("DELIVERED");
      updated++;
    }
  }
=======
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
  return { checked: checked, updated: updated };
}

function parcelCarrierSection_(value) {
  var text = String(value || "").trim().toUpperCase();
  if (/^UPS\b/.test(text)) return "UPS";
  if (/^FEDEX\b|^FED EX\b/.test(text)) return "FEDEX";
  if (/^USPS\b/.test(text)) return "USPS";
  if (/^DHL\b/.test(text)) return "DHL";
  if (/^AMAZON\b/.test(text)) return "AMAZON";
  return "";
}

function parcelTrackingCandidate_(row) {
  var candidates = [row[1], row[10]];
  for (var i = 0; i < candidates.length; i++) {
    var text = String(candidates[i] || "").trim();
    if (!text || /TRACKING\s*#?/i.test(text)) continue;
    var match = text.match(/\b(1Z[A-Z0-9]{16}|\d{12,30}|[A-Z]{2}\d{9}[A-Z]{2})\b/i);
    if (match) return match[1].toUpperCase();
    if (/^[A-Z0-9-]{10,40}$/i.test(text)) return text.toUpperCase();
  }
  return "";
}

function normalizeParcelSheetStatus_(value) {
  var text = String(value || "").trim();
  var upper = text.toUpperCase().replace(/\s+/g, " ");
  if (!upper) return "Scheduled";
  if (/FDA.*(DETAIN|HOLD|REVIEW)/.test(upper)) return "FDA Review/Hold";
  if (/CUSTOMS/.test(upper)) return "Customs Clearance";
  if (/IN TRANSIT|SHIPPING|SHIPPED|OUT FOR DELIVERY/.test(upper)) return "Shipping";
  if (/DELIVERED/.test(upper)) return "Delivered";
  if (/RECEIVED/.test(upper)) return "Received";
  if (/DELAY|EXCEPTION/.test(upper)) return "Delayed";
  return text;
}

function parcelStatusRank_(value) {
  var upper = normalizeParcelSheetStatus_(value).toUpperCase();
  if (upper === "DELIVERED" || upper === "RECEIVED") return 100;
  if (upper === "SHIPPING" || upper === "SHIPPED") return 60;
  if (upper === "CUSTOMS CLEARANCE" || upper === "FDA REVIEW/HOLD" || upper === "DELAYED") return 50;
  if (upper === "WORK IN PROGRESS" || upper === "PENDING") return 20;
  return 10;
}

function shouldApplyParcelStatus_(current, next) {
  var currentNormalized = normalizeParcelSheetStatus_(current);
  var nextNormalized = normalizeParcelSheetStatus_(next);
  if (!nextNormalized || currentNormalized.toUpperCase() === nextNormalized.toUpperCase()) return false;
  if (/^(DELIVERED|RECEIVED|COMPLETED|CANCELLED)$/i.test(currentNormalized)) return false;
  if (/^(CUSTOMS CLEARANCE|FDA REVIEW\/HOLD|DELAYED)$/i.test(nextNormalized)) return true;
  if (/^(CUSTOMS CLEARANCE|FDA REVIEW\/HOLD|DELAYED)$/i.test(currentNormalized) && /^(SHIPPING|DELIVERED|RECEIVED)$/i.test(nextNormalized)) return true;
  return parcelStatusRank_(nextNormalized) >= parcelStatusRank_(currentNormalized);
}

function parcelStatusFromText_(text) {
  var value = String(text || "").replace(/\s+/g, " ").toLowerCase();
  if (!value) return "";
  if (/fda.{0,30}(detain|hold|review)|detain.{0,30}fda/.test(value)) return "FDA Review/Hold";
  if (/customs.{0,30}(hold|clearance|processing)|clearance.{0,30}customs/.test(value)) return "Customs Clearance";
  if (/delivery exception|shipment exception|weather delay|delayed|delay in transit/.test(value)) return "Delayed";
  if (!/not delivered|delivery attempt failed/.test(value) && /\bdelivered\b|proof of delivery/.test(value)) return "Delivered";
  if (/out for delivery|on vehicle for delivery|\bin transit\b|on the way|has shipped|was shipped|departed facility|arrived at facility/.test(value)) return "Shipping";
  if (/label created|shipment information (sent|received)|pre[- ]shipment|awaiting carrier pickup/.test(value)) return "Scheduled";
  return "";
}

function parcelEtaFromText_(text) {
  var value = String(text || "").replace(/\s+/g, " ");
  var slash = value.match(/(?:ETA|ESTIMATED(?: DELIVERY| ARRIVAL)?|SCHEDULED DELIVERY|EXPECTED DELIVERY|ARRIVING)[^0-9]{0,24}(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  if (slash) {
    var parsed = parseImportDate_(slash[1]);
    if (parsed) return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "MM/dd/yy");
  }
  var month = value.match(/(?:ETA|ESTIMATED(?: DELIVERY| ARRIVAL)?|SCHEDULED DELIVERY|EXPECTED DELIVERY|ARRIVING)[^A-Z0-9]{0,24}((?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\s+\d{1,2}(?:,?\s+\d{4})?)/i);
  if (month) {
    var date = new Date(month[1]);
    if (!isNaN(date.getTime())) return Utilities.formatDate(date, Session.getScriptTimeZone(), "MM/dd/yy");
  }
  return "";
}

function parcelSignalFromText_(text, source) {
  return { status: parcelStatusFromText_(text), eta: parcelEtaFromText_(text), source: source || "" };
}

function officialParcelTrackingUrl_(carrier, tracking) {
  var n = encodeURIComponent(tracking);
  if (carrier === "UPS") return "https://www.ups.com/track?loc=en_US&tracknum=" + n;
  if (carrier === "FEDEX") return "https://www.fedex.com/fedextrack/?trknbr=" + n;
  if (carrier === "USPS") return "https://tools.usps.com/go/TrackConfirmAction?tLabels=" + n;
  if (carrier === "DHL") return "https://www.dhl.com/us-en/home/tracking.html?tracking-id=" + n;
  return "";
}

function trackingContext_(text, tracking) {
  var body = String(text || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ");
  var upper = body.toUpperCase();
  var needle = String(tracking || "").toUpperCase();
  var index = upper.indexOf(needle);
  if (index === -1) return "";
  return body.slice(Math.max(0, index - 2500), Math.min(body.length, index + needle.length + 2500));
}

function officialParcelSignal_(carrier, tracking) {
  var url = officialParcelTrackingUrl_(carrier, tracking);
  if (!url) return { status: "", eta: "", source: "" };
  try {
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SKW-Logistics/1.0)" }
    });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 400) return { status: "", eta: "", source: "" };
    var context = trackingContext_(response.getContentText().slice(0, 400000), tracking);
    if (!context) return { status: "", eta: "", source: "" };
    return parcelSignalFromText_(context, "official " + carrier);
  } catch (err) {
    Logger.log("Official " + carrier + " tracking failed for " + tracking + ": " + err.message);
    return { status: "", eta: "", source: "" };
  }
}

function parcelEmailSignal_(tracking) {
  try {
    var threads = GmailApp.search('"' + String(tracking || "").replace(/"/g, "") + '" newer_than:45d', 0, 8);
    var best = null;
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (message) {
        var text = message.getSubject() + "\n" + message.getPlainBody().slice(0, 60000);
        var signal = parcelSignalFromText_(text, "carrier email");
        if ((!signal.status && !signal.eta) || (best && message.getDate() <= best.date)) return;
        best = { status: signal.status, eta: signal.eta, source: signal.source, date: message.getDate() };
      });
    });
    return best || { status: "", eta: "", source: "" };
  } catch (err) {
    Logger.log("Carrier email search failed for " + tracking + ": " + err.message);
    return { status: "", eta: "", source: "" };
  }
}

function lookupParcelTrackingUpdate_(carrier, tracking, sourceNote) {
  // Priority: official carrier page, then exact-tracking carrier email, then the source note.
  var note = parcelSignalFromText_(sourceNote, "sheet note");
  var official = officialParcelSignal_(carrier, tracking);
  if (official.status || official.eta) {
    if (!official.eta && note.eta) official.eta = note.eta;
    return official;
  }
  var email = parcelEmailSignal_(tracking);
  if (email.status || email.eta) {
    if (!email.eta && note.eta) email.eta = note.eta;
    return email;
  }
  return note;
}

function parcelCurrentEta_(text) {
  var value = String(text || "");
  var autoMatches = value.match(/\[AUTO TRACK[^\]]*ETA:(\d{1,2}\/\d{1,2}\/\d{2,4})[^\]]*\]/ig);
  if (autoMatches && autoMatches.length) {
    var last = autoMatches[autoMatches.length - 1].match(/ETA:(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (last) return last[1];
  }
  return parcelEtaFromText_(value);
}

function mergeParcelAutoTrackingNote_(existing, signal) {
  var base = String(existing || "").replace(/\s*\[AUTO TRACK[^\]]*\]\s*$/i, "").trim();
  var pieces = [Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm")];
  if (signal.status) pieces.push(normalizeParcelSheetStatus_(signal.status));
  if (signal.source) pieces.push(signal.source);
  if (signal.eta) pieces.push("ETA:" + signal.eta);
  return (base ? base + " " : "") + "[AUTO TRACK " + pieces.join(" · ") + "]";
}

function trackImportsParcelStatus_(ss) {
  var sheet = ss.getSheetByName("IMPORTS");
  if (!sheet) return { checked: 0, updated: 0 };
  var data = sheet.getDataRange().getDisplayValues();
  var headerIdx = findHeaderRowIdx_(data);
  if (headerIdx === -1) return { checked: 0, updated: 0 };
  var map = headerMap_(data[headerIdx]);
  var statusCol = map["WEBSITE STATUS"] !== undefined ? map["WEBSITE STATUS"] :
                  map["STATUS"] !== undefined ? map["STATUS"] : -1;
  if (statusCol === -1) return { checked: 0, updated: 0 };
  var parcelsIdx = findImportSectionMarkerIndex_(data, "PARCELS");
  if (parcelsIdx === -1) return { checked: 0, updated: 0 };

  var currentCarrier = "";
  var checked = 0, updated = 0;
  for (var r = parcelsIdx + 1; r < data.length; r++) {
    var first = String(data[r][0] || "").trim();
    var section = parcelCarrierSection_(first);
    if (section) currentCarrier = section;
    else if (first) currentCarrier = "";
    if (!currentCarrier) continue;

    var tracking = parcelTrackingCandidate_(data[r]);
    if (!tracking) continue;
    var currentStatus = normalizeParcelSheetStatus_(data[r][statusCol]);
    if (/^(DELIVERED|RECEIVED|COMPLETED|CANCELLED)$/i.test(currentStatus)) continue;
    checked++;

    var existingEtaNote = String(data[r][4] || "").trim();
    var signal = lookupParcelTrackingUpdate_(currentCarrier, tracking, existingEtaNote);
    var rowChanged = false;
    if (signal.status && shouldApplyParcelStatus_(currentStatus, signal.status)) {
      var normalizedStatus = normalizeParcelSheetStatus_(signal.status);
      sheet.getRange(r + 1, statusCol + 1).setValue(normalizedStatus);
      data[r][statusCol] = normalizedStatus;
      currentStatus = normalizedStatus;
      rowChanged = true;
    }
    var currentEta = parcelCurrentEta_(existingEtaNote);
    if (signal.eta && signal.eta !== currentEta) {
      var nextNote = mergeParcelAutoTrackingNote_(existingEtaNote, {
        status: signal.status || currentStatus,
        eta: signal.eta,
        source: signal.source
      });
      if (nextNote !== existingEtaNote) {
        sheet.getRange(r + 1, 5).setValue(nextNote);
        data[r][4] = nextNote;
        rowChanged = true;
      }
    }
    if (rowChanged) {
      updated++;
      Logger.log("IMPORTS parcel row " + (r + 1) + " " + tracking + " -> " + currentStatus + (signal.eta ? " ETA " + signal.eta : "") + " via " + signal.source);
    }
  }
  if (updated) SpreadsheetApp.flush();
<<<<<<< HEAD
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
  return { checked: checked, updated: updated };
}
