/*
 * CustomerBackfill.gs — TRUCKING customer database backfill (batch)
 *
 * Deferred from CustomerLookup.gs (see that file's header comment): a full
 * reconciliation of the TRUCKING customer master against the B2B/E-COM
 * TRUCKING transaction log, using the Customer Entry tab as a secondary
 * address source, preserving conflicting addresses as distinct, numbered
 * locations instead of guessing which one is current.
 *
 * Same discipline as WmsTruckingSyncV2.gs/CustomerLookup.gs after the
 * 2026-08-12 KORHEIM wrong-merge incident — applied to the customer domain
 * as "never overwrite, never guess which address is right; when two
 * addresses genuinely conflict, keep both under distinct '- 1'/'- 2'
 * location suffixes" rather than as a dry-run/log-only rollout: after a
 * review period with the job in dry-run and no writes, this now runs live
 * (CUSTOMER_BACKFILL_ENABLED = true, CUSTOMER_BACKFILL_DRY_RUN = false).
 * Set CUSTOMER_BACKFILL_DRY_RUN back to true to return to log-only without
 * touching any other code. Every candidate (new customer, address
 * conflict, or a record with no address on file at all) is always logged
 * to PIPELINE LOG, live or dry-run, for an audit trail either way.
 * Per an explicit product decision, candidates are NOT filtered by how
 * often a name appears in the transaction log (most distinct names in the
 * live log appear only once) — every distinct name is reconciled and
 * logged, with its occurrence count included so the log can still be
 * sorted/triaged by a human afterward.
 *
 * NOTE ON DUPLICATED HELPERS: findBackfillCustomerDbHeader_ /
 * buildBackfillCustomerRecords_ / matchBackfillCustomerRecord_ intentionally
 * re-implement (rather than import) the equivalent TRUCKING-lookup helpers
 * in CustomerLookup.gs, a separate PR not yet merged at the time this was
 * written. Apps Script has a single flat global namespace across every .gs
 * file in the project, so two files defining the same function/variable
 * name would collide the moment both land, regardless of merge order —
 * these are deliberately named/scoped to avoid that. Once CustomerLookup.gs
 * is merged, consider consolidating into one shared implementation.
 *
 * NOTE ON THE B2B/E-COM TRUCKING HEADER: columns A and B are BOTH labeled
 * "NOTE" in the live sheet (confirmed by direct inspection of the live
 * workbook), but only column B holds the actual customer name. headerMap_'s
 * name->index map (Code.gs) resolves duplicate header text to whichever
 * column comes LAST, so a naive map["NOTE"] lookup happens to land on
 * column B today — but that's an accident of iteration order, not a
 * contract. findB2bTruckingHeader_ below locates the header by validating
 * several fixed-position anchors instead of trusting a name-based lookup
 * for that one ambiguous column.
 */

var CUSTOMER_BACKFILL_ENABLED = true;
var CUSTOMER_BACKFILL_DRY_RUN = false;
var CUSTOMER_BACKFILL_DB_SHEET_NAME = "TRUCKING";
var B2B_TRUCKING_SHEET_NAME = "B2B/E-COM TRUCKING";
var CUSTOMER_ENTRY_SHEET_NAME = "Customer Entry";

