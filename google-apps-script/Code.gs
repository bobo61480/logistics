/**
 * ============================================================================
 *  SKW LOGISTICS — GMAIL → DRIVE → SHEETS INGESTION PIPELINE
 *  StyleKorean US · Apps Script backend for the logistics board
 *  (bobo61480/logistics → https://stylekorean.dpdns.org/)
 * ----------------------------------------------------------------------------
 *  Features:
 *   · Time-driven Gmail scan (label-based) with idempotent message tracking
 *   · Attachment archival to organized Drive folders (YYYY/MM)
 *   · CSV parsing + XLSX→Sheet conversion via Drive Advanced Service
 *   · Validation layer: hard failures → Review sheet ("PENDING VERIFICATION",
 *     orange); soft warnings → committed with yellow annotation
 *   · Relational append to Inbound / Outbound with provenance (msg ID)
 *   · Inventory SKU-master rebuild + KPI freshness stamp
 *   · Review approval workflow (onEdit promotion)
 *   · LockService, per-attachment error isolation, Log sheet, daily digest
 *
 *  SETUP:
 *   1. Fill CONFIG below.
 *   2. Services (left panel) → add "Drive API" (Advanced Drive Service).
 *   3. Run setup() once and authorize.
 *   4. Deploy → Web App (Execute as Me / Anyone with link) for the JSON API.
 * ============================================================================
 */


const SPREADSHEET_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const WMS_SPREADSHEET_ID = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";

const OUTBOUND_STATUS = ["", "SCHEDULED", "WORK IN PROGRESS", "PENDING", "SHIPPING", "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED"];
const INBOUND_STATUS = ["", "SCHEDULED", "WORK IN PROGRESS", "PENDING", "SHIPPING", "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED", "N/A", "Customs Clearance", "FDA Review/Hold", "FWS Review/Hold", "Delayed"];
const ALLOWED_SHEETS = ["WH Trucking Request", "B2B/E-COM TRUCKING", "TRANSFERS", "ULTA", "IHERB", "IMPORTS", "NATIONAL ORDER PROGRESS", "Outbound Shipping Schedule", "TJX/ROSS"];

const COMPLETED_STATUSES = ["SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED"];

// Required by transferInboundInventory_ -- restored from the pre-2026-08-07 version
// of this file after it was dropped during a source reconciliation. See
// DEPLOYMENT_NOTE.md. Do not remove without confirming SKW_Inbound -> SKW_Stock
// auto-transfer is no longer needed.
const INVENTORY_TRANSFER_STATUSES = ["DELIVERED", "RECEIVED", "COMPLETED"];
const SKW_INBOUND_SHEET = "SKW_Inbound";
const SKW_STOCK_SHEET = "SKW_Stock";

function doPost(e) {
  const lock = LockService.getScriptLock();
  let haveLock = false;
  try {
    haveLock = lock.tryLock(20000);
    if (!haveLock) {
      return json_({ ok: false, error: "Server busy, please retry." });
    }
    let rawContents = (e && e.postData && e.postData.contents) || "";
    if (!rawContents && e && e.parameter && e.parameter.postData) {
      rawContents = e.parameter.postData;
    }
    const request = JSON.parse(rawContents || "{}");
    validateRequest_(request);
    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName(request.sourceSheet);
    if (!sheet) throw new Error("Source sheet not found.");

    const target = request.kind === "inbound"
      ? findInboundTarget_(sheet, request)
      : findOutboundTarget_(sheet, request);

    const allowed = (request.kind === "inbound" ? INBOUND_STATUS : OUTBOUND_STATUS).map((value) => String(value).toUpperCase());
    const status = String(request.status || "").trim();
    if (!allowed.includes(status.toUpperCase())) throw new Error("Status is not allowed.");

    const current = String(target.getDisplayValue() || "").trim();
    const requestCurrent = String(request.currentStatus || "").trim();
    const normCurrent = current.toUpperCase();
    const normRequest = requestCurrent.toUpperCase();

    // Check concurrency, tolerating default status fallbacks ("" vs "SCHEDULED")
    // FIX: the old guard required normCurrent to be truthy AND then tested
    // normCurrent === "", which can never be true, so the "" / "SCHEDULED"
    // default-status pair was never actually tolerated.
    const DEFAULT_EQUIVALENT = ["", "SCHEDULED"];
    const bothDefaults = DEFAULT_EQUIVALENT.indexOf(normCurrent) !== -1 && DEFAULT_EQUIVALENT.indexOf(normRequest) !== -1;
    if (requestCurrent && normCurrent !== normRequest && !bothDefaults) {
      Logger.log("Concurrency note: Current='" + current + "', Request='" + requestCurrent + "'");
    }

    target.setValue(status);

    let inventoryTransfer = null;
    if (request.kind === "inbound" && INVENTORY_TRANSFER_STATUSES.includes(status.toUpperCase())) {
      inventoryTransfer = transferInboundInventory_(spreadsheet, request);
    }

    // Format row in Google Sheets: Grey out completed rows, reset active rows
    const rowIdx = target.getRow();
    const rowRange = sheet.getRange(rowIdx, 1, 1, Math.max(sheet.getLastColumn(), 1));
    const isCompleted = COMPLETED_STATUSES.includes(status.toUpperCase());
    if (isCompleted) {
      rowRange.setBackground("#E8EAED").setFontColor("#5F6368");
    } else {
      rowRange.setBackground(null).setFontColor(null);
    }

    SpreadsheetApp.flush();
    return json_({ ok: true, sheet: sheet.getName(), row: rowIdx, status, isCompleted, inventoryTransfer });
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  } finally {
    if (haveLock) lock.releaseLock();
  }
}

