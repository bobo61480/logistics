/*
 * WMS Trucking Importer V2
 *
 * Safeguards:
 *  - never imports source ship dates before 2026-08-01
 *  - groups only by canonical customer + exact ship date
 *  - never reuses a target row whose exact customer/date key differs
 *  - repairs legacy nearby-date merges by removing source-known invoices that
 *    belong to another exact source group before updating the matched row
 *  - leaves terminal/completed target rows untouched
 */

var WMS_TRUCKING_IMPORT_MIN_DATE = "2026-08-01";
var WMS_TRUCKING_SYNC_ENABLED = true;
// Live writes use exact customer + ship-date grouping and preserve terminal
// workflow states. Fulfillment dimensions enrich the same canonical rows.
var WMS_TRUCKING_DRY_RUN = false;
var FULFILLMENT_DATA_URL = "https://script.google.com/macros/s/AKfycbykK9DWjem9ORHxfR_mpdZl5DVh-en0D6JpCdIuel305QmfqxoNU_NqSnjkhFk401hI/exec";
var WMS_FULFILLMENT_DETAIL_LIMIT = 80;

function nmfcClassFromDensityV2_(density) {
  var d = Number(density || 0);
  if (!(d > 0)) return "";
  if (d >= 50) return "50";
  if (d >= 35) return "55";
  if (d >= 30) return "60";
  if (d >= 22.5) return "65";
  if (d >= 15) return "70";
  if (d >= 13.5) return "77.5";
  if (d >= 12) return "85";
  if (d >= 10.5) return "92.5";
  if (d >= 9) return "100";
  if (d >= 8) return "110";
  if (d >= 7) return "125";
  if (d >= 6) return "150";
  if (d >= 5) return "175";
  if (d >= 4) return "200";
  if (d >= 3) return "250";
  if (d >= 2) return "300";
  if (d >= 1) return "400";
  return "500";
}

function fulfillmentFreightSummaryV2_(details) {
  var dims = [];
  (details || []).forEach(function (detail) {
    (detail && (detail.dims || detail.dimensions) || []).forEach(function (dim) {
      var l = Number(dim.l || dim.length || 0), w = Number(dim.w || dim.width || 0);
      var h = Number(dim.h || dim.height || 0), wt = Number(dim.wt || dim.weight || 0);
      if (l > 0 && w > 0 && h > 0) dims.push({ l: l, w: w, h: h, wt: wt });
    });
  });
  var cubicInches = dims.reduce(function (sum, dim) { return sum + dim.l * dim.w * dim.h; }, 0);
  var weight = dims.reduce(function (sum, dim) { return sum + dim.wt; }, 0);
  var cubicFeet = cubicInches / 1728;
  var density = cubicFeet > 0 && weight > 0 ? weight / cubicFeet : 0;
  var uniqueDims = uniqueTextV2_(dims.map(function (dim) { return dim.l + "x" + dim.w + "x" + dim.h + " @ " + dim.wt + " lb"; }));
  return {
    pallets: dims.length,
    length: dims.length === 1 ? dims[0].l : "",
    width: dims.length === 1 ? dims[0].w : "",
    height: dims.length === 1 ? dims[0].h : "",
    weight: weight || "",
    cubicInches: cubicInches || "",
    cubicFeet: cubicFeet || "",
    density: density || "",
    freightClass: nmfcClassFromDensityV2_(density),
    note: uniqueDims.length ? "FULFILLMENT DIMS (" + dims.length + " pallet" + (dims.length === 1 ? "" : "s") + "): " + uniqueDims.join("; ") : ""
  };
}

function fetchFulfillmentDetailsV2_(invoices) {
  var wanted = (invoices || []).slice(-WMS_FULFILLMENT_DETAIL_LIMIT);
  if (!wanted.length) return {};
  var requests = wanted.map(function (invoice) {
    return { url: FULFILLMENT_DATA_URL + "?op=getSalesInvoiceDetail&invoice=" + encodeURIComponent(invoice), muteHttpExceptions: true };
  });
  var responses = UrlFetchApp.fetchAll(requests);
  var result = {};
  responses.forEach(function (response, index) {
    try {
      var parsed = JSON.parse(response.getContentText());
      if (parsed && parsed.ok) result[wanted[index]] = parsed;
    } catch (e) { logPipeline_("FULFILLMENT DETAIL ERROR", wanted[index], String(e)); }
  });
  return result;
}