function reconcileCustomerBackfill() {
  if (!CUSTOMER_BACKFILL_ENABLED) {
    Logger.log("Customer backfill is disabled.");
    return { ok: true, skipped: "disabled" };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: "Lock timeout" };

  try {
    var spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    var truckingSheet = spreadsheet.getSheetByName(CUSTOMER_BACKFILL_DB_SHEET_NAME);
    var b2bSheet = spreadsheet.getSheetByName(B2B_TRUCKING_SHEET_NAME);
    if (!truckingSheet || !b2bSheet) throw new Error("Required TRUCKING or B2B/E-COM TRUCKING sheet is missing.");

    var truckingValues = truckingSheet.getDataRange().getDisplayValues();
    var truckingHeader = findBackfillCustomerDbHeader_(truckingValues);
    // Mutable — updated as rows are written during this same run (address
    // fills, second-location renames, new appends) so a later candidate's
    // classification/suffix numbering sees this run's own writes, not a
    // stale pre-run snapshot.
    var truckingRecords = buildBackfillCustomerRecords_(truckingValues, truckingHeader);
    var nextTruckingRow = truckingValues.length + 1;

    var b2bValues = b2bSheet.getDataRange().getDisplayValues();
    var b2bHeader = findB2bTruckingHeader_(b2bValues);
    var aggregation = buildB2bCustomerAggregates_(b2bValues, b2bHeader);

    var entrySheet = spreadsheet.getSheetByName(CUSTOMER_ENTRY_SHEET_NAME);
    if (entrySheet) {
      var entryValues = entrySheet.getDataRange().getDisplayValues();
      var entryHeader = findCustomerEntryHeader_(entryValues);
      mergeCustomerEntryAddresses_(aggregation.aggregates, entryValues, entryHeader);
    }

    var wouldCreate = 0;
    var wouldFlag = 0;
    var wouldFill = 0;
    var okCount = 0;

    aggregation.aggregates.forEach(function (aggregate, exactKey) {
      var classification = classifyCustomerCandidate_(aggregate.name, aggregate, truckingRecords);

      if (classification.classification === "would-create") {
        wouldCreate++;
        logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
        if (!CUSTOMER_BACKFILL_DRY_RUN) {
          appendBackfillCustomer_(truckingSheet, truckingHeader, aggregate.name, classification.proposedAddress, nextTruckingRow);
          truckingRecords.push(makeBackfillRecord_(nextTruckingRow, aggregate.name, classification.proposedAddress));
          nextTruckingRow++;
        }
      } else if (classification.classification === "would-flag-second-location") {
        wouldFlag++;
        logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
        if (!CUSTOMER_BACKFILL_DRY_RUN) {
          var newName = flagBackfillSecondLocation_(
            truckingSheet, truckingHeader, truckingRecords, classification.matchedRecord,
            classification.proposedAddress, nextTruckingRow
          );
          truckingRecords.push(makeBackfillRecord_(nextTruckingRow, newName, classification.proposedAddress));
          nextTruckingRow++;
        }
      } else if (classification.classification === "would-fill-missing-address") {
        wouldFill++;
        logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
        if (!CUSTOMER_BACKFILL_DRY_RUN) {
          fillBackfillCustomerAddress_(truckingSheet, truckingHeader, classification.matchedRecord, classification.proposedAddress);
          classification.matchedRecord.address = classification.proposedAddress;
        }
      } else {
        okCount++;
      }
    });

    logPipeline_("CUSTOMER BACKFILL SUMMARY", "", JSON.stringify({
      scannedNames: aggregation.aggregates.size,
      wouldCreate: wouldCreate,
      wouldFlagSecondLocation: wouldFlag,
      wouldFillMissingAddress: wouldFill,
      okNoAction: okCount,
      skippedBlankNameRows: aggregation.skippedBlankNameRows,
      dryRun: CUSTOMER_BACKFILL_DRY_RUN
    }));

    Logger.log(
      "Customer backfill: scanned=" + aggregation.aggregates.size +
      ", wouldCreate=" + wouldCreate +
      ", wouldFlagSecondLocation=" + wouldFlag +
      ", wouldFillMissingAddress=" + wouldFill +
      ", ok=" + okCount +
      ", skippedBlankNameRows=" + aggregation.skippedBlankNameRows +
      ", dryRun=" + CUSTOMER_BACKFILL_DRY_RUN
    );

    return {
      ok: true,
      scanned: aggregation.aggregates.size,
      wouldCreate: wouldCreate,
      wouldFlagSecondLocation: wouldFlag,
      wouldFillMissingAddress: wouldFill,
      okNoAction: okCount,
      skippedBlankNameRows: aggregation.skippedBlankNameRows,
      dryRun: CUSTOMER_BACKFILL_DRY_RUN
    };
  } catch (error) {
    Logger.log("Error in reconcileCustomerBackfill: " + error.message);
    return { ok: false, error: error.message };
  } finally {
    lock.releaseLock();
  }
}

function findBackfillCustomerDbHeader_(rows) {
  for (var r = 0; r < Math.min(rows.length, 5); r++) {
    var map = headerMap_(rows[r]);
    if (map["CUSTOMER NAME"] !== undefined && map["ADDRESS"] !== undefined) {
      return { rowIndex: r, map: map };
    }
  }
  throw new Error("Could not locate the TRUCKING customer database header row.");
}