function validateRequest_(request) {
  if (!["outbound", "inbound"].includes(request.kind)) throw new Error("Invalid relation kind.");
  if (!ALLOWED_SHEETS.includes(request.sourceSheet)) throw new Error("Source sheet is not allowed.");
}

function importsSectionMarkerRow_(values, marker) {
  const wanted = String(marker || "").trim().toUpperCase();
  for (let r = 0; r < values.length; r++) {
    if (String(values[r][0] || "").trim().toUpperCase() === wanted) return r + 1;
  }
  return 0;
}

function inboundWriteToken_(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function inboundWriteTokens_(value) {
  return String(value || "")
    .split(/[\r\n,;|/]+/)
    .map(inboundWriteToken_)
    .filter(Boolean);
}

function findInboundTarget_(sheet, request) {
  const row = Number(request.sourceRow);
  if (!Number.isInteger(row) || row < 3 || row > sheet.getLastRow()) throw new Error("Invalid IMPORTS source row.");

  const values = sheet.getDataRange().getDisplayValues();
  const schedulingRow = importsSectionMarkerRow_(values, "SCHEDULING");
  const parcelsRow = importsSectionMarkerRow_(values, "PARCELS");
  const isParcel = Boolean(request.isSmallParcel);

  if (sheet.getName() === "IMPORTS") {
    if (isParcel) {
      if (!parcelsRow || row <= parcelsRow) throw new Error("Parcel write-back row is outside the PARCELS section.");
      const wantedTracking = inboundWriteToken_(request.trackingNumber || request.pro || request.shipmentNo);
      const rowTracking = [values[row - 1][1], values[row - 1][10]]
        .flatMap(inboundWriteTokens_);
      if (!wantedTracking || rowTracking.indexOf(wantedTracking) === -1) {
        throw new Error("Parcel source row no longer matches the selected tracking number.");
      }
    } else {
      if (schedulingRow && row >= schedulingRow) throw new Error("Import write-back row is at or below SCHEDULING.");
      const wanted = [request.shipmentNo, request.invoice, request.container, request.mbl, request.hbl]
        .flatMap(inboundWriteTokens_)
        .filter(Boolean);
      const rowTokens = values[row - 1].slice(0, 18)
        .flatMap(inboundWriteTokens_)
        .filter(Boolean);
      if (!wanted.length || !wanted.some(function (token) { return rowTokens.indexOf(token) !== -1; })) {
        throw new Error("Import source row no longer matches the selected shipment.");
      }
    }
  }

  const headers = values.slice(0, 3);
  const header = findHeader_(headers, ["WEBSITE STATUS", "STATUS", "INBOUND STATUS", "SHIPMENT STATUS"]);
  if (!header) throw new Error("Inbound status column not found.");
  return sheet.getRange(row, header.column);
}

function findOutboundTarget_(sheet, request) {
  const values = sheet.getDataRange().getDisplayValues();
  const header = findHeader_(values.slice(0, 4), ["WEBSITE STATUS", "STATUS", "WORK PROGRESS", "INBOUND STATUS", "SHIPMENT STATUS"]);
  if (!header) throw new Error("Status column not found.");
  const map = headerMap_(values[header.row - 1]);
  const sourceRow = Number(request.sourceRow);
  if (Number.isInteger(sourceRow) && sourceRow > header.row && sourceRow <= values.length) {
    return sheet.getRange(sourceRow, header.column);
  }
  const candidates = [];
  for (let r = header.row; r < values.length; r++) {
    const row = values[r];
    let score = 0;
    score += exact_(row, map, ["PRO#", "BOL", "BOL#"], request.pro) ? 100 : 0;
    score += exact_(row, map, ["INVOICE", "INVOICE NO.", "PO#"], request.invoice) ? 50 : 0;
    score += exact_(row, map, ["CUSTOMER", "NOTE", "DC"], request.customer) ? 20 : 0;
    score += exact_(row, map, ["SHIP DATE", "PU", "DATE"], request.shipDate) ? 10 : 0;
    if (score) candidates.push({ row: r + 1, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score)) {
    throw new Error("Could not identify one unique source row.");
  }
  return sheet.getRange(candidates[0].row, header.column);
}

function findHeader_(rows, names) {
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (names.includes(String(rows[r][c] || "").trim().toUpperCase())) return { row: r + 1, column: c + 1 };
    }
  }
  return null;
}

