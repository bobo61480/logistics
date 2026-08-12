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
var WMS_TRUCKING_SYNC_ENABLED = false;

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
          return;
        }

        var current = targetSheet.getRange(match.rowNumber, 1, 1, width).getValues()[0];
        var currentInvoices = splitWmsInvoices_(current[targetMap["INVOICE NO."]]);
        var retainedInvoices = filterWmsInvoicesForGroup_(currentInvoices, key, sourceByInvoice);
        var mergedInvoices = mergeWmsInvoices_(retainedInvoices, group.invoices);
        var removedCount = currentInvoices.length - retainedInvoices.length;
        var changed = false;

        changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "CUSTOMER", group.customer) || changed;
        changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "INVOICE NO.", mergedInvoices.join("\n")) || changed;
        changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "SHIP DATE", group.shipDate) || changed;

        if (totalAmount > 0 && targetMap["VALUE"] !== undefined && !current[targetMap["VALUE"]]) {
          targetSheet.getRange(match.rowNumber, targetMap["VALUE"] + 1).setValue(totalAmount);
          changed = true;
        }
        if (targetMap["STATUS"] !== undefined && !current[targetMap["STATUS"]]) {
          targetSheet.getRange(match.rowNumber, targetMap["STATUS"] + 1).setValue("WORK IN PROGRESS");
          changed = true;
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
      if (targetMap["VALUE"] !== undefined && totalAmount > 0) newRow[targetMap["VALUE"]] = totalAmount;
      if (targetMap["STATUS"] !== undefined) newRow[targetMap["STATUS"]] = "WORK IN PROGRESS";
      pendingRows.push({ row: newRow, group: group });
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
      "WMS trucking v2: groups=" + groups.size +
      ", imported=" + imported +
      ", updated=" + updated +
      ", repaired=" + repaired +
      ", skippedTerminal=" + skippedTerminal +
      ", skippedBeforeCutoff=" + skippedBeforeCutoff
    );

    return {
      ok: true,
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