function buildBackfillCustomerRecords_(rows, header) {
  var records = [];
  for (var r = header.rowIndex + 1; r < rows.length; r++) {
    var row = rows[r];
    var name = String(row[header.map["CUSTOMER NAME"]] || "").trim();
    if (!name) continue;
    records.push({
      rowNumber: r + 1,
      name: name,
      exactKey: name.toUpperCase().replace(/\s+/g, " "),
      canonicalKey: normalizeWmsCustomerKey_(canonicalWmsCustomer_(name)),
      address: header.map["ADDRESS"] !== undefined ? String(row[header.map["ADDRESS"]] || "").trim() : ""
    });
  }
  return records;
}

/**
 * Exact match first; canonical-key match only when it resolves to exactly
 * one candidate. Never guesses among multiple candidates at either stage —
 * ambiguous is treated the same as "no match", the same discipline
 * CustomerLookup.gs's matchCustomerRecord_ uses.
 */
function matchBackfillCustomerRecord_(customerValue, records) {
  var exactKey = customerValue.toUpperCase().replace(/\s+/g, " ").trim();
  var exact = records.filter(function (r) { return r.exactKey === exactKey; });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  var canonicalKey = normalizeWmsCustomerKey_(canonicalWmsCustomer_(customerValue));
  if (!canonicalKey) return null;
  var canonical = records.filter(function (r) { return r.canonicalKey === canonicalKey; });
  return canonical.length === 1 ? canonical[0] : null;
}

/**
 * Locates the B2B/E-COM TRUCKING header row by validating four fixed-
 * position anchors (A and B both "NOTE", D "TO", J "INVOICE") rather than a
 * name-based headerMap_ lookup, since columns A and B share the same header
 * text and headerMap_ can't disambiguate them — see the file header note.
 */
function findB2bTruckingHeader_(rows) {
  for (var r = 0; r < Math.min(rows.length, 10); r++) {
    var row = rows[r];
    var colA = String(row[0] || "").trim().toUpperCase();
    var colB = String(row[1] || "").trim().toUpperCase();
    var colD = String(row[3] || "").trim().toUpperCase();
    var colJ = String(row[9] || "").trim().toUpperCase();
    if (colA === "NOTE" && colB === "NOTE" && colD === "TO" && colJ === "INVOICE") {
      return { rowIndex: r, nameCol: 1, addressCol: 3 };
    }
  }
  throw new Error("Could not locate the B2B/E-COM TRUCKING header row.");
}

function findCustomerEntryHeader_(rows) {
  for (var r = 0; r < Math.min(rows.length, 5); r++) {
    var map = headerMap_(rows[r]);
    if (map["CUSTOMER NAME"] !== undefined && map["ADDRESS"] !== undefined) {
      return { rowIndex: r, map: map };
    }
  }
  throw new Error("Could not locate the Customer Entry header row.");
}

/**
 * Groups B2B/E-COM TRUCKING rows by exact (not canonicalized) customer
 * name — literal spelling variants are still surfaced as distinct
 * candidates rather than silently merged, consistent with never guessing.
 * A row with data but a blank name cell (e.g. a stray remark landing in
 * column A instead of a real customer name in column B) is counted rather
 * than silently dropped, since there is no safe name to key it under.
 */
function buildB2bCustomerAggregates_(rows, header) {
  var aggregates = new Map();
  var skippedBlankNameRows = 0;

  for (var r = header.rowIndex + 1; r < rows.length; r++) {
    var row = rows[r];
    var name = String(row[header.nameCol] || "").trim();
    if (!name) {
      var hasOtherData = row.some(function (cell) { return String(cell || "").trim() !== ""; });
      if (hasOtherData) skippedBlankNameRows++;
      continue;
    }

    var exactKey = name.toUpperCase().replace(/\s+/g, " ");
    var address = String(row[header.addressCol] || "").trim();

    if (!aggregates.has(exactKey)) {
      aggregates.set(exactKey, {
        name: name,
        occurrenceCount: 0,
        addressesBySource: {},
        sampleRows: []
      });
    }
    var aggregate = aggregates.get(exactKey);
    aggregate.occurrenceCount++;
    if (aggregate.sampleRows.length < 5) aggregate.sampleRows.push(r + 1);
    if (address) {
      var bucket = aggregate.addressesBySource[B2B_TRUCKING_SHEET_NAME] ||
        (aggregate.addressesBySource[B2B_TRUCKING_SHEET_NAME] = []);
      if (bucket.indexOf(address) === -1) bucket.push(address);
    }
  }

  return { aggregates: aggregates, skippedBlankNameRows: skippedBlankNameRows };
}