function headerMap_(headers) {
  return headers.reduce((map, value, index) => {
    map[String(value || "").trim().toUpperCase()] = index;
    return map;
  }, {});
}

function exact_(row, map, names, expected) {
  const wanted = String(expected || "").trim().toUpperCase();
  if (!wanted) return false;
  const wantedParts = wanted.split(/[\r\n,;·]+/).map(p => p.trim()).filter(Boolean);

  for (const name of names) {
    if (map[name] === undefined) continue;
    const cellVal = String(row[map[name]] || "").trim().toUpperCase();
    if (cellVal === wanted) return true;
    const parts = cellVal.split(/[\r\n,;·]+/).map(p => p.trim()).filter(Boolean);
    if (parts.some(p => wantedParts.includes(p))) return true;
  }
  return false;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

// ─── Inventory transfer (SKW_Inbound -> SKW_Stock) ─────────────────────────────
// Restored 2026-08-07 after being dropped during a Code.gs source reconciliation.
// See DEPLOYMENT_NOTE.md.

/**
 * Atomically posts matching SKW_Inbound product rows into SKW_Stock. Stock_Posted
 * and the composite Source_IB_ID make repeated completed-status requests idempotent.
 */
function transferInboundInventory_(spreadsheet, request) {
  const inbound = spreadsheet.getSheetByName(SKW_INBOUND_SHEET);
  const stock = spreadsheet.getSheetByName(SKW_STOCK_SHEET);
  if (!inbound || !stock) throw new Error("SKW inventory backend tabs are missing.");
  if (inbound.getLastRow() < 2) return { movedRows: 0, quantity: 0 };

  const values = inbound.getDataRange().getDisplayValues();
  const map = headerMap_(values[0]);
  ["IB_ID", "SKU", "PRODUCT_DESCRIPTION", "QTY_EA", "STATUS", "STOCK_POSTED"].forEach(function (header) {
    if (map[header] === undefined) throw new Error(SKW_INBOUND_SHEET + " is missing " + header + ".");
  });
  const references = [request.shipmentNo, request.invoice, request.container, request.mbl, request.hbl]
    .flatMap(referenceTokens_)
    .filter(Boolean);
  if (!references.length) throw new Error("Inventory transfer requires a shipment reference.");

  const rows = [];
  for (let index = 1; index < values.length; index++) {
    const row = values[index];
    const posted = String(row[map["STOCK_POSTED"]] || "").trim().toUpperCase();
    if (/^(TRUE|YES|POSTED|1)$/.test(posted)) continue;
    const rowStatus = String(row[map["STATUS"]] || "").trim().toUpperCase();
    if (COMPLETED_STATUSES.includes(rowStatus)) continue;
    const candidates = [row[map["IB_ID"]], row[map["PO_NUMBER"]], row[map["SOURCE_MSG_ID"]]]
      .flatMap(referenceTokens_)
      .filter(Boolean);
    if (references.some(function (reference) { return candidates.some(function (candidate) { return referencesMatch_(reference, candidate); }); })) {
      rows.push({ rowNumber: index + 1, values: row });
    }
  }
  if (!rows.length) return { movedRows: 0, quantity: 0 };

  const stockValues = stock.getDataRange().getDisplayValues();
  const stockMap = headerMap_(stockValues[0]);
  ["SKU", "UPC", "PRODUCT_DESCRIPTION", "BATCH_NO", "EXPIRY_DATE", "QTY_EA", "LOCATION", "SOURCE_IB_ID", "RECEIVED_AT", "UPDATED_AT"].forEach(function (header) {
    if (stockMap[header] === undefined) throw new Error(SKW_STOCK_SHEET + " is missing " + header + ".");
  });
  const postedKeys = new Set(stockValues.slice(1).map(function (row) {
    return String(row[stockMap["SOURCE_IB_ID"]] || "").trim().toUpperCase();
  }).filter(Boolean));

  let totalQuantity = 0;
  let movedRows = 0;
  const now = new Date();
  rows.forEach(function (record) {
    const row = record.values;
    const ibId = row[map["IB_ID"]] || request.shipmentNo || request.invoice || "";
    const sku = row[map["SKU"]] || "";
    const upc = row[map["UPC"]] || "";
    const product = row[map["PRODUCT_DESCRIPTION"]] || "";
    const batch = row[map["BATCH_NO"]] || "";
    const expiration = row[map["EXPIRY_DATE"]] || "";
    const quantity = Number(String(row[map["QTY_EA"]] || "0").replace(/,/g, "")) || 0;
    if (quantity <= 0) return;
    const location = row[map["LOCATION"]] || "UNASSIGNED";
    const sourceKey = [ibId, sku || upc, batch, expiration]
      .map(function (value) { return String(value || "").trim().toUpperCase(); })
      .join("::");
    if (postedKeys.has(sourceKey)) {
      inbound.getRange(record.rowNumber, map["STOCK_POSTED"] + 1).setValue(true);
      return;
    }
    stock.appendRow([sku, upc, product, batch, expiration, quantity, location, sourceKey, now, now]);
    postedKeys.add(sourceKey);
    if (map["RECEIVED_DATE"] !== undefined) inbound.getRange(record.rowNumber, map["RECEIVED_DATE"] + 1).setValue(now);
    inbound.getRange(record.rowNumber, map["STATUS"] + 1).setValue("Received");
    inbound.getRange(record.rowNumber, map["STOCK_POSTED"] + 1).setValue(true);
    totalQuantity += quantity;
    movedRows++;
  });
  return { movedRows, quantity: totalQuantity };
}

function referenceTokens_(value) {
  return String(value || "")
    .split(/[\r\n,;|]+/)
    .map(function (token) { return token.trim().toUpperCase(); })
    .filter(Boolean);
}

function referencesMatch_(left, right) {
  const a = String(left || "").replace(/[^A-Z0-9]/g, "");
  const b = String(right || "").replace(/[^A-Z0-9]/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (shorter < 8) return false;
  if (shorter / longer < 0.6) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Periodically scans external "WMS PROMOTION" workbook sheet (14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I)
 * for rows where "Shipping Method" is "Trucking", combines multiple invoices
 * for the same customer & ship date into one entry, and imports/updates into "WH Trucking Request".
 */
function scanAndImportWmsTruckingOrders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: "Lock timeout" };

  try {
    const sourceSpreadsheet = SpreadsheetApp.openById(WMS_SPREADSHEET_ID);
    const targetSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sourceSheet = sourceSpreadsheet.getSheetByName("Stylekorean");
    const targetSheet = targetSpreadsheet.getSheetByName("WH Trucking Request");
    if (!sourceSheet || !targetSheet) throw new Error("Required source or target sheet is missing.");

    const sourceData = sourceSheet.getDataRange().getDisplayValues();
    const sourceHeader = findWmsTruckingHeader_(sourceData);
    const sourceMap = sourceHeader.map;
    const requiredSource = ["INVOICE#", "CUSTOMER NAME", "SHIP OUT DATE", "SHIPPING METHOD"];
    requiredSource.forEach(function (name) {
      if (sourceMap[name] === undefined) throw new Error("WMS Stylekorean is missing header: " + name);
    });

    const groups = new Map();
    for (let r = sourceHeader.rowIndex + 1; r < sourceData.length; r++) {
      const row = sourceData[r];
      const method = String(row[sourceMap["SHIPPING METHOD"]] || "").trim().toUpperCase();
      if (!method.includes("TRUCKING")) continue;

      const invoice = String(row[sourceMap["INVOICE#"]] || "").trim().toUpperCase();
      const rawCustomer = String(row[sourceMap["CUSTOMER NAME"]] || "").trim();
      const rawShipDate = String(row[sourceMap["SHIP OUT DATE"]] || "").trim();
      if (!invoice || !rawCustomer || !rawShipDate) continue;

      const customer = canonicalWmsCustomer_(rawCustomer);
      const dateInfo = normalizeWmsShipDate_(rawShipDate);
      const key = normalizeWmsCustomerKey_(customer) + "___" + dateInfo.key;
      if (!groups.has(key)) {
        groups.set(key, {
          customer: customer,
          shipDate: dateInfo.display,
          invoices: [],
          amounts: [],
          sourceRows: []
        });
      }
      const group = groups.get(key);
      if (!group.invoices.includes(invoice)) group.invoices.push(invoice);
      if (sourceMap["INVOICE AMOUNT"] !== undefined) {
        const amount = parseWmsAmount_(row[sourceMap["INVOICE AMOUNT"]]);
        if (amount !== null) group.amounts.push(amount);
      }
      group.sourceRows.push(r + 1);
    }

    const targetLastRow = Math.max(targetSheet.getLastRow(), 5);
    const targetLastColumn = Math.max(targetSheet.getLastColumn(), 24);
    const targetData = targetSheet.getRange(1, 1, targetLastRow, targetLastColumn).getDisplayValues();
    const targetHeader = findWhTruckingHeader_(targetData);
    const targetMap = targetHeader.map;
    ["CUSTOMER", "INVOICE NO.", "SHIP DATE"].forEach(function (name) {
      if (targetMap[name] === undefined) throw new Error("WH Trucking Request is missing header: " + name);
    });

    const existingByKey = new Map();
    const existingByInvoice = new Map();
    let lastBusinessRow = targetHeader.rowIndex + 1;

    for (let r = targetHeader.rowIndex + 1; r < targetData.length; r++) {
      const row = targetData[r];
      const customer = exactVal_(row, targetMap, ["CUSTOMER"]);
      const shipDate = exactVal_(row, targetMap, ["SHIP DATE"]);
      const invoiceCell = exactVal_(row, targetMap, ["INVOICE NO.", "INVOICE #", "INVOICE"]);
      if (customer || shipDate || invoiceCell) lastBusinessRow = r + 1;

      if (customer && shipDate) {
        const dateInfo = normalizeWmsShipDate_(shipDate);
        existingByKey.set(normalizeWmsCustomerKey_(canonicalWmsCustomer_(customer)) + "___" + dateInfo.key, r + 1);
      }
      splitWmsInvoices_(invoiceCell).forEach(function (invoice) {
        existingByInvoice.set(invoice, r + 1);
      });
    }

    let imported = 0;
    let updated = 0;
    const pendingRows = [];
    const width = Math.max(targetLastColumn, 24);

    groups.forEach(function (group, key) {
      group.invoices.sort();
      let rowNumber = existingByKey.get(key);
      if (!rowNumber) {
        for (let i = 0; i < group.invoices.length && !rowNumber; i++) {
          rowNumber = existingByInvoice.get(group.invoices[i]);
        }
      }

      const invoiceText = group.invoices.join("\n");
      const totalAmount = group.amounts.reduce(function (sum, value) { return sum + value; }, 0);

      if (rowNumber) {
        const range = targetSheet.getRange(rowNumber, 1, 1, width);
        const values = range.getValues()[0];
        let changed = false;
        changed = setMappedValue_(values, targetMap, "CUSTOMER", group.customer) || changed;
        changed = setMappedValue_(values, targetMap, "INVOICE NO.", invoiceText) || changed;
        changed = setMappedValue_(values, targetMap, "SHIP DATE", group.shipDate) || changed;
        if (totalAmount > 0 && targetMap["VALUE"] !== undefined && !values[targetMap["VALUE"]]) {
          values[targetMap["VALUE"]] = totalAmount;
          changed = true;
        }
        if (targetMap["STATUS"] !== undefined && !values[targetMap["STATUS"]]) {
          values[targetMap["STATUS"]] = "WORK IN PROGRESS";
          changed = true;
        }
        if (changed) {
          range.setValues([values]);
          updated++;
        }
      } else {
        const row = new Array(width).fill("");
        row[targetMap["CUSTOMER"]] = group.customer;
        row[targetMap["INVOICE NO."]] = invoiceText;
        row[targetMap["SHIP DATE"]] = group.shipDate;
        if (targetMap["VALUE"] !== undefined && totalAmount > 0) row[targetMap["VALUE"]] = totalAmount;
        if (targetMap["STATUS"] !== undefined) row[targetMap["STATUS"]] = "WORK IN PROGRESS";
        pendingRows.push(row);
        imported++;
      }
    });

    if (pendingRows.length) {
      const startRow = lastBusinessRow + 1;
      targetSheet.getRange(startRow, 1, pendingRows.length, width).setValues(pendingRows);
      const exemplarRow = Math.max(targetHeader.rowIndex + 2, lastBusinessRow);
      targetSheet.getRange(exemplarRow, 1, 1, width).copyTo(
        targetSheet.getRange(startRow, 1, pendingRows.length, width),
        SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
        false
      );
    }

    SpreadsheetApp.flush();
    Logger.log("WMS trucking sync: groups=" + groups.size + ", imported=" + imported + ", updated=" + updated);
    return { ok: true, groups: groups.size, imported: imported, updated: updated, nextRow: lastBusinessRow + pendingRows.length + 1 };
  } catch (error) {
    Logger.log("Error in scanAndImportWmsTruckingOrders: " + error.message);
    return { ok: false, error: error.message };
  } finally {
    lock.releaseLock();
  }
}

function findWmsTruckingHeader_(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const map = headerMap_(rows[r]);
    if (map["INVOICE#"] !== undefined && map["CUSTOMER NAME"] !== undefined &&
        map["SHIP OUT DATE"] !== undefined && map["SHIPPING METHOD"] !== undefined) {
      return { rowIndex: r, map: map };
    }
  }
  throw new Error("Could not locate the WMS Stylekorean header row.");
}

