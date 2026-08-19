const SPREADSHEET_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const WMS_SPREADSHEET_ID = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";

const OUTBOUND_STATUS = ["", "SCHEDULED", "WORK IN PROGRESS", "PENDING", "SHIPPING", "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED"];
const INBOUND_STATUS = ["", "SCHEDULED", "WORK IN PROGRESS", "PENDING", "SHIPPING", "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED", "N/A", "Customs Clearance", "FDA Review/Hold", "FWS Review/Hold", "Delayed"];
const ALLOWED_SHEETS = ["WH Trucking Request", "B2B/E-COM TRUCKING", "TRANSFERS", "ULTA", "IHERB", "IMPORTS", "NATIONAL ORDER PROGRESS", "Outbound Shipping Schedule", "TJX/ROSS"];

const COMPLETED_STATUSES = ["SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED"];
const INVENTORY_TRANSFER_STATUSES = ["DELIVERED", "RECEIVED", "COMPLETED"];
const SKW_INBOUND_SHEET = "SKW_Inbound";
const SKW_STOCK_SHEET = "SKW_Stock";

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
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

    // Prevent stale browser state from overwriting a newer workbook value.
    const scheduledFallback = (!normCurrent && normRequest === "SCHEDULED") || (normCurrent === "SCHEDULED" && !normRequest);
    if (requestCurrent && normCurrent !== normRequest && !scheduledFallback) {
      throw new Error("Status changed in Google Sheets. Refresh and try again.");
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
    lock.releaseLock();
  }
}

function validateRequest_(request) {
  if (!["outbound", "inbound"].includes(request.kind)) throw new Error("Invalid relation kind.");
  if (!ALLOWED_SHEETS.includes(request.sourceSheet)) throw new Error("Source sheet is not allowed.");
}