/**
 * Enriches names already seen in the B2B log with addresses from Customer
 * Entry — a secondary source, not an independent scan; Customer Entry
 * names with no matching B2B-log occurrence are left alone.
 */
function mergeCustomerEntryAddresses_(aggregates, rows, header) {
  for (var r = header.rowIndex + 1; r < rows.length; r++) {
    var row = rows[r];
    var name = String(row[header.map["CUSTOMER NAME"]] || "").trim();
    if (!name) continue;
    var address = String(row[header.map["ADDRESS"]] || "").trim();
    if (!address) continue;

    var exactKey = name.toUpperCase().replace(/\s+/g, " ");
    var aggregate = aggregates.get(exactKey);
    if (!aggregate) continue;

    var bucket = aggregate.addressesBySource[CUSTOMER_ENTRY_SHEET_NAME] ||
      (aggregate.addressesBySource[CUSTOMER_ENTRY_SHEET_NAME] = []);
    if (bucket.indexOf(address) === -1) bucket.push(address);
  }
}

/**
 * The core reconciliation decision for one distinct customer name:
 *  - no TRUCKING match at all               -> "would-create"
 *  - matched, TRUCKING has no address on file
 *    but the log/Customer Entry has one     -> "would-fill-missing-address"
 *  - matched, TRUCKING's address differs
 *    from a non-blank observed address      -> "would-flag-second-location"
 *  - matched, addresses agree (or nothing
 *    new to compare)                        -> "ok-no-action"
 * Address comparison is a plain trimmed string comparison — no
 * normalization — per an explicit product decision to keep the rule simple
 * and let a human triage every flagged row.
 */
function classifyCustomerCandidate_(name, aggregate, truckingRecords) {
  var matchedRecord = matchBackfillCustomerRecord_(name, truckingRecords);

  var allAddresses = [];
  var sourcesUsed = [];
  Object.keys(aggregate.addressesBySource).forEach(function (source) {
    sourcesUsed.push(source);
    aggregate.addressesBySource[source].forEach(function (address) {
      if (allAddresses.indexOf(address) === -1) allAddresses.push(address);
    });
  });

  if (!matchedRecord) {
    return {
      classification: "would-create",
      matchedRecord: null,
      proposedAddress: allAddresses[0] || "",
      existingAddress: null,
      addressVariants: allAddresses,
      sourcesUsed: sourcesUsed
    };
  }

  var existingAddress = matchedRecord.address || "";

  if (!existingAddress && allAddresses.length > 0) {
    return {
      classification: "would-fill-missing-address",
      matchedRecord: matchedRecord,
      proposedAddress: allAddresses[0],
      existingAddress: "",
      addressVariants: allAddresses,
      sourcesUsed: sourcesUsed
    };
  }

  var conflicting = allAddresses.filter(function (address) {
    return address && existingAddress && address !== existingAddress;
  });

  if (conflicting.length > 0) {
    return {
      classification: "would-flag-second-location",
      matchedRecord: matchedRecord,
      proposedAddress: conflicting[0],
      existingAddress: existingAddress,
      addressVariants: allAddresses,
      sourcesUsed: sourcesUsed
    };
  }

  return {
    classification: "ok-no-action",
    matchedRecord: matchedRecord,
    proposedAddress: allAddresses[0] || "",
    existingAddress: existingAddress,
    addressVariants: allAddresses,
    sourcesUsed: sourcesUsed
  };
}

/**
 * Strips a trailing " - <N>" location-disambiguation suffix (the sheet's
 * existing convention, e.g. "OVER N OVER Over Beauty - 1/-2/-3") from a
 * customer name, returning the bare base name shared by every location of
 * the same brand. A name with no suffix is returned unchanged.
 */
function stripCustomerLocationSuffix_(name) {
  var match = /^(.*?)\s*-\s*(\d+)\s*$/.exec(name);
  return match ? match[1].trim() : name;
}

/**
 * Finds the next unused numeric location suffix for baseName across
 * records, treating an unsuffixed record matching baseName as implicit
 * location "1" (so the first real duplicate becomes "- 2", never
 * colliding with the original). Always appends after the highest suffix
 * seen rather than filling a gap, so numbering only ever grows.
 */
