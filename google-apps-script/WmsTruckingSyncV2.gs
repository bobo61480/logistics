/*
 * WMS Trucking Importer V2
 *
 * Safeguards:
 *  - never imports source ship dates before 2026-08-01
 *  - groups by canonical customer + exact ship date + explicit destination when present
 *  - blocks duplicate customer/date/invoice signatures across existing and same-run rows
 *  - cross-date invoice matching rejects rows that contain conflicting invoices
 *  - repairs legacy nearby-date merges by removing source-known invoices that
 *    belong to another exact source group before updating the matched row
 *  - leaves terminal/completed target rows untouched
 */

var WMS_TRUCKING_IMPORT_MIN_DATE = "2026-08-01";
var WMS_TRUCKING_SYNC_ENABLED = true;
// Production writes are safe only after destination-aware grouping and
// operational-date precedence. Current/future rows are synchronized; historic
// freight is left as audit history instead of being recreated as new schedules.
var WMS_TRUCKING_DRY_RUN = false;

function wmsTodayKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function wmsImportEligible_(dateInfo, todayKey) {
  var key = String(dateInfo && dateInfo.key || "").trim();
  var floor = String(todayKey || wmsTodayKey_()).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && key >= WMS_TRUCKING_IMPORT_MIN_DATE && key >= floor;
}

function normalizeWmsDestinationHint_(value) {
  var text = String(value || "").trim();
  if (!text || /^(?:YES|NO|TRUE|FALSE|Y|N)$/i.test(text)) return "";
  if (/\b(?:OOS|ADD[ -]?ON|FREE SAMPLE|TOTAL|SKU)\b|A-SKU|총량|재고|문제/i.test(text)) return "";
  if (/^IN\d{6,}$/i.test(text)) return "";
  if (/^[A-Z0-9._-]{3,25}$/i.test(text) && text.indexOf(" ") === -1) return "";
  if (!/[A-Za-z가-힣]{3}/.test(text)) return "";
  return normalizeWmsCustomerKey_(text);
}

function wmsDestinationHint_(row, map) {
  var fields = ["REMARKS (WAREHOUSE)", "REMARKS (SALES)", "SKU 2", "SKU 1"];
  for (var i = 0; i < fields.length; i++) {
    var index = map[fields[i]];
    if (index === undefined) continue;
    var hint = normalizeWmsDestinationHint_(row[index]);
    if (hint) return hint;
  }
  return "";
}

function wmsExactGroupKey_(customer, dateInfo, destinationHint) {
  var key = normalizeWmsCustomerKey_(canonicalWmsCustomer_(customer)) + "___" + String(dateInfo && dateInfo.key || "");
  var destination = normalizeWmsCustomerKey_(destinationHint || "");
  return destination ? key + "___DEST_" + destination : key;
}

/**
 * Idempotency key deliberately ignores the destination suffix. A single WMS
 * invoice may be encountered more than once with noisy/different destination
 * hints, but it must still produce at most one target row for a given
 * canonical customer and ship date.
 */
function wmsInvoiceSignatureFromKey_(groupKey, invoice) {
  var baseKey = String(groupKey || "").split("___DEST_")[0];
  var cleanInvoice = String(invoice || "").trim().toUpperCase();
  if (!baseKey || !cleanInvoice) return "";
  return baseKey + "___INV_" + cleanInvoice;
}

function shouldWmsOverwriteShipDate_(currentRow, map) {
  var status = map["STATUS"] !== undefined ? String(currentRow[map["STATUS"]] || "").trim().toUpperCase() : "";
  var pro = map["PRO#"] !== undefined ? String(currentRow[map["PRO#"]] || "").trim() : "";
  if (status === "ROUTED/BOOKED" || pro) return false;
  return true;
}