function findWhTruckingHeader_(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const map = headerMap_(rows[r]);
    if (map["CUSTOMER"] !== undefined && map["INVOICE NO."] !== undefined && map["SHIP DATE"] !== undefined) {
      return { rowIndex: r, map: map };
    }
  }
  throw new Error("Could not locate the WH Trucking Request header row.");
}

function normalizeWmsCustomerKey_(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(INC|INCORPORATED|LLC|L L C|CORP|CORPORATION)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalWmsCustomer_(value) {
  const raw = String(value || "").trim();
  const key = normalizeWmsCustomerKey_(raw);
  const aliases = {
    "BEAUTIFYME COSMETICS": "BEAUTIFYME",
    "BEAUTIFYME": "BEAUTIFYME",
    "TOKTOK BEAUTY TEAMZL LC": "TOKTOK BEAUTY",
    "TOKTOK BEAUTY": "TOKTOK BEAUTY",
    "ROYAL IMEX": "ROYAL IMEX INC",
    "GLOWISS": "GLOWISS",
    "GLOWISS LLC": "GLOWISS"
  };
  return aliases[key] || raw.toUpperCase().replace(/\s+/g, " ").trim();
}

function normalizeWmsShipDate_(value) {
  const text = String(value || "").trim();
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) {
    return { key: text.toUpperCase(), display: text };
  }
  const zone = Session.getScriptTimeZone() || "America/Los_Angeles";
  return {
    key: Utilities.formatDate(parsed, zone, "yyyy-MM-dd"),
    display: Utilities.formatDate(parsed, zone, "MM/dd/yyyy")
  };
}

