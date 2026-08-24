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
    var wouldRepair = 0;
    var ambiguousCount = 0;
    var needsReviewCount = 0;
    var okCount = 0;

    // Every mutating branch below logs AFTER its write(s) succeed, not
    // before — logging first (the previous ordering) would record a
    // "CUSTOMER BACKFILL LIVE" entry describing an action that never
    // actually happened if the write throws partway through (Codex review
    // on PR #92 round 5). A caught write failure logs an explicit
    // "CUSTOMER BACKFILL WRITE FAILED" entry instead, so the audit trail
    // never silently overstates what this run did.
    aggregation.aggregates.forEach(function (aggregate, exactKey) {
      var classification = classifyCustomerCandidate_(aggregate.name, aggregate, truckingRecords);

      if (classification.classification === "ambiguous-location-family") {
        // Already split into 2+ known locations — never guess WHICH one,
        // but an address that's on file for none of them is unambiguously
        // new (only computed/populated for an established "- N" suffix
        // family — see classifyCustomerCandidate_).
        ambiguousCount++;
        if (!CUSTOMER_BACKFILL_DRY_RUN) {
          try {
            var ambiguousBaseName = stripBackfillLocationSuffix_(aggregate.name);
            classification.pendingAddresses.forEach(function (address) {
              var newName = appendNewFamilyLocation_(truckingSheet, truckingHeader, ambiguousBaseName, truckingRecords, address, nextTruckingRow);
              truckingRecords.push(makeBackfillRecord_(nextTruckingRow, newName, address));
              nextTruckingRow++;
            });
            logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
          } catch (writeError) {
            logCustomerBackfillCandidate_(aggregate.name, aggregate, classification, writeError);
          }
        } else {
          logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
        }
      } else if (classification.classification === "would-create") {
        wouldCreate++;
        if (!CUSTOMER_BACKFILL_DRY_RUN) {
          try {
            appendBackfillCustomer_(truckingSheet, truckingHeader, aggregate.name, classification.proposedAddress, nextTruckingRow);
            truckingRecords.push(makeBackfillRecord_(nextTruckingRow, aggregate.name, classification.proposedAddress));
            nextTruckingRow++;
            // A brand-new customer whose very first pass already shows 2+
            // distinct addresses gets every one of them created now, not
            // just the first — same "- N" numbering the ambiguous-family/
            // second-location paths already use (Codex review, round 5).
            classification.pendingAddresses.forEach(function (address) {
              var newName = appendNewFamilyLocation_(truckingSheet, truckingHeader, aggregate.name, truckingRecords, address, nextTruckingRow);
              truckingRecords.push(makeBackfillRecord_(nextTruckingRow, newName, address));
              nextTruckingRow++;
            });
            logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
          } catch (writeError) {
            logCustomerBackfillCandidate_(aggregate.name, aggregate, classification, writeError);
          }
        } else {
          logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
        }
      } else if (classification.classification === "would-flag-second-location") {
        wouldFlag++;
        if (!CUSTOMER_BACKFILL_DRY_RUN) {
          try {
            // One append per distinct address not yet on file anywhere in
            // this customer's location family — not just the first one —
            // so no known-different address is silently dropped.
            classification.pendingAddresses.forEach(function (address) {
              var newName = flagBackfillSecondLocation_(
                truckingSheet, truckingHeader, truckingRecords, classification.matchedRecord, address, nextTruckingRow
              );
              truckingRecords.push(makeBackfillRecord_(nextTruckingRow, newName, address));
              nextTruckingRow++;
            });
            logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
          } catch (writeError) {
            logCustomerBackfillCandidate_(aggregate.name, aggregate, classification, writeError);
          }
        } else {
          logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
        }
      } else if (classification.classification === "would-fill-missing-address") {
        wouldFill++;
        if (!CUSTOMER_BACKFILL_DRY_RUN) {
          try {
            fillBackfillCustomerAddress_(truckingSheet, truckingHeader, classification.matchedRecord, classification.proposedAddress);
            classification.matchedRecord.address = classification.proposedAddress;
            logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
          } catch (writeError) {
            logCustomerBackfillCandidate_(aggregate.name, aggregate, classification, writeError);
          }
        } else {
          logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
        }
      } else if (classification.classification === "would-repair-split-rename") {
        // A prior flagBackfillSecondLocation_ append succeeded but its
        // follow-up rename didn't — finish the rename now rather than
        // leaving the pair permanently unrecognized as a split family.
        wouldRepair++;
        if (!CUSTOMER_BACKFILL_DRY_RUN) {
          try {
            renameToFirstLocation_(truckingSheet, truckingHeader, classification.matchedRecord);
            logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
          } catch (writeError) {
            logCustomerBackfillCandidate_(aggregate.name, aggregate, classification, writeError);
          }
        } else {
          logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
        }
      } else if (classification.classification === "canonical-match-needs-review") {
        // Matched only via the canonical/brand-alias fallback, not the
        // literal exact name — could be a different physical location
        // under the same multi-location brand (e.g. MEGA MART Fremont vs.
        // the lone existing Palo Alto record). Never mutate; log only, for
        // a human to confirm before this ever writes (Codex review, round 5).
        needsReviewCount++;
        logCustomerBackfillCandidate_(aggregate.name, aggregate, classification);
      } else {
        okCount++;
      }
    });

    logPipeline_("CUSTOMER BACKFILL SUMMARY", "", JSON.stringify({
      scannedNames: aggregation.aggregates.size,
      wouldCreate: wouldCreate,
      wouldFlagSecondLocation: wouldFlag,
      wouldFillMissingAddress: wouldFill,
      wouldRepairSplitRename: wouldRepair,
      ambiguousLocationFamily: ambiguousCount,
      canonicalMatchNeedsReview: needsReviewCount,
      okNoAction: okCount,
      skippedBlankNameRows: aggregation.skippedBlankNameRows,
      dryRun: CUSTOMER_BACKFILL_DRY_RUN
    }));

    Logger.log(
      "Customer backfill: scanned=" + aggregation.aggregates.size +
      ", wouldCreate=" + wouldCreate +
      ", wouldFlagSecondLocation=" + wouldFlag +
      ", wouldFillMissingAddress=" + wouldFill +
      ", wouldRepairSplitRename=" + wouldRepair +
      ", ambiguousLocationFamily=" + ambiguousCount +
      ", canonicalMatchNeedsReview=" + needsReviewCount +
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
      wouldRepairSplitRename: wouldRepair,
      ambiguousLocationFamily: ambiguousCount,
      canonicalMatchNeedsReview: needsReviewCount,
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
 * Canonical family "base key" for name: the "- N" suffix stripped, then
 * canonicalized the same way every family-membership check in this file
 * uses. Centralizing this is the fix for a gap Codex found in the previous
 * revision: isSuffixLocationFamily_/hasEstablishedSuffixConvention_ were
 * canonicalized, but familyAddressesFor_ and nextCustomerLocationSuffix_
 * still compared raw/simple-normalized base names — so a punctuation-variant
 * candidate ("Acme Co Inc") could pass the ambiguity check (recognized as
 * the "Acme Co, Inc. - 1/-2" family) yet still see no addresses on file for
 * that family and get numbered as a fresh "- 1", instead of correctly
 * landing on "- 3" and recognizing addresses already on file (PR #92).
 */
function canonicalFamilyBaseKey_(name) {
  return normalizeWmsCustomerKey_(canonicalWmsCustomer_(stripBackfillLocationSuffix_(name)));
}

/**
 * True when 2+ existing TRUCKING records already share customerValue's base
 * name (ignoring any "- N" suffix) once BOTH sides are canonicalized the
 * same way — not just simple-normalized. A sibling's stripped base name is
 * canonicalized (not just uppercase/whitespace-collapsed) so a punctuation
 * or legal-suffix variant of an already-split family's base ("Acme Co,
 * Inc." vs "Acme Co Inc") still counts as the same family (Codex review on
 * PR #92) instead of reading as "no family at all" and getting a fresh
 * blank duplicate appended on every run. Note this also catches a purely
 * canonical-alias family with no literal "- N" on any record (e.g. MEGA
 * MART's differently-named locations) — for the write-safety question of
 * whether it's safe to APPEND a new "- N" row, see
 * hasEstablishedSuffixConvention_ below, which is deliberately narrower.
 */
function isSuffixLocationFamily_(customerValue, records) {
  var canonicalKey = canonicalFamilyBaseKey_(customerValue);
  if (!canonicalKey) return false;
  var suffixMatches = records.filter(function (r) {
    return canonicalFamilyBaseKey_(r.name) === canonicalKey;
  });
  return suffixMatches.length > 1;
}

/**
 * True when at least one existing TRUCKING record ALREADY carries a literal
 * "- N" suffix (not just canonicalizes the same after stripping one) whose
 * stripped, canonicalized base matches customerValue's canonical key. Used
 * to gate live writes for an ambiguous-location-family candidate: it's only
 * safe to append a new "<base> - N" row without guessing when that numbering
 * convention is demonstrably already in use for this exact family, as
 * opposed to a purely canonical-alias family (e.g. MEGA MART's
 * differently-named "(Palo Alto)"/"- Fremont" locations) that has never used
 * "- N" naming at all — appending "MEGA MART - 3" there would invent a
 * convention the sheet doesn't use, not just extend an existing one.
 */
function hasEstablishedSuffixConvention_(customerValue, records) {
  var canonicalKey = canonicalFamilyBaseKey_(customerValue);
  if (!canonicalKey) return false;
  return records.some(function (r) {
    if (!/^(.*?)\s*-\s*(\d+)\s*$/.test(r.name)) return false;
    return canonicalFamilyBaseKey_(r.name) === canonicalKey;
  });
}

function isBackfillAmbiguousLocationFamily_(customerValue, records) {
  if (isSuffixLocationFamily_(customerValue, records)) return true;

  var canonicalKey = normalizeWmsCustomerKey_(canonicalWmsCustomer_(customerValue));
  if (!canonicalKey) return false;
  var canonicalMatches = records.filter(function (r) { return r.canonicalKey === canonicalKey; });
  return canonicalMatches.length > 1;
}

/**
 * Every distinct, non-blank address already on file across the WHOLE
 * location family sharing name's base (not just one matched record) — so a
 * genuinely new address is never mistaken for "new" just because it
 * doesn't match one particular sibling location, and vice versa.
 */
function familyAddressesFor_(name, records) {
  var baseKey = canonicalFamilyBaseKey_(name);
  var addresses = [];
  records.forEach(function (r) {
    if (canonicalFamilyBaseKey_(r.name) !== baseKey) return;
    if (r.address && addresses.indexOf(r.address) === -1) addresses.push(r.address);
  });
  return addresses;
}

/**
 * True when customerValue matched record via a literal exact-name equality
 * (case/whitespace-insensitive), not merely the same canonical/brand-alias
 * key. matchBackfillCustomerRecord_ already tries exact first and only
 * falls back to canonical when no exact match exists, so this recomputes
 * the same predicate to tell the two paths apart after the fact.
 */
function matchedByExactBackfillName_(customerValue, record) {
  return customerValue.toUpperCase().replace(/\s+/g, " ").trim() === record.exactKey;
}

/**
 * The core reconciliation decision for one distinct customer name:
 *  - matches 2+ existing locations already -> "ambiguous-location-family"
 *  - no TRUCKING match at all               -> "would-create"
 *  - matched only via canonical/brand-alias
 *    fallback, not the literal exact name   -> "canonical-match-needs-review"
 *    (see matchedByExactBackfillName_ below — a canonical-only match can be a
 *    DIFFERENT physical location under the same multi-location brand, e.g.
 *    "MEGA MART (FREMONT)" canonical-matching the lone existing
 *    "MEGA MART (PALO ALTO)" record when Fremont has no row of its own yet.
 *    Mutating that record would silently write Fremont's address onto
 *    Palo Alto's row — Codex review on PR #92 round 5. Only an exact-name
 *    match is trusted enough to fill/rename/flag an existing row; every
 *    other outcome below this point requires one.)
 *  - matched an unsuffixed record that has
 *    a suffixed sibling in its family       -> "would-repair-split-rename"
 *    (a prior flagBackfillSecondLocation_ append succeeded but its rename
 *    didn't — repairs the partial write, see below)
 *  - matched, TRUCKING has no address on file
 *    but the log/Customer Entry has one     -> "would-fill-missing-address"
 *  - matched, one or more observed addresses
 *    aren't on file anywhere in the family  -> "would-flag-second-location"
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
    if (isBackfillAmbiguousLocationFamily_(name, truckingRecords)) {
      // The name itself is ambiguous (2+ candidate locations), but WHICH
      // address is new is not, when the family already uses the explicit
      // "- N" suffix convention: every sibling sharing name's stripped base
      // is known, so an address not on file for any of them is a genuinely
      // new location regardless of which existing sibling this shipment
      // happens to be near. Only compute/act on this for suffix families —
      // an alias-only ambiguous family (e.g. MEGA MART's differently-named
      // locations) has no established numbering convention to append into
      // safely, so it stays log-only exactly as before (Codex review on
      // PR #92: "still identify and append genuinely new addresses" without
      // reintroducing a guess for the alias-only case).
      var isSuffixFamily = hasEstablishedSuffixConvention_(name, truckingRecords);
      var knownFamilyAddresses = isSuffixFamily ? familyAddressesFor_(name, truckingRecords) : [];
      var pendingFamilyAddresses = isSuffixFamily
        ? allAddresses.filter(function (address) { return address && knownFamilyAddresses.indexOf(address) === -1; })
        : [];
      return {
        classification: "ambiguous-location-family",
        matchedRecord: null,
        proposedAddress: pendingFamilyAddresses[0] || allAddresses[0] || "",
        pendingAddresses: pendingFamilyAddresses,
        existingAddress: null,
        addressVariants: allAddresses,
        sourcesUsed: sourcesUsed
      };
    }
    return {
      classification: "would-create",
      matchedRecord: null,
      proposedAddress: allAddresses[0] || "",
      // Codex review on PR #92 (round 5): a brand-new customer whose very
      // first pass already shows 2+ distinct addresses must not leave the
      // extras for "whenever the job happens to run again" — surface every
      // address beyond the first so the write loop can create every known
      // location now, not just one.
      pendingAddresses: allAddresses.slice(1),
      existingAddress: null,
      addressVariants: allAddresses,
      sourcesUsed: sourcesUsed
    };
  }

  if (!matchedByExactBackfillName_(name, matchedRecord)) {
    return {
      classification: "canonical-match-needs-review",
      matchedRecord: matchedRecord,
      proposedAddress: allAddresses[0] || "",
      pendingAddresses: [],
      existingAddress: matchedRecord.address || "",
      addressVariants: allAddresses,
      sourcesUsed: sourcesUsed
    };
  }

  // Recovers a partial flagBackfillSecondLocation_ write: if the append
  // succeeded but the follow-up "- 1" rename failed (transient Sheets
  // error), matchedRecord here exact-matches the still-unsuffixed original,
  // and familyAddressesFor_ already sees the appended sibling's address —
  // so without this check it would silently resolve as "ok-no-action"
  // forever, leaving a "<name>" + "<name> - N" pair that a later bare-name
  // lookup treats as an unambiguous single location instead of the split
  // family it actually is (Codex review on PR #92). Detect it directly:
  // this matched record itself carries no suffix, yet a sibling sharing its
  // canonical base already does — that can only happen mid-split.
  var needsSplitRepair = !/^(.*?)\s*-\s*(\d+)\s*$/.test(matchedRecord.name) &&
    truckingRecords.some(function (r) {
      return r !== matchedRecord &&
        /^(.*?)\s*-\s*(\d+)\s*$/.test(r.name) &&
        canonicalFamilyBaseKey_(r.name) === canonicalFamilyBaseKey_(matchedRecord.name);
    });
  if (needsSplitRepair) {
    return {
      classification: "would-repair-split-rename",
      matchedRecord: matchedRecord,
      proposedAddress: "",
      pendingAddresses: [],
      existingAddress: matchedRecord.address || "",
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
      pendingAddresses: [],
      existingAddress: "",
      addressVariants: allAddresses,
      sourcesUsed: sourcesUsed
    };
  }

  var familyAddresses = familyAddressesFor_(matchedRecord.name, truckingRecords);
  var pendingAddresses = allAddresses.filter(function (address) {
    return address && familyAddresses.indexOf(address) === -1;
  });

  if (pendingAddresses.length > 0) {
    return {
      classification: "would-flag-second-location",
      matchedRecord: matchedRecord,
      proposedAddress: pendingAddresses[0],
      pendingAddresses: pendingAddresses,
      existingAddress: existingAddress,
      addressVariants: allAddresses,
      sourcesUsed: sourcesUsed
    };
  }

  return {
    classification: "ok-no-action",
    matchedRecord: matchedRecord,
    proposedAddress: allAddresses[0] || "",
    pendingAddresses: [],
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
function stripBackfillLocationSuffix_(name) {
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
  var baseKey = canonicalFamilyBaseKey_(baseName);
  var used = [0];
  records.forEach(function (record) {
    var match = /^(.*?)\s*-\s*(\d+)\s*$/.exec(record.name);
    var recordBaseKey = canonicalFamilyBaseKey_(match ? match[1] : record.name);
    if (recordBaseKey !== baseKey) return;
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
 * "<name> - 1" (its implicit first location).
 *
 * The new row is appended BEFORE the rename, not after (Codex review on
 * PR #92): if the two writes only partially complete, appending first
 * leaves the original row's name untouched, so it's still found by an
 * exact-name match on a later run — self-healing (the row just still
 * needs its "- 1" rename, which the next run's own alreadySuffixed check
 * would still perform). Appending AFTER a completed rename would instead
 * orphan a "<name> - 1" row that nothing can exact-match anymore, and that
 * isBackfillAmbiguousLocationFamily_ can't yet recognize as a family (only 1 known
 * sibling) — reclassifying the bare name as "would-create" and appending
 * an unsuffixed duplicate on top of it forever. Returns the new row's name.
 */
function flagBackfillSecondLocation_(truckingSheet, header, truckingRecords, matchedRecord, newAddress, targetRow) {
  var baseName = stripBackfillLocationSuffix_(matchedRecord.name);
  var alreadySuffixed = /^(.*?)\s*-\s*(\d+)\s*$/.test(matchedRecord.name);

  var nextSuffix = nextCustomerLocationSuffix_(baseName, truckingRecords);
  var newName = baseName + " - " + nextSuffix;
  appendBackfillCustomer_(truckingSheet, header, newName, newAddress, targetRow);

  if (!alreadySuffixed) {
    renameToFirstLocation_(truckingSheet, header, matchedRecord);
  }

  return newName;
}

/**
 * Renames matchedRecord's TRUCKING row in place to its "- 1" implicit-
 * first-location name, updating the in-memory record to match. Shared by
 * flagBackfillSecondLocation_'s normal split and repairSplitRename_'s
 * recovery of a partial split (see classifyCustomerCandidate_'s
 * "would-repair-split-rename" outcome) — the same rename either way.
 */
function renameToFirstLocation_(truckingSheet, header, matchedRecord) {
  var baseName = stripBackfillLocationSuffix_(matchedRecord.name);
  var renamed = baseName + " - 1";
  truckingSheet.getRange(matchedRecord.rowNumber, header.map["CUSTOMER NAME"] + 1).setValue(renamed);
  matchedRecord.name = renamed;
  matchedRecord.exactKey = renamed.toUpperCase().replace(/\s+/g, " ");
  return renamed;
}

/**
 * Appends a new numbered location for an already-ambiguous "- N" suffix
 * family, without needing a single matchedRecord to rename — by
 * construction (see classifyCustomerCandidate_), every record in an
 * ambiguous suffix family is already explicitly suffixed, since an
 * unsuffixed sibling would have exact-matched and never reached this
 * branch. Nothing to rename; just append the next number.
 */
function appendNewFamilyLocation_(truckingSheet, header, baseName, truckingRecords, newAddress, targetRow) {
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
 *
 * Callers pass writeError only when a live write for this candidate just
 * threw — the log tag then reads "CUSTOMER BACKFILL WRITE FAILED" instead
 * of "CUSTOMER BACKFILL LIVE", so the audit trail never claims a write
 * happened when it didn't (Codex review on PR #92 round 5: this is called
 * AFTER a successful write now, not before, for exactly this reason).
 */
function logCustomerBackfillCandidate_(name, aggregate, classification, writeError) {
  try {
    var tag = writeError
      ? "CUSTOMER BACKFILL WRITE FAILED"
      : (CUSTOMER_BACKFILL_DRY_RUN ? "CUSTOMER BACKFILL DRY RUN" : "CUSTOMER BACKFILL LIVE");
    logPipeline_(tag, name, JSON.stringify({
      action: classification.classification,
      customer: name,
      occurrenceCount: aggregate.occurrenceCount,
      proposedAddress: classification.proposedAddress,
      pendingAddresses: classification.pendingAddresses,
      existingAddress: classification.existingAddress,
      existingTruckingRow: classification.matchedRecord ? classification.matchedRecord.rowNumber : null,
      sources: classification.sourcesUsed,
      addressVariants: classification.addressVariants,
      sampleRows: aggregate.sampleRows,
      error: writeError ? String((writeError && writeError.message) || writeError) : undefined
    }));
  } catch (e) {
    Logger.log("logCustomerBackfillCandidate_ failed: " + (e && e.message || e));
  }
}