function chooseWmsTargetRow_(groupKey, invoices, rows) {
  var wanted = new Set((invoices || []).map(function (invoice) {
    return String(invoice || "").trim().toUpperCase();
  }).filter(Boolean));

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var hasWantedInvoice = false;
    for (var j = 0; j < row.invoices.length; j++) {
      if (wanted.has(String(row.invoices[j] || "").trim().toUpperCase())) {
        hasWantedInvoice = true;
        break;
      }
    }
    if (!hasWantedInvoice) continue;
    if (row.key === groupKey) return row;
    if (row.operationallyLocked) return row;
    var hasConflictingInvoice = row.invoices.some(function (invoice) {
      return !wanted.has(String(invoice || "").trim().toUpperCase());
    });
    if (!hasConflictingInvoice) return row;
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
    var importTodayKey = wmsTodayKey_();

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
      if (!wmsImportEligible_(dateInfo, importTodayKey)) {
        skippedBeforeCutoff++;
        continue;
      }

      var destinationHint = wmsDestinationHint_(row, sourceMap);
      var key = wmsExactGroupKey_(customer, dateInfo, destinationHint);
      sourceByInvoice.set(invoice, {
        customer: customer,
        dateInfo: dateInfo,
        destinationHint: destinationHint,
        sourceRow: r + 1,
        key: key
      });

      if (!groups.has(key)) {
        groups.set(key, {
          key: key,
          customer: customer,
          shipDate: dateInfo.display,
          destinationHint: destinationHint,
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
    var existingInvoiceSignatures = new Set();
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
      var targetInvoices = splitWmsInvoices_(invoiceCell);
      targetInvoices.forEach(function (targetInvoice) {
        var signature = wmsInvoiceSignatureFromKey_(targetKey, targetInvoice);
        if (signature) existingInvoiceSignatures.add(signature);
      });
      targetRows.push({
        rowNumber: t + 1,
        key: targetKey,
        customer: targetCustomer,
        dateInfo: targetDateInfo,
        invoices: targetInvoices,
        active: isWmsActiveStatus_(status),
        operationallyLocked: !shouldWmsOverwriteShipDate_(targetRow, targetMap),
        status: status
      });
    }

    var imported = 0;
    var updated = 0;
    var repaired = 0;
    var skippedTerminal = 0;
    var skippedOperational = 0;
    var skippedDuplicateSignature = 0;
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
        if (match.operationallyLocked && match.key !== key) {
          skippedOperational++;
          return;
        }

        var current = targetSheet.getRange(match.rowNumber, 1, 1, width).getValues()[0];
        var currentInvoices = splitWmsInvoices_(current[targetMap["INVOICE NO."]]);
        var retainedInvoices = filterWmsInvoicesForGroup_(currentInvoices, key, sourceByInvoice);
        var mergedInvoices = mergeWmsInvoices_(retainedInvoices, group.invoices);
        var removedCount = currentInvoices.length - retainedInvoices.length;
        var changed = false;

        if (WMS_TRUCKING_DRY_RUN) {
          var mayUpdateShipDate = shouldWmsOverwriteShipDate_(current, targetMap);
          changed = wouldChangeMappedValue_(current, targetMap, "CUSTOMER", group.customer) ||
            wouldChangeMappedValue_(current, targetMap, "INVOICE NO.", mergedInvoices.join("\n")) ||
            (mayUpdateShipDate && wouldChangeMappedValue_(current, targetMap, "SHIP DATE", group.shipDate)) ||
            (totalAmount > 0 && targetMap["VALUE"] !== undefined && !current[targetMap["VALUE"]]) ||
            (targetMap["STATUS"] !== undefined && !current[targetMap["STATUS"]]);
          logWmsDryRun_("update", match.rowNumber, group, mergedInvoices, totalAmount);
        } else {
          changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "CUSTOMER", group.customer) || changed;
          changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "INVOICE NO.", mergedInvoices.join("\n")) || changed;
          if (shouldWmsOverwriteShipDate_(current, targetMap)) {
            changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "SHIP DATE", group.shipDate) || changed;
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
        mergedInvoices.forEach(function (mergedInvoice) {
          var signature = wmsInvoiceSignatureFromKey_(key, mergedInvoice);
          if (signature) existingInvoiceSignatures.add(signature);
        });
        if (removedCount > 0) repaired++;
        if (changed) updated++;
        return;
      }

      var hasDuplicateSignature = group.invoices.some(function (groupInvoice) {
        var signature = wmsInvoiceSignatureFromKey_(key, groupInvoice);
        return signature && existingInvoiceSignatures.has(signature);
      });
      if (hasDuplicateSignature) {
        skippedDuplicateSignature++;
        Logger.log("WMS duplicate invoice signature blocked: " + key + " :: " + group.invoices.join(", "));
        return;
      }

      var newRow = new Array(width).fill("");
      newRow[targetMap["CUSTOMER"]] = group.customer;
      newRow[targetMap["INVOICE NO."]] = group.invoices.join("\n");
      newRow[targetMap["SHIP DATE"]] = group.shipDate;
      if (targetMap["VALUE"] !== undefined && totalAmount > 0) newRow[targetMap["VALUE"]] = totalAmount;
      if (targetMap["STATUS"] !== undefined) newRow[targetMap["STATUS"]] = "WORK IN PROGRESS";
      if (WMS_TRUCKING_DRY_RUN) {
        logWmsDryRun_("insert", null, group, group.invoices, totalAmount);
      } else {
        pendingRows.push({ row: newRow, group: group });
      }
      group.invoices.forEach(function (groupInvoice) {
        var signature = wmsInvoiceSignatureFromKey_(key, groupInvoice);
        if (signature) existingInvoiceSignatures.add(signature);
      });
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
      ", skippedOperational=" + skippedOperational +
      ", skippedDuplicateSignature=" + skippedDuplicateSignature +
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
      skippedOperational: skippedOperational,
      skippedDuplicateSignature: skippedDuplicateSignature,
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