function findInboundTarget_(sheet, request) {
  const row = Number(request.sourceRow);
  if (!Number.isInteger(row) || row < 3 || row > sheet.getLastRow()) throw new Error("Invalid IMPORTS source row.");
  const headers = sheet.getRange(1, 1, 3, sheet.getLastColumn()).getDisplayValues();
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

/**
 * Periodically scans external "WMS Invoice and Issues" sheet (14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I)
 * for rows where "Shipping Method" is "Trucking", combines multiple invoices
 * for the same customer & ship date into one entry, and imports/updates into "WH Trucking Request".
 */
function scanAndImportWmsTruckingOrders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: "Lock timeout" };
  try {
    let wmsSpreadsheet;
    try {
      wmsSpreadsheet = SpreadsheetApp.openById(WMS_SPREADSHEET_ID);
    } catch (e) {
      wmsSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    }
    const targetSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);

    const sourceSheet = wmsSpreadsheet.getSheets()[0]; // First sheet in WMS workbook
    const targetSheet = targetSpreadsheet.getSheetByName("WH Trucking Request");
    if (!sourceSheet || !targetSheet) {
      Logger.log("WMS Source sheet or WH Trucking Request sheet not found.");
      return { ok: false, error: "Source or Target sheet missing." };
    }

    const sourceData = sourceSheet.getDataRange().getDisplayValues();
    if (sourceData.length < 2) return { ok: true, imported: 0, updated: 0 };


    // Locate header row in WMS sheet
    let headerRowIdx = -1;
    let shipMethodColIdx = -1;
    let invoiceColIdx = -1;
    let customerColIdx = -1;
    let shipDateColIdx = -1;
    let palletColIdx = -1;
    let carrierColIdx = -1;
    let proColIdx = -1;
    let noteColIdx = -1;

    for (let r = 0; r < Math.min(5, sourceData.length); r++) {
      const row = sourceData[r].map(c => String(c || "").trim().toUpperCase());
      for (let c = 0; c < row.length; c++) {
        const val = row[c];
        if (shipMethodColIdx === -1 && (val.includes("SHIPPING METHOD") || val.includes("SHIP METHOD"))) shipMethodColIdx = c;
        if (invoiceColIdx === -1 && (val.includes("INVOICE") || val.includes("PO#") || val.includes("PO NUMBER"))) invoiceColIdx = c;
        if (customerColIdx === -1 && (val.includes("CUSTOMER") || val.includes("CLIENT") || val.includes("ACCOUNT"))) customerColIdx = c;
        if (shipDateColIdx === -1 && (val.includes("SHIP DATE") || val.includes("DATE") || val.includes("PU DATE"))) shipDateColIdx = c;
        if (palletColIdx === -1 && (val.includes("PALLET") || val.includes("PLT") || val.includes("QTY") || val.includes("CARTONS"))) palletColIdx = c;
        if (carrierColIdx === -1 && (val.includes("CARRIER") || val.includes("TRUCKING"))) carrierColIdx = c;
        if (proColIdx === -1 && (val.includes("PRO#") || val.includes("PRO") || val.includes("TRACKING") || val.includes("BOL"))) proColIdx = c;
        if (noteColIdx === -1 && (val.includes("NOTE") || val.includes("REMARK") || val.includes("MEMO") || val.includes("ISSUE"))) noteColIdx = c;
      }
      if (shipMethodColIdx !== -1) {
        headerRowIdx = r;
        break;
      }
    }

    if (shipMethodColIdx === -1) {
      Logger.log("Shipping Method column not found in WMS sheet.");
      return { ok: false, error: "Shipping Method column missing." };
    }

    // Group Trucking entries by (Customer + Ship Date)
    const groups = new Map();
    for (let r = headerRowIdx + 1; r < sourceData.length; r++) {
      const row = sourceData[r];
      const shipMethod = String(row[shipMethodColIdx] || "").trim();
      if (!/\bTRUCK(?:ING)?\b/i.test(shipMethod)) continue;

      const invoice = invoiceColIdx !== -1 ? String(row[invoiceColIdx] || "").trim() : "";
      const customer = customerColIdx !== -1 ? String(row[customerColIdx] || "").trim() : "";
      const shipDate = shipDateColIdx !== -1 ? String(row[shipDateColIdx] || "").trim() : "";
      const pallets = palletColIdx !== -1 ? String(row[palletColIdx] || "").trim() : "";
      const carrier = carrierColIdx !== -1 ? String(row[carrierColIdx] || "").trim() : "";
      const pro = proColIdx !== -1 ? String(row[proColIdx] || "").trim() : "";
      const note = noteColIdx !== -1 ? String(row[noteColIdx] || "").trim() : "";

      const normCust = customer.toUpperCase().replace(/\s+/g, " ").trim();
      const normDate = normalizeWmsShipDate_(shipDate);
      const groupKey = normCust ? (normCust + "___" + normDate) : ("UNKNOWN___" + r);

      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push({ invoice, customer, shipDate, pallets, carrier, pro, note, rowIndex: r + 1 });
    }

    // Load target sheet existing rows to avoid duplicates
    const targetData = targetSheet.getDataRange().getDisplayValues();
    const targetHeaders = targetData.length > 0 ? targetData[1] || targetData[0] : [];
    const targetMap = headerMap_(targetHeaders);

    const existingRowsMap = new Map(); // key -> row index (1-based)
    const existingInvoiceRowsMap = new Map(); // invoice -> row indices
    for (let r = 2; r < targetData.length; r++) {
      const row = targetData[r];
      const invs = exactVal_(row, targetMap, ["INVOICE NO.", "INVOICE #", "INVOICE"]).split(/[\r\n,;·]+/);
      const cust = exactVal_(row, targetMap, ["CUSTOMER"]).toUpperCase().replace(/\s+/g, " ").trim();
      const date = normalizeWmsShipDate_(exactVal_(row, targetMap, ["SHIP DATE"]));
      
      if (cust && date) existingRowsMap.set(cust + "___" + date, r + 1);
      invs.forEach(function(inv) {
        const cleanInv = inv.trim().toUpperCase();
        if (!cleanInv) return;
        if (!existingInvoiceRowsMap.has(cleanInv)) existingInvoiceRowsMap.set(cleanInv, new Set());
        existingInvoiceRowsMap.get(cleanInv).add(r + 1);
      });
    }

    let importedCount = 0;
    let updatedCount = 0;
    let skippedRescheduledCount = 0;

    groups.forEach((items, groupKey) => {
      const customer = items[0].customer;
      const shipDate = items[0].shipDate;
      const combinedInvoices = [...new Set(items.map(i => i.invoice).filter(Boolean))].join("\n");
      const combinedCarrier = items.map(i => i.carrier).find(Boolean) || "Trucking";
      const combinedPro = [...new Set(items.map(i => i.pro).filter(Boolean))].join("\n");
      const combinedPallets = [...new Set(items.map(i => i.pallets).filter(Boolean))].join(" · ");
      const combinedNote = [...new Set(items.map(i => i.note).filter(Boolean))].join(" · ") || "Imported from WMS Invoice & Issues";

      const normCust = customer.toUpperCase().replace(/\s+/g, " ").trim();
      const normDate = normalizeWmsShipDate_(shipDate);
      const matchKey = normCust + "___" + normDate;
      
      let matchedRowIdx = existingRowsMap.get(matchKey);
      if (!matchedRowIdx) {
        const invoiceMatches = new Set();
        items.forEach(function(item) {
          const rows = existingInvoiceRowsMap.get(String(item.invoice || "").trim().toUpperCase());
          if (rows) rows.forEach(function(rowNumber) { invoiceMatches.add(rowNumber); });
        });
        if (invoiceMatches.size === 1) {
          const candidateRow = Number([...invoiceMatches][0]);
          const candidateDate = normalizeWmsShipDate_(
            exactVal_(targetData[candidateRow - 1], targetMap, ["SHIP DATE"])
          );
          if (candidateDate === normDate) {
            matchedRowIdx = candidateRow;
          } else {
            skippedRescheduledCount++;
            return;
          }
        } else if (invoiceMatches.size > 1) {
          skippedRescheduledCount++;
          return;
        }
      }

      if (matchedRowIdx) {
        // Update existing entry if invoice list or fields changed
        const rowRange = targetSheet.getRange(matchedRowIdx, 1, 1, Math.max(targetHeaders.length, 21));
        const currentVals = rowRange.getDisplayValues()[0];

        const invCol = targetMap["INVOICE NO."] !== undefined ? targetMap["INVOICE NO."] : targetMap["INVOICE #"];
        if (invCol !== undefined && combinedInvoices) {
          const curInvs = String(currentVals[invCol] || "").trim();
          const mergedInvoices = [...new Set(
            [curInvs, combinedInvoices]
              .join("\n")
              .split(/[\r\n,;·]+/)
              .map(function(invoice) { return invoice.trim(); })
              .filter(Boolean)
          )].join("\n");
          if (curInvs !== mergedInvoices) {
            targetSheet.getRange(matchedRowIdx, invCol + 1).setValue(mergedInvoices);
            updatedCount++;
          }
        }
      } else {
        // Append new combined entry for customer + ship date
        const newRow = new Array(Math.max(targetHeaders.length, 21)).fill("");
        if (targetMap["CUSTOMER"] !== undefined) newRow[targetMap["CUSTOMER"]] = customer;
        if (targetMap["INVOICE NO."] !== undefined) newRow[targetMap["INVOICE NO."]] = combinedInvoices;
        else if (targetMap["INVOICE #"] !== undefined) newRow[targetMap["INVOICE #"]] = combinedInvoices;
        if (targetMap["SHIP DATE"] !== undefined) newRow[targetMap["SHIP DATE"]] = shipDate;
        if (targetMap["PALLET TYPE"] !== undefined) newRow[targetMap["PALLET TYPE"]] = combinedPallets;
        if (targetMap["CARRIER"] !== undefined) newRow[targetMap["CARRIER"]] = combinedCarrier;
        if (targetMap["PRO#"] !== undefined) newRow[targetMap["PRO#"]] = combinedPro;
        if (targetMap["NOTE"] !== undefined) newRow[targetMap["NOTE"]] = combinedNote;
        if (targetMap["STATUS"] !== undefined) newRow[targetMap["STATUS"]] = "WORK IN PROGRESS";

        targetSheet.appendRow(newRow);
        importedCount++;
      }
    });

    SpreadsheetApp.flush();
    Logger.log("WMS Scan completed. Combined Groups: " + groups.size + ", Imported: " + importedCount + ", Updated: " + updatedCount + ", Rescheduled skipped: " + skippedRescheduledCount);
    return { ok: true, groups: groups.size, imported: importedCount, updated: updatedCount, skippedRescheduled: skippedRescheduledCount };
  } catch (err) {
    Logger.log("Error in scanAndImportWmsTruckingOrders: " + err.message);
    return { ok: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

function exactVal_(row, map, names) {
  for (const n of names) {
    if (map[n] !== undefined && row[map[n]]) return String(row[map[n]]).trim();
  }
  return "";
}

function normalizeWmsShipDate_(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return text.toUpperCase();
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  return [year, String(Number(match[1])).padStart(2, "0"), String(Number(match[2])).padStart(2, "0")].join("-");
}

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
  ["IB_ID", "SKU", "PRODUCT_DESCRIPTION", "QTY_EA", "STATUS", "STOCK_POSTED"].forEach(function(header) {
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
    const candidates = [row[map["IB_ID"]], row[map["PO_NUMBER"]], row[map["SOURCE_MSG_ID"]]]
      .flatMap(referenceTokens_)
      .filter(Boolean);
    if (references.some(function(reference) { return candidates.some(function(candidate) { return referencesMatch_(reference, candidate); }); })) {
      rows.push({ rowNumber: index + 1, values: row });
    }
  }
  if (!rows.length) return { movedRows: 0, quantity: 0 };

  const stockValues = stock.getDataRange().getDisplayValues();
  const stockMap = headerMap_(stockValues[0]);
  ["SKU", "UPC", "PRODUCT_DESCRIPTION", "BATCH_NO", "EXPIRY_DATE", "QTY_EA", "LOCATION", "SOURCE_IB_ID", "RECEIVED_AT", "UPDATED_AT"].forEach(function(header) {
    if (stockMap[header] === undefined) throw new Error(SKW_STOCK_SHEET + " is missing " + header + ".");
  });
  const postedKeys = new Set(stockValues.slice(1).map(function(row) {
    return String(row[stockMap["SOURCE_IB_ID"]] || "").trim().toUpperCase();
  }).filter(Boolean));

  let totalQuantity = 0;
  let movedRows = 0;
  const now = new Date();
  rows.forEach(function(record) {
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
      .map(function(value) { return String(value || "").trim().toUpperCase(); })
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
    .map(function(token) { return token.trim().toUpperCase(); })
    .filter(Boolean);
}

function referencesMatch_(left, right) {
  const a = String(left || "").replace(/[^A-Z0-9]/g, "");
  const b = String(right || "").replace(/[^A-Z0-9]/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a));
}

/**
 * Creates or resets the 30-minute time-driven trigger for WMS Trucking scanner.
 * Deletes all obsolete/legacy triggers in the project to ensure a clean schedule.
 */
function create30MinTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    const handler = triggers[i].getHandlerFunction();
    if (handler === "scanAndImportWmsTruckingOrders") {
      ScriptApp.deleteTrigger(triggers[i]);
      Logger.log("Deleted existing trigger for handler: " + handler);
    }
  }

  ScriptApp.newTrigger("scanAndImportWmsTruckingOrders")
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log("30-minute WMS trigger provisioned without changing Gmail or inventory triggers.");
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

/**
 * Deletes non-essential tabs ("Dimensions", "Reference", "Summary", "Dashboard", "Outbound Data", "Inbound_Data")
 * from LOGISTICS MASTER 2026.
 */
function deleteUnnecessaryTabs() {
  const targetSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const tabsToDelete = [
    "Dimensions", "Reference", "Summary", "Dashboard",
    "Outbound Data", "Inbound_Data", "Inbound Data",
    "DIMENSIONS", "REFERENCE", "SUMMARY", "DASHBOARD",
    "OUTBOUND DATA", "INBOUND_DATA", "INBOUND DATA"
  ];
  
  let deletedCount = 0;
  tabsToDelete.forEach((tabName) => {
    const sheet = targetSpreadsheet.getSheetByName(tabName);
    if (sheet) {
      targetSpreadsheet.deleteSheet(sheet);
      deletedCount++;
      Logger.log("Deleted non-essential sheet tab: " + tabName);
    }
  });

  SpreadsheetApp.flush();
  return { ok: true, tabsDeleted: deletedCount };
}