function nextCustomerLocationSuffix_(baseName, records) {
  var baseKey = baseName.toUpperCase().replace(/\s+/g, " ").trim();
  var used = [0];
  records.forEach(function (record) {
    var match = /^(.*?)\s*-\s*(\d+)\s*$/.exec(record.name);
    var recordBase = (match ? match[1] : record.name).toUpperCase().replace(/\s+/g, " ").trim();
    if (recordBase !== baseKey) return;
    used.push(match ? parseInt(match[2], 10) : 1);
  });
  return Math.max.apply(null, used) + 1;
}

function makeBackfillRecord_(rowNumber, name, address) {
  return {
    rowNumber: rowNumber,
    name: name,
    exactKey: name.toUpperCase().replace(/\s+/g, " "),
    canonicalKey: normalizeWmsCustomerKey_(canonicalWmsCustomer_(name)),
    address: address || ""
  };
}

/**
 * Appends a brand-new customer row to TRUCKING (name + best available
 * observed address, which is often blank and filled in by staff later).
 * Mirrors CustomerLookup.gs's proposeNewCustomer_ live-write for the same
 * "no match at all" case, just triggered from the batch job instead of a
 * live edit.
 */
function appendBackfillCustomer_(truckingSheet, header, name, address, targetRow) {
  var width = Math.max.apply(null, Object.keys(header.map).map(function (key) { return header.map[key]; })) + 1;
  var newRow = new Array(width).fill("");
  newRow[header.map["CUSTOMER NAME"]] = name;
  if (address) newRow[header.map["ADDRESS"]] = address;
  truckingSheet.getRange(targetRow, 1, 1, width).setValues([newRow]);
}

/**
 * Fills a currently-blank ADDRESS cell on an existing TRUCKING row.
 * classifyCustomerCandidate_ only ever returns "would-fill-missing-address"
 * when that cell is already confirmed blank, so this never overwrites a
 * real value.
 */
function fillBackfillCustomerAddress_(truckingSheet, header, matchedRecord, address) {
  truckingSheet.getRange(matchedRecord.rowNumber, header.map["ADDRESS"] + 1).setValue(address);
}

/**
 * Handles a conflicting-address candidate by preserving both addresses as
 * distinct, numbered locations rather than guessing which one is current —
 * the exact discipline that fixed the 2026-08-12 KORHEIM incident, applied
 * here as "mark 1 or 2" per an explicit product decision. If the existing
 * matched row has no location suffix yet, it is renamed in place to
 * "<name> - 1" (its implicit first location) before the new location is
 * appended as "<name> - <next>". Returns the new row's name.
 */
function flagBackfillSecondLocation_(truckingSheet, header, truckingRecords, matchedRecord, newAddress, targetRow) {
  var baseName = stripCustomerLocationSuffix_(matchedRecord.name);
  var alreadySuffixed = /^(.*?)\s*-\s*(\d+)\s*$/.test(matchedRecord.name);

  if (!alreadySuffixed) {
    var renamed = baseName + " - 1";
    truckingSheet.getRange(matchedRecord.rowNumber, header.map["CUSTOMER NAME"] + 1).setValue(renamed);
    matchedRecord.name = renamed;
    matchedRecord.exactKey = renamed.toUpperCase().replace(/\s+/g, " ");
  }

  var nextSuffix = nextCustomerLocationSuffix_(baseName, truckingRecords);
  var newName = baseName + " - " + nextSuffix;
  appendBackfillCustomer_(truckingSheet, header, newName, newAddress, targetRow);
  return newName;
}

/**
 * Logs a candidate to PIPELINE LOG. occurrenceCount lets a human sort/
 * triage the full, unfiltered list after the fact even though nothing was
 * excluded before logging. Logged unconditionally (live or dry-run) so
 * there is always an audit trail of what this job did or would do.
 */
function logCustomerBackfillCandidate_(name, aggregate, classification) {
  try {
    logPipeline_(CUSTOMER_BACKFILL_DRY_RUN ? "CUSTOMER BACKFILL DRY RUN" : "CUSTOMER BACKFILL LIVE", name, JSON.stringify({
      action: classification.classification,
      customer: name,
      occurrenceCount: aggregate.occurrenceCount,
      proposedAddress: classification.proposedAddress,
      existingAddress: classification.existingAddress,
      existingTruckingRow: classification.matchedRecord ? classification.matchedRecord.rowNumber : null,
      sources: classification.sourcesUsed,
      addressVariants: classification.addressVariants,
      sampleRows: aggregate.sampleRows
    }));
  } catch (e) {
    Logger.log("logCustomerBackfillCandidate_ failed: " + (e && e.message || e));
  }
}