function parseWmsAmount_(value) {
  const text = String(value || "").replace(/[$,\s]/g, "");
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

function splitWmsInvoices_(value) {
  return String(value || "")
    .toUpperCase()
    .split(/[\r\n,;·/]+/)
    .map(function (item) { return item.trim(); })
    .filter(Boolean);
}

function setMappedValue_(row, map, header, value) {
  const index = map[header];
  if (index === undefined || value === undefined || value === null) return false;
  if (String(row[index] || "").trim() === String(value).trim()) return false;
  row[index] = value;
  return true;
}

function exactVal_(row, map, names) {
  for (const n of names) {
    if (map[n] !== undefined && row[map[n]]) return String(row[map[n]]).trim();
  }
  return "";
}

/**
 * Creates or resets the 15-minute WMS Trucking sync trigger.
 * Only this handler's triggers are replaced; unrelated project triggers are preserved.
 */
function createTimeDrivenTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "scanAndImportWmsTruckingOrders") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger("scanAndImportWmsTruckingOrders")
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log("15-minute trigger provisioned for scanAndImportWmsTruckingOrders");
}

/** Backward-compatible entry point for anyone who previously used this name. */
function create30MinTrigger() {
  return createTimeDrivenTrigger();
}

/**
 * Adds "WEBSITE STATUS" dropdown data validation column at the end of each source sheet
 * in LOGISTICS MASTER 2026, applying the same validation rules as Column AE of IMPORTS.
 * Explicitly excludes external sheets 14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I and 12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8.
 */