function writeFulfillmentMappedValueV2_(sheet, rowNumber, map, header, value) {
  if (value === "" || value === undefined || value === null) return false;
  return writeMappedValue_(sheet, rowNumber, map, header, value);
}

function wmsImportEligible_(dateInfo) {
  var key = String(dateInfo && dateInfo.key || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && key >= WMS_TRUCKING_IMPORT_MIN_DATE;
}

function wmsExactGroupKey_(customer, dateInfo) {
  return normalizeWmsCustomerKey_(canonicalWmsCustomer_(customer)) + "___" + String(dateInfo && dateInfo.key || "");
}

function chooseWmsTargetRow_(groupKey, invoices, rows) {
  var wanted = new Set((invoices || []).map(function (invoice) {
    return String(invoice || "").trim().toUpperCase();
  }).filter(Boolean));

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row.key !== groupKey) continue;
    for (var j = 0; j < row.invoices.length; j++) {
      if (wanted.has(String(row.invoices[j] || "").trim().toUpperCase())) return row;
    }
  }

  for (var k = 0; k < rows.length; k++) {
    if (rows[k].key === groupKey && rows[k].active) return rows[k];
  }
  return null;
}

function filterWmsInvoicesForGroup_(invoices, groupKey, sourceByInvoice) {
  return (invoices || []).filter(function (invoice) {
    var clean = String(invoice || "").trim().toUpperCase();
    if (!clean) return false;
    var source = sourceByInvoice.get(clean);
    return !source || source.key === groupKey;
  });
}

