const SPREADSHEET_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";

const OUTBOUND_STATUS = ["", "SCHEDULED", "WORK IN PROGRESS", "PENDING", "SHIPPING", "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED"];
const INBOUND_STATUS = ["", "SCHEDULED", "WORK IN PROGRESS", "PENDING", "SHIPPING", "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED", "N/A", "Customs Clearance", "FDA Review/Hold", "FWS Review/Hold", "Delayed"];
const ALLOWED_SHEETS = ["WH Trucking Request", "B2B/E-COM TRUCKING", "TRANSFERS", "ULTA", "IHERB", "IMPORTS", "NATIONAL ORDER PROGRESS", "Outbound Shipping Schedule", "TJX/ROSS"];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const request = JSON.parse((e && e.postData && e.postData.contents) || "{}");
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
    if (String(request.currentStatus || "").trim() && current !== String(request.currentStatus).trim()) {
      throw new Error("Status changed in Google Sheets. Refresh and try again.");
    }

    target.setValue(status);
    SpreadsheetApp.flush();
    return json_({ ok: true, sheet: sheet.getName(), row: target.getRow(), status });
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
  const header = findHeader_(headers, ["STATUS", "INBOUND STATUS"]);
  if (!header) throw new Error("Inbound status column not found.");
  return sheet.getRange(row, header.column);
}

function findOutboundTarget_(sheet, request) {
  const values = sheet.getDataRange().getDisplayValues();
  const header = findHeader_(values.slice(0, 4), ["STATUS"]);
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
  return names.some(name => map[name] !== undefined && String(row[map[name]] || "").trim().toUpperCase() === wanted);
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Periodically scans "WMS Invoice and Issues" (or "WMS Invoice & Issues") sheet
 * for rows where "Shipping Method" is "Trucking", and imports new/modified rows into "WH Trucking Request".
 */
function scanAndImportWmsTruckingOrders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: "Lock timeout" };
  try {
    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sourceSheet = spreadsheet.getSheetByName("WMS Invoice and Issues") ||
                        spreadsheet.getSheetByName("WMS Invoice & Issues") ||
                        spreadsheet.getSheetByName("WMS INVOICE AND ISSUES");
    const targetSheet = spreadsheet.getSheetByName("WH Trucking Request");
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

    // Load target sheet existing rows to avoid duplicates
    const targetData = targetSheet.getDataRange().getDisplayValues();
    const targetHeaders = targetData.length > 0 ? targetData[1] || targetData[0] : [];
    const targetMap = headerMap_(targetHeaders);

    const existingKeys = new Map(); // key -> row index 1-based
    for (let r = 2; r < targetData.length; r++) {
      const row = targetData[r];
      const inv = exactVal_(row, targetMap, ["INVOICE NO.", "INVOICE #", "INVOICE"]);
      const cust = exactVal_(row, targetMap, ["CUSTOMER"]);
      const pro = exactVal_(row, targetMap, ["PRO#", "PRO", "TRACKING#"]);
      const key = (inv || pro || (cust + "_" + r)).toUpperCase();
      if (key) existingKeys.set(key, r + 1);
    }

    let importedCount = 0;
    let updatedCount = 0;

    for (let r = headerRowIdx + 1; r < sourceData.length; r++) {
      const row = sourceData[r];
      const shipMethod = String(row[shipMethodColIdx] || "").trim();
      if (shipMethod.toUpperCase() !== "TRUCKING") continue;

      const invoice = invoiceColIdx !== -1 ? String(row[invoiceColIdx] || "").trim() : "";
      const customer = customerColIdx !== -1 ? String(row[customerColIdx] || "").trim() : "";
      const shipDate = shipDateColIdx !== -1 ? String(row[shipDateColIdx] || "").trim() : "";
      const pallets = palletColIdx !== -1 ? String(row[palletColIdx] || "").trim() : "";
      const carrier = carrierColIdx !== -1 ? String(row[carrierColIdx] || "").trim() : "Trucking";
      const pro = proColIdx !== -1 ? String(row[proColIdx] || "").trim() : "";
      const note = noteColIdx !== -1 ? String(row[noteColIdx] || "").trim() : "Imported from WMS Invoice & Issues";

      const lookupKey = (invoice || pro || (customer + "_" + r)).toUpperCase();

      if (existingKeys.has(lookupKey)) {
        // Update existing row if needed
        const targetRowIdx = existingKeys.get(lookupKey);
        const targetRowRange = targetSheet.getRange(targetRowIdx, 1, 1, Math.max(targetHeaders.length, 21));
        const currentVals = targetRowRange.getDisplayValues()[0];
        
        // Update fields if empty or changed
        if (targetMap["STATUS"] !== undefined && !currentVals[targetMap["STATUS"]]) {
          targetSheet.getRange(targetRowIdx, targetMap["STATUS"] + 1).setValue("WORK IN PROGRESS");
          updatedCount++;
        }
      } else {
        // Append new row to WH Trucking Request
        const newRow = new Array(Math.max(targetHeaders.length, 21)).fill("");
        if (targetMap["CUSTOMER"] !== undefined) newRow[targetMap["CUSTOMER"]] = customer;
        if (targetMap["INVOICE NO."] !== undefined) newRow[targetMap["INVOICE NO."]] = invoice;
        else if (targetMap["INVOICE #"] !== undefined) newRow[targetMap["INVOICE #"]] = invoice;
        if (targetMap["SHIP DATE"] !== undefined) newRow[targetMap["SHIP DATE"]] = shipDate;
        if (targetMap["PALLET TYPE"] !== undefined) newRow[targetMap["PALLET TYPE"]] = pallets;
        if (targetMap["CARRIER"] !== undefined) newRow[targetMap["CARRIER"]] = carrier;
        if (targetMap["PRO#"] !== undefined) newRow[targetMap["PRO#"]] = pro;
        if (targetMap["NOTE"] !== undefined) newRow[targetMap["NOTE"]] = note;
        if (targetMap["STATUS"] !== undefined) newRow[targetMap["STATUS"]] = "WORK IN PROGRESS";

        targetSheet.appendRow(newRow);
        importedCount++;
      }
    }

    SpreadsheetApp.flush();
    Logger.log("WMS Scan completed. Imported: " + importedCount + ", Updated: " + updatedCount);
    return { ok: true, imported: importedCount, updated: updatedCount };
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

/**
 * Creates or resets the 30-minute time-driven trigger for WMS Trucking scanner.
 */
function create30MinTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "scanAndImportWmsTruckingOrders") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("scanAndImportWmsTruckingOrders")
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log("30-minute time-driven trigger created for scanAndImportWmsTruckingOrders");
}