function addWebsiteStatusDropdownToAllSourceSheets() {
  const EXCLUDED_SPREADSHEET_IDS = [
    "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I",
    "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8"
  ];
  
  const targetSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  if (EXCLUDED_SPREADSHEET_IDS.includes(targetSpreadsheet.getId())) {
    Logger.log("Target spreadsheet is in excluded list. Skipping.");
    return { ok: false, error: "Spreadsheet excluded." };
  }

  const TARGET_SOURCE_TABS = [
    "TRANSFERS",
    "ULTA",
    "IHERB",
    "B2B/E-COM TRUCKING",
    "WH Trucking Request",
    "NATIONAL ORDER PROGRESS",
    "Outbound Shipping Schedule",
    "TJX/ROSS"
  ];

  const STATUS_LIST = [
    "SCHEDULED",
    "WORK IN PROGRESS",
    "PENDING",
    "SHIPPING",
    "SHIPPED",
    "DELIVERED",
    "RECEIVED",
    "CANCELLED",
    "COMPLETED"
  ];

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_LIST, true)
    .setAllowInvalid(false)
    .setHelpText("Select a valid Website Status from the list.")
    .build();

  let modifiedCount = 0;

  TARGET_SOURCE_TABS.forEach((tabName) => {
    const sheet = targetSpreadsheet.getSheetByName(tabName);
    if (!sheet) {
      Logger.log("Sheet tab not found: " + tabName);
      return;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return;

    // Detect header row and column
    const headers = sheet.getRange(1, 1, Math.min(3, lastRow), sheet.getLastColumn()).getDisplayValues();
    let headerRowIdx = 1;
    let colIdx = -1;

    for (let r = 0; r < headers.length; r++) {
      const row = headers[r].map(c => String(c || "").trim().toUpperCase());
      const foundIdx = row.indexOf("WEBSITE STATUS");
      if (foundIdx !== -1) {
        headerRowIdx = r + 1;
        colIdx = foundIdx + 1;
        break;
      }
    }

    // If column doesn't exist, append header to last column + 1
    if (colIdx === -1) {
      colIdx = sheet.getLastColumn() + 1;
      headerRowIdx = 2; // Default header row index for standard tabs
      sheet.getRange(headerRowIdx, colIdx).setValue("WEBSITE STATUS").setFontWeight("bold");
    }

    // Apply data validation rule down the column
    const startRow = headerRowIdx + 1;
    const numRows = Math.max(lastRow - headerRowIdx, 100);
    const range = sheet.getRange(startRow, colIdx, numRows, 1);
    range.setDataValidation(rule);

    modifiedCount++;
    Logger.log("Applied WEBSITE STATUS dropdown to sheet: " + tabName + " (Col " + colIdx + ")");
  });

  SpreadsheetApp.flush();
  return { ok: true, sheetsUpdated: modifiedCount };
}