function scanAndImportWmsTruckingOrdersV2() {
  if (!WMS_TRUCKING_SYNC_ENABLED) {
    Logger.log("WMS trucking sync is disabled.");
    return { ok: true, skipped: "disabled" };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: "Lock timeout" };

  try {
    var sourceSpreadsheet = SpreadsheetApp.openById(WMS_SPREADSHEET_ID);
    var targetSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sourceSheet = sourceSpreadsheet.getSheetByName("Stylekorean");
    var targetSheet = targetSpreadsheet.getSheetByName("WH Trucking Request");
    if (!sourceSheet || !targetSheet) throw new Error("Required source or target sheet is missing.");

    var sourceData = sourceSheet.getDataRange().getDisplayValues();
    var sourceHeader = findWmsTruckingHeader_(sourceData);
    var sourceMap = sourceHeader.map;
    ["INVOICE#", "CUSTOMER NAME", "SHIP OUT DATE", "SHIPPING METHOD"].forEach(function (name) {
      if (sourceMap[name] === undefined) throw new Error("WMS Stylekorean is missing header: " + name);
    });

    var groups = new Map();
    var sourceByInvoice = new Map();
    var skippedBeforeCutoff = 0;

    for (var r = sourceHeader.rowIndex + 1; r < sourceData.length; r++) {
      var row = sourceData[r];
      var method = String(row[sourceMap["SHIPPING METHOD"]] || "").trim().toUpperCase();
      if (!isWmsFreightMethod_(method)) continue;

      var invoice = String(row[sourceMap["INVOICE#"]] || "").trim().toUpperCase();
      var rawCustomer = String(row[sourceMap["CUSTOMER NAME"]] || "").trim();
      var rawShipDate = String(row[sourceMap["SHIP OUT DATE"]] || "").trim();
      if (!invoice || !rawCustomer || !rawShipDate) continue;

      var customer = canonicalWmsCustomer_(rawCustomer);
      var dateInfo = normalizeWmsShipDate_(rawShipDate);
      if (!wmsImportEligible_(dateInfo)) {
        skippedBeforeCutoff++;
        continue;
      }

      var key = wmsExactGroupKey_(customer, dateInfo);
      sourceByInvoice.set(invoice, {
        customer: customer,
        dateInfo: dateInfo,
        sourceRow: r + 1,
        key: key
      });

      if (!groups.has(key)) {
        groups.set(key, {
          key: key,
          customer: customer,
          shipDate: dateInfo.display,
          invoices: [],
          amounts: [],
          sourceRows: []
        });
      }

      var group = groups.get(key);
      if (group.invoices.indexOf(invoice) === -1) group.invoices.push(invoice);
      if (sourceMap["INVOICE AMOUNT"] !== undefined) {
        var amount = parseWmsAmount_(row[sourceMap["INVOICE AMOUNT"]]);
        if (amount !== null) group.amounts.push(amount);
      }
      group.sourceRows.push(r + 1);
    }

    var fulfillmentDetails = fetchFulfillmentDetailsV2_(Array.from(sourceByInvoice.keys()));
    var customerDbSheet = targetSpreadsheet.getSheetByName(CUSTOMER_DB_SHEET_NAME);
    var customerRecords = [];
    if (customerDbSheet) {
      var customerRows = customerDbSheet.getDataRange().getDisplayValues();
      customerRecords = buildCustomerRecords_(customerRows, findCustomerDbHeader_(customerRows));
    }
    groups.forEach(function (group) {
      group.fulfillmentDetails = group.invoices.map(function (invoice) { return fulfillmentDetails[invoice]; }).filter(Boolean);
      group.freight = fulfillmentFreightSummaryV2_(group.fulfillmentDetails);
      var customerRecord = matchCustomerRecord_(group.customer, customerRecords);
      group.address = customerRecord ? customerRecord.address : "";
    });

    var targetLastRow = Math.max(targetSheet.getLastRow(), 5);
    var targetLastColumn = Math.max(targetSheet.getLastColumn(), 24);
    var targetData = targetSheet.getRange(1, 1, targetLastRow, targetLastColumn).getDisplayValues();
    var targetHeader = findWhTruckingHeader_(targetData);
    var targetMap = targetHeader.map;
    ["CUSTOMER", "INVOICE NO.", "SHIP DATE"].forEach(function (name) {
      if (targetMap[name] === undefined) throw new Error("WH Trucking Request is missing header: " + name);
    });

    var targetRows = [];
    var lastBusinessRow = targetHeader.rowIndex + 1;

    for (var t = targetHeader.rowIndex + 1; t < targetData.length; t++) {
      var targetRow = targetData[t];
      var targetCustomer = exactVal_(targetRow, targetMap, ["CUSTOMER"]);
      var targetShipDate = exactVal_(targetRow, targetMap, ["SHIP DATE"]);
      var invoiceCell = exactVal_(targetRow, targetMap, ["INVOICE NO.", "INVOICE #", "INVOICE"]);
      var status = exactVal_(targetRow, targetMap, ["STATUS"]);
      if (targetCustomer || targetShipDate || invoiceCell) lastBusinessRow = t + 1;
      if (!targetCustomer || !targetShipDate) continue;

      var targetDateInfo = normalizeWmsShipDate_(targetShipDate);
      var targetKey = wmsExactGroupKey_(targetCustomer, targetDateInfo);
      targetRows.push({
        rowNumber: t + 1,
        key: targetKey,
        customer: targetCustomer,
        dateInfo: targetDateInfo,
        invoices: splitWmsInvoices_(invoiceCell),
        active: isWmsActiveStatus_(status),
        status: status
      });
    }

    var imported = 0;
    var updated = 0;
    var repaired = 0;
    var skippedTerminal = 0;
    var pendingRows = [];
    var width = Math.max(targetLastColumn, 24);

    groups.forEach(function (group, key) {
      group.invoices.sort();
      var match = chooseWmsTargetRow_(key, group.invoices, targetRows);
      var totalAmount = group.amounts.reduce(function (sum, value) { return sum + value; }, 0);

      if (match) {
        if (!match.active) {
          skippedTerminal++;
        }

        var current = targetSheet.getRange(match.rowNumber, 1, 1, width).getValues()[0];
        var currentInvoices = splitWmsInvoices_(current[targetMap["INVOICE NO."]]);
        var retainedInvoices = filterWmsInvoicesForGroup_(currentInvoices, key, sourceByInvoice);
        var mergedInvoices = mergeWmsInvoices_(retainedInvoices, group.invoices);
        var removedCount = currentInvoices.length - retainedInvoices.length;
        var changed = false;

        if (WMS_TRUCKING_DRY_RUN) {
          changed = wouldChangeMappedValue_(current, targetMap, "CUSTOMER", group.customer) ||
            wouldChangeMappedValue_(current, targetMap, "INVOICE NO.", mergedInvoices.join("\n")) ||
            wouldChangeMappedValue_(current, targetMap, "SHIP DATE", group.shipDate) ||
            (totalAmount > 0 && targetMap["VALUE"] !== undefined && !current[targetMap["VALUE"]]) ||
            (targetMap["STATUS"] !== undefined && !current[targetMap["STATUS"]]);
          logWmsDryRun_("update", match.rowNumber, group, mergedInvoices, totalAmount);
        } else {
          changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "CUSTOMER", group.customer) || changed;
          changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "INVOICE NO.", mergedInvoices.join("\n")) || changed;
          changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "SHIP DATE", group.shipDate) || changed;
          changed = writeFulfillmentMappedValueV2_(targetSheet, match.rowNumber, targetMap, "ADDRESS", group.address) || changed;
          if (group.freight) {
            changed = writeFulfillmentMappedValueV2_(targetSheet, match.rowNumber, targetMap, "LENGTH (IN)", group.freight.length) || changed;
            changed = writeFulfillmentMappedValueV2_(targetSheet, match.rowNumber, targetMap, "WIDTH (IN)", group.freight.width) || changed;
            changed = writeFulfillmentMappedValueV2_(targetSheet, match.rowNumber, targetMap, "HEIGHT (IN)", group.freight.height) || changed;
            changed = writeFulfillmentMappedValueV2_(targetSheet, match.rowNumber, targetMap, "WEIGHT (LBS)", group.freight.weight) || changed;
            changed = writeFulfillmentMappedValueV2_(targetSheet, match.rowNumber, targetMap, "VOLUME (INCHES)", group.freight.cubicInches) || changed;
            changed = writeFulfillmentMappedValueV2_(targetSheet, match.rowNumber, targetMap, "CFT", group.freight.cubicFeet) || changed;
            changed = writeFulfillmentMappedValueV2_(targetSheet, match.rowNumber, targetMap, "PCF", group.freight.density) || changed;
            changed = writeFulfillmentMappedValueV2_(targetSheet, match.rowNumber, targetMap, "FREIGHT CLASS", group.freight.freightClass) || changed;
            if (group.freight.note) {
              var priorNote = exactVal_(current, targetMap, ["NOTE"]);
              var nextNote = priorNote.indexOf("FULFILLMENT DIMS") === -1
                ? (priorNote ? priorNote + "\n" : "") + group.freight.note
                : priorNote.replace(/FULFILLMENT DIMS[^\n]*/i, group.freight.note);
              changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "NOTE", nextNote) || changed;
            }
          }

          if (totalAmount > 0 && targetMap["VALUE"] !== undefined && !current[targetMap["VALUE"]]) {
            targetSheet.getRange(match.rowNumber, targetMap["VALUE"] + 1).setValue(totalAmount);
            changed = true;
          }
          if (targetMap["STATUS"] !== undefined && !current[targetMap["STATUS"]]) {
            targetSheet.getRange(match.rowNumber, targetMap["STATUS"] + 1).setValue("WORK IN PROGRESS");
            changed = true;
          }
        }

        match.invoices = mergedInvoices.slice();
        match.key = key;
        if (removedCount > 0) repaired++;
        if (changed) updated++;
        return;
      }

      var newRow = new Array(width).fill("");
      newRow[targetMap["CUSTOMER"]] = group.customer;
      newRow[targetMap["INVOICE NO."]] = group.invoices.join("\n");
      newRow[targetMap["SHIP DATE"]] = group.shipDate;
      if (targetMap["ADDRESS"] !== undefined) newRow[targetMap["ADDRESS"]] = group.address;
      if (targetMap["VALUE"] !== undefined && totalAmount > 0) newRow[targetMap["VALUE"]] = totalAmount;
      if (group.freight) {
        if (targetMap["LENGTH (IN)"] !== undefined) newRow[targetMap["LENGTH (IN)"]] = group.freight.length;
        if (targetMap["WIDTH (IN)"] !== undefined) newRow[targetMap["WIDTH (IN)"]] = group.freight.width;
        if (targetMap["HEIGHT (IN)"] !== undefined) newRow[targetMap["HEIGHT (IN)"]] = group.freight.height;
        if (targetMap["WEIGHT (LBS)"] !== undefined) newRow[targetMap["WEIGHT (LBS)"]] = group.freight.weight;
        if (targetMap["VOLUME (INCHES)"] !== undefined) newRow[targetMap["VOLUME (INCHES)"]] = group.freight.cubicInches;
        if (targetMap["CFT"] !== undefined) newRow[targetMap["CFT"]] = group.freight.cubicFeet;
        if (targetMap["PCF"] !== undefined) newRow[targetMap["PCF"]] = group.freight.density;
        if (targetMap["FREIGHT CLASS"] !== undefined) newRow[targetMap["FREIGHT CLASS"]] = group.freight.freightClass;
        if (targetMap["NOTE"] !== undefined) newRow[targetMap["NOTE"]] = group.freight.note;
      }
      if (targetMap["STATUS"] !== undefined) newRow[targetMap["STATUS"]] = "WORK IN PROGRESS";
      if (WMS_TRUCKING_DRY_RUN) {
        logWmsDryRun_("insert", null, group, group.invoices, totalAmount);
      } else {
        pendingRows.push({ row: newRow, group: group });
      }
      imported++;
    });

    if (pendingRows.length) {
      var startRow = lastBusinessRow + 1;
      var valuesToWrite = pendingRows.map(function (item) { return item.row; });
      targetSheet.getRange(startRow, 1, valuesToWrite.length, width).setValues(valuesToWrite);

      var exemplarRow = Math.max(targetHeader.rowIndex + 2, lastBusinessRow);
      targetSheet.getRange(exemplarRow, 1, 1, width).copyTo(
        targetSheet.getRange(startRow, 1, valuesToWrite.length, width),
        SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
        false
      );
      targetSheet.getRange(exemplarRow, 1, 1, width).copyTo(
        targetSheet.getRange(startRow, 1, valuesToWrite.length, width),
        SpreadsheetApp.CopyPasteType.PASTE_FORMULA,
        false
      );
      targetSheet.getRange(exemplarRow, 1, 1, width).copyTo(
        targetSheet.getRange(startRow, 1, valuesToWrite.length, width),
        SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION,
        false
      );
    }

    SpreadsheetApp.flush();
    Logger.log(
      "WMS trucking v2" + (WMS_TRUCKING_DRY_RUN ? " (DRY RUN)" : "") + ": groups=" + groups.size +
      ", imported=" + imported +
      ", updated=" + updated +
      ", repaired=" + repaired +
      ", skippedTerminal=" + skippedTerminal +
      ", skippedBeforeCutoff=" + skippedBeforeCutoff
    );

    return {
      ok: true,
      dryRun: WMS_TRUCKING_DRY_RUN,
      groups: groups.size,
      imported: imported,
      updated: updated,
      repaired: repaired,
      skippedTerminal: skippedTerminal,
      skippedBeforeCutoff: skippedBeforeCutoff,
      nextRow: lastBusinessRow + pendingRows.length + 1
    };
  } catch (error) {
    Logger.log("Error in scanAndImportWmsTruckingOrdersV2: " + error.message);
    return { ok: false, error: error.message };
  } finally {
    lock.releaseLock();
  }
}

/** Non-mutating twin of writeMappedValue_ — reports whether a write would
 * change the cell, without performing it. Used only in dry-run mode. */
function wouldChangeMappedValue_(currentRow, map, header, value) {
  var index = map[header];
  if (index === undefined || value === undefined || value === null) return false;
  return String(currentRow[index] || "").trim() !== String(value).trim();
}

/** Logs what a dry-run scan would have inserted/updated to the existing
 * PIPELINE LOG sheet (same helper item 8's Shipment Notices audit trail
 * uses) instead of writing to WH Trucking Request. Never throws — logging
 * must never break the scan. */
function logWmsDryRun_(action, rowNumber, group, invoices, totalAmount) {
  try {
    logPipeline_("WMS TRUCKING DRY RUN", group.customer, JSON.stringify({
      action: action,
      row: rowNumber,
      customer: group.customer,
      shipDate: group.shipDate,
      invoices: invoices,
      totalAmount: totalAmount,
      groupKey: group.key
    }));
  } catch (e) {
    Logger.log("logWmsDryRun_ failed: " + e.message);
  }
}
