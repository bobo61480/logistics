/*
 * CustomerLookup.gs — WH Trucking Request customer auto-notes
 *
 * When a Customer name is typed into WH Trucking Request's Column A, looks
 * it up in the TRUCKING tab (the real customer master: Address, Contact,
 * and LIFTGATE/INSIDE/NOTIFY/RESIDENTIAL/MALL/PALLET JACK/APPOINTMENT
 * service flags) and appends what it finds into the row's NOTE column —
 * never overwriting existing manually-typed notes (e.g. "APPOINTMENT RQ +
 * RESIDENTIAL DELIVERY", which staff already write there by hand today).
 *
 * Matching: exact (case/whitespace-insensitive) first; falls back to the
 * same canonical-customer key WmsTruckingSyncV2 uses (Code.gs's
 * canonicalWmsCustomer_) ONLY when that canonical key resolves to exactly
 * one TRUCKING row. Multiple TRUCKING rows sharing a canonical key (e.g.
 * distinct per-location entries like "OVER N OVER Over Beauty - 1/-2/-3",
 * each with its own address/contact) are genuinely different shipments —
 * an ambiguous canonical match is treated as no match rather than guessed,
 * the same discipline that fixed the 2026-08-12 WMS trucking incident.
 *
 * When no match exists at all, a new customer row IS written to TRUCKING
 * live (CUSTOMER_CREATE_DRY_RUN = false, flipped 2026-08-24 after a review
 * period with no writes). Set it back to true to return to log-only
 * (PIPELINE LOG "CUSTOMER DB DRY RUN") without touching any other code.
 *
 * The full backfill/reconciliation of the customer master against the B2B/
 * E-Com transaction-log tabs (with duplicate-address disambiguation) lives
 * in the separate CustomerBackfill.gs batch job, not here — this file only
 * handles the live per-edit lookup + create described above.
 *
 * onEdit(e) below is a bare, zero-config Apps Script "simple trigger" —
 * it fires automatically on every edit with no setupAllTriggers() step
 * required, the same as it always has. Simple triggers cannot call
 * authorization-requiring services such as SpreadsheetApp.openById
 * (Codex review on PR #92, round 2), which is why every PIPELINE LOG write
 * in this file goes through logPipelineFromBoundSpreadsheet_ (writes
 * directly to the already-open, already-authorized bound spreadsheet —
 * GMAIL_PIPELINE.masterId IS this same workbook) instead of the shared
 * logPipeline_ helper other files use from time-based (fully-authorized)
 * triggers. An earlier revision promoted this to a real installable
 * trigger instead, but deploy-apps-script.yml never runs setupAllTriggers()
 * (round 4 finding) — that would have silently disabled this whole feature
 * after every deploy until a human manually re-ran it, trading a narrower,
 * already-fixed logging gap for a worse regression. Fixing the actual
 * authorization-requiring call is strictly better: it keeps the zero-config
 * behavior this handler always had.
 */

var CUSTOMER_DB_SHEET_NAME = "TRUCKING";
var CUSTOMER_LOOKUP_ENABLED = true;
var CUSTOMER_CREATE_DRY_RUN = false;

var CUSTOMER_SERVICE_FLAGS = [
  ["LIFTGATE", "Liftgate"],
  ["INSIDE", "Inside delivery"],
  ["NOTIFY", "Notify before delivery"],
  ["RESIDENTIAL", "Residential delivery"],
  ["MALL", "Mall delivery"],
  ["PALLET JACK", "Pallet jack required"],
  ["APPOINTMENT", "Appointment required"]
];

var CUSTOMER_PROFILE_FIELDS = [
  ["LOCATION / STORE", "LOCATION / STORE"],
  ["RECEIVING HOURS", "RECEIVING HOURS"],
  ["DELIVERY CONTACT", "CONTACT"],
  ["CONTACT PHONE", "PHONE"],
  ["CONTACT EMAIL", "EMAIL"],
  ["DOCK HIGH ONLY", "DOCK HIGH ONLY"],
  ["RESTRICTED AREA", "RESTRICTED AREA"],
  ["DEPALLETIZE", "DEPALLETIZE"],
  ["LUMPER", "LUMPER"],
  ["DEBRIS / PALLET REMOVAL", "DEBRIS / PALLET REMOVAL"],
  ["OTHER DELIVERY INSTRUCTIONS", "OTHER DELIVERY INSTRUCTIONS"]
];

function ensureHeaderColumns_(sheet, header, names) {
  var rowNumber = header.rowIndex + 1;
  names.forEach(function (name) {
    if (header.map[name] !== undefined) return;
    var nextColumn = sheet.getLastColumn() + 1;
    sheet.getRange(rowNumber, nextColumn).setValue(name);
    header.map[name] = nextColumn - 1;
  });
  return header;
}

function profileFromWhRow_(sheet, rowNumber, whHeader) {
  var result = {};
  CUSTOMER_PROFILE_FIELDS.forEach(function (pair) {
    var index = whHeader.map[pair[0]];
    if (index !== undefined) result[pair[1]] = String(sheet.getRange(rowNumber, index + 1).getDisplayValue() || "").trim();
  });
  CUSTOMER_SERVICE_FLAGS.forEach(function (flag) {
    var index = whHeader.map[flag[0]];
    if (index !== undefined) result[flag[0]] = String(sheet.getRange(rowNumber, index + 1).getDisplayValue() || "").trim();
  });
  return result;
}

function fillWhProfileBlanks_(sheet, rowNumber, whHeader, record) {
  CUSTOMER_PROFILE_FIELDS.forEach(function (pair) {
    var whIndex = whHeader.map[pair[0]];
    var value = record.profile && record.profile[pair[1]];
    if (whIndex === undefined || !value) return;
    var range = sheet.getRange(rowNumber, whIndex + 1);
    if (!String(range.getDisplayValue() || "").trim()) range.setValue(value);
  });
  CUSTOMER_SERVICE_FLAGS.forEach(function (flag) {
    var whIndex = whHeader.map[flag[0]];
    if (whIndex === undefined || !record.profile || !record.profile[flag[0]]) return;
    var range = sheet.getRange(rowNumber, whIndex + 1);
    if (!String(range.getDisplayValue() || "").trim()) range.setValue(record.profile[flag[0]]);
  });
}

function onEdit(e) {
  try {
    handleWhTruckingCustomerEdit_(e);
  } catch (err) {
    Logger.log("onEdit customer lookup failed: " + (err && err.message || err));
  }
}

/**
 * Writes one row to PIPELINE LOG using an already-open Spreadsheet handle
 * (e.g. e.source from the onEdit event, or dbSheet.getParent()) instead of
 * opening by ID. GMAIL_PIPELINE.masterId (used by the shared logPipeline_
 * helper) is this same workbook, but SpreadsheetApp.openById is restricted
 * under a simple trigger's authorization regardless of which file ID is
 * passed — this avoids that call entirely rather than requiring this
 * handler to become an installable trigger just to log.
 */
function logPipelineFromBoundSpreadsheet_(spreadsheet, event, subject, detail) {
  try {
    var log = spreadsheet.getSheetByName("PIPELINE LOG") || spreadsheet.insertSheet("PIPELINE LOG");
    if (log.getLastRow() === 0) log.appendRow(["Timestamp", "Event", "Subject", "Detail"]);
    log.appendRow([new Date(), event, subject, detail]);
    if (log.getLastRow() > 2000) log.deleteRows(2, 500); // keep the log bounded, same cap logPipeline_ uses
  } catch (e) {
    Logger.log("logPipelineFromBoundSpreadsheet_ failed: " + (e && e.message || e));
  }
}

/**
 * True when this edit is worth processing: it touches the CUSTOMER column
 * (the original trigger — a new/changed name) OR the ADDRESS column (staff
 * commonly type the customer name and its address as two SEPARATE edits —
 * type name, tab/click to the address cell, type address — each its own
 * onEdit event). Gating on the customer column alone meant an address-only
 * edit never reached customerAddressFillable_ at all, so a customer created
 * blank-address by the first edit stayed permanently addressless (Codex
 * review on PR #92, round 6; round 5's fix only covered the narrower
 * same-batch-paste case). The per-row loop in handleWhTruckingCustomerEdit_
 * already re-reads the customer name fresh from the sheet regardless of
 * which column triggered the event, so widening this gate is sufficient —
 * no other branching needed.
 */
function shouldProcessCustomerLookupEdit_(customerCol, addressCol, editedColStart, editedColEnd) {
  var touchesCustomerCol = customerCol >= editedColStart && customerCol <= editedColEnd;
  var touchesAddressCol = addressCol !== null && addressCol >= editedColStart && addressCol <= editedColEnd;
  return touchesCustomerCol || touchesAddressCol;
}

function touchesCustomerProfileColumn_(whHeader, editedColStart, editedColEnd) {
  var names = ["CUSTOMER", "ADDRESS"].concat(CUSTOMER_PROFILE_FIELDS.map(function (pair) { return pair[0]; }))
    .concat(CUSTOMER_SERVICE_FLAGS.map(function (flag) { return flag[0]; }));
  return names.some(function (name) {
    var index = whHeader.map[name];
    var column = index === undefined ? -1 : index + 1;
    return column >= editedColStart && column <= editedColEnd;
  });
}

function handleWhTruckingCustomerEdit_(e) {
  if (!CUSTOMER_LOOKUP_ENABLED || !e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== "WH Trucking Request") return;

  var headerScan = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 10), sheet.getLastColumn()).getDisplayValues();
  var whHeader = findWhTruckingHeader_(headerScan);
  whHeader = ensureHeaderColumns_(sheet, whHeader,
    CUSTOMER_PROFILE_FIELDS.map(function (pair) { return pair[0]; })
      .concat(CUSTOMER_SERVICE_FLAGS.map(function (flag) { return flag[0]; })));
  var customerCol = whHeader.map["CUSTOMER"] + 1;
  if (whHeader.map["NOTE"] === undefined) return;
  var noteCol = whHeader.map["NOTE"] + 1;
  var addressCol = whHeader.map["ADDRESS"] !== undefined ? whHeader.map["ADDRESS"] + 1 : null;

  var editedColStart = e.range.getColumn();
  var editedColEnd = editedColStart + e.range.getNumColumns() - 1;
  if (!touchesCustomerProfileColumn_(whHeader, editedColStart, editedColEnd)) return;

  var startRow = e.range.getRow();
  var numRows = e.range.getNumRows();
  if (startRow <= whHeader.rowIndex + 1) return;

  // Live writes touch the same TRUCKING sheet reconcileCustomerBackfill()
  // does, and a multi-row paste can trigger this handler more than once in
  // close succession — take the same script lock so a concurrent edit or an
  // overlapping backfill run can never pick the same insertion row.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log("Customer lookup: lock timeout, skipping this edit.");
    // A dropped edit is otherwise invisible outside the Apps Script
    // executions log — surface it in PIPELINE LOG so a busy paste that loses
    // the lock race doesn't silently go unreviewed (Codex review on PR #92).
    logPipelineFromBoundSpreadsheet_(e.source, "CUSTOMER LOOKUP LOCK TIMEOUT", "", JSON.stringify({
      action: "lock-timeout",
      sheet: sheet.getName(),
      startRow: startRow,
      numRows: numRows
    }));
    return;
  }

  try {
    var dbSheet = e.source.getSheetByName(CUSTOMER_DB_SHEET_NAME);
    if (!dbSheet) return;
    var dbValues = dbSheet.getDataRange().getDisplayValues();
    var dbHeader = findCustomerDbHeader_(dbValues);
    dbHeader = ensureHeaderColumns_(dbSheet, dbHeader,
      CUSTOMER_PROFILE_FIELDS.map(function (pair) { return pair[1]; })
        .concat(CUSTOMER_SERVICE_FLAGS.map(function (flag) { return flag[0]; })));
    // Mutable — a single edit event can cover several pasted rows, and both
    // the insertion row and the in-memory record list must stay in sync as
    // each row in the batch is processed, or the same never-seen-before
    // customer appearing twice in one paste creates two duplicate rows
    // instead of the second occurrence matching the first's new row.
    var records = buildCustomerRecords_(dbValues, dbHeader);
    var nextDbRow = dbValues.length + 1;

    for (var i = 0; i < numRows; i++) {
      var rowNumber = startRow + i;
      var customerValue = String(sheet.getRange(rowNumber, customerCol).getDisplayValue() || "").trim();
      if (!customerValue) continue;

      var seedAddress = addressCol ? String(sheet.getRange(rowNumber, addressCol).getDisplayValue() || "").trim() : "";
      var seedProfile = profileFromWhRow_(sheet, rowNumber, whHeader);
      var record = matchCustomerRecord_(customerValue, records);
      if (record) {
        // A canonical-only match (matchCustomerRecord_'s fallback path, not
        // a literal exact name) could be a DIFFERENT physical location
        // under the same multi-location brand — e.g. "MEGA MART (FREMONT)"
        // resolving to the lone existing "MEGA MART (PALO ALTO)" row.
        // Round 5 already gated the address-FILL write on this; round 8's
        // review found the note-append itself was never gated, so a
        // canonical-only match still appended the WRONG location's
        // contact/services into this row's note — increasingly reachable
        // once round 6 widened this handler to also fire on address-only
        // edits. Route it to the same review-only treatment
        // CustomerBackfill.gs's canonical-match-needs-review classification
        // already uses: log for a human, never write anything.
        if (!matchedByExactName_(customerValue, record)) {
          appendCustomerReviewFlag_(sheet, rowNumber, noteCol, "CUSTOMER LOCATION NEEDS REVIEW: possible match " + record.name);
          logCanonicalMatchNeedsReview_(e.source, customerValue, rowNumber, record);
        } else if (customerAddressConflicts_(record, seedAddress)) {
          // A record matched here can be one created earlier in this SAME
          // batch (records[] is mutated as rows are processed) — if this
          // row's own typed address disagrees with that record's address,
          // blindly applying the record's note would silently attach the
          // wrong address to this shipment. Flag instead of guessing (Codex
          // review on PR #92).
          logCustomerAddressConflict_(e.source, customerValue, rowNumber, record, seedAddress);
        } else {
          // The mirror case of a conflict: the matched record (often a
          // same-batch stub this very edit just created) has no address on
          // file yet, and this row supplies one — fill it in now rather
          // than leaving the customer permanently addressless (Codex
          // review on PR #92, round 5).
          if (customerAddressFillable_(record, seedAddress)) {
            fillCustomerAddress_(dbSheet, dbHeader, record, seedAddress);
            record.address = seedAddress;
          }
          fillWhProfileBlanks_(sheet, rowNumber, whHeader, record);
          updateCustomerProfileFromManualEntry_(dbSheet, dbHeader, record, seedProfile);
          appendCustomerNote_(sheet, rowNumber, noteCol, record);
        }
      } else if (isAmbiguousLocationFamily_(customerValue, records)) {
        // Multiple existing TRUCKING rows already share this base name
        // (distinct locations) — never guess which one, and never pile a
        // new blank duplicate on top. Log for a human, write nothing.
        appendCustomerReviewFlag_(sheet, rowNumber, noteCol, "CUSTOMER LOCATION NEEDS REVIEW: multiple locations found");
        logAmbiguousCustomerFamily_(e.source, customerValue, rowNumber);
      } else {
        proposeNewCustomer_(e.source, customerValue, seedAddress, seedProfile, rowNumber, dbSheet, dbHeader, nextDbRow);
        if (!CUSTOMER_CREATE_DRY_RUN) {
          var createdRecord = makeCustomerRecord_(nextDbRow, customerValue, seedAddress);
          createdRecord.profile = seedProfile;
          records.push(createdRecord);
          nextDbRow += 1;
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function findCustomerDbHeader_(rows) {
  for (var r = 0; r < Math.min(rows.length, 5); r++) {
    var map = headerMap_(rows[r]);
    if (map["CUSTOMER NAME"] !== undefined && map["ADDRESS"] !== undefined) {
      return { rowIndex: r, map: map };
    }
  }
  throw new Error("Could not locate the TRUCKING customer database header row.");
}

function buildCustomerRecords_(rows, header) {
  var records = [];
  for (var r = header.rowIndex + 1; r < rows.length; r++) {
    var row = rows[r];
    var name = String(row[header.map["CUSTOMER NAME"]] || "").trim();
    if (!name) continue;
    var services = [];
    CUSTOMER_SERVICE_FLAGS.forEach(function (flag) {
      var col = header.map[flag[0]];
      if (col !== undefined && /^\s*yes/i.test(String(row[col] || ""))) services.push(flag[1]);
    });
    var profile = {};
    CUSTOMER_PROFILE_FIELDS.forEach(function (pair) {
      var col = header.map[pair[1]];
      profile[pair[1]] = col !== undefined ? String(row[col] || "").trim() : "";
    });
    CUSTOMER_SERVICE_FLAGS.forEach(function (flag) {
      var col = header.map[flag[0]];
      profile[flag[0]] = col !== undefined ? String(row[col] || "").trim() : "";
    });
    records.push({
      rowNumber: r + 1,
      name: name,
      exactKey: name.toUpperCase().replace(/\s+/g, " "),
      canonicalKey: normalizeWmsCustomerKey_(canonicalWmsCustomer_(name)),
      address: header.map["ADDRESS"] !== undefined ? String(row[header.map["ADDRESS"]] || "").trim() : "",
      contact: header.map["CONTACT"] !== undefined ? String(row[header.map["CONTACT"]] || "").trim() : "",
      services: services,
      profile: profile
    });
  }
  return records;
}

/**
 * Exact match first; canonical-key match only when it resolves to exactly
 * one candidate. Never guesses among multiple candidates at either stage —
 * ambiguous is treated the same as "no match".
 */
function matchCustomerRecord_(customerValue, records) {
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
 * Strips a trailing " - <N>" location-disambiguation suffix (the sheet's
 * existing convention, e.g. "OVER N OVER Over Beauty - 1/-2/-3", also
 * written live by CustomerBackfill.gs) from a customer name, returning the
 * bare base name shared by every location of the same brand. A name with
 * no suffix is returned unchanged.
 */
function stripCustomerLocationSuffix_(name) {
  var match = /^(.*?)\s*-\s*(\d+)\s*$/.exec(name);
  return match ? match[1].trim() : name;
}

/**
 * True when customerValue is ambiguous against the existing TRUCKING
 * records in either of two ways matchCustomerRecord_ already treats as "no
 * usable match" (never guess) but that matter differently to a live-write
 * caller than a genuinely brand-new customer:
 *  - base name (ignoring any "- N" suffix) matches 2+ records — a family
 *    CustomerBackfill.gs (or a prior live edit) already split into
 *    numbered locations. Without this check the bare brand name matches
 *    neither "- 1" nor "- 2" and reads as "no match at all", creating a
 *    new blank duplicate on top of two already-known locations.
 *  - canonical key (Code.gs's brand-alias handling, e.g. MEGA MART/
 *    TOKTOK BEAUTY/ROYAL IMEX, or two records that otherwise happen to
 *    canonicalize the same) matches 2+ records — the exact "multiple
 *    per-location entries" case matchCustomerRecord_'s own doc comment
 *    describes, which must never be treated as "absent" and created fresh.
 */
function isAmbiguousLocationFamily_(customerValue, records) {
  var canonicalKey = normalizeWmsCustomerKey_(canonicalWmsCustomer_(customerValue));
  if (!canonicalKey) return false;

  // Canonicalize each sibling's stripped base name the same way the query
  // itself is canonicalized below, not just simple-normalized — otherwise a
  // punctuation/legal-suffix variant of an already-split family's base name
  // ("Acme Co, Inc." vs "Acme Co Inc") fails to match and reads as "no
  // family at all", creating a fresh blank duplicate on top of it.
  var suffixMatches = records.filter(function (r) {
    return normalizeWmsCustomerKey_(canonicalWmsCustomer_(stripCustomerLocationSuffix_(r.name))) === canonicalKey;
  });
  if (suffixMatches.length > 1) return true;

  var canonicalMatches = records.filter(function (r) { return r.canonicalKey === canonicalKey; });
  return canonicalMatches.length > 1;
}

function makeCustomerRecord_(rowNumber, name, address) {
  return {
    rowNumber: rowNumber,
    name: name,
    exactKey: name.toUpperCase().replace(/\s+/g, " "),
    canonicalKey: normalizeWmsCustomerKey_(canonicalWmsCustomer_(name)),
    address: address || "",
    contact: "",
    services: [],
    profile: {}
  };
}

function appendCustomerReviewFlag_(sheet, rowNumber, noteCol, message) {
  var range = sheet.getRange(rowNumber, noteCol);
  var existing = String(range.getDisplayValue() || "").trim();
  if (existing.indexOf(message) !== -1) return;
  range.setValue(existing ? existing + "\n" + message : message);
}

function updateCustomerProfileFromManualEntry_(dbSheet, dbHeader, record, seedProfile) {
  if (!record || !seedProfile) return;
  record.profile = record.profile || {};
  Object.keys(seedProfile).forEach(function (name) {
    var value = String(seedProfile[name] || "").trim();
    var index = dbHeader.map[name];
    if (!value || index === undefined) return;
    var current = String(dbSheet.getRange(record.rowNumber, index + 1).getDisplayValue() || "").trim();
    if (!current) {
      dbSheet.getRange(record.rowNumber, index + 1).setValue(value);
      record.profile[name] = value;
    }
  });
}

/**
 * True when this row's own typed address disagrees with the matched
 * record's address on file — a plain trimmed string comparison, same "never
 * normalize away a real difference" rule CustomerBackfill.gs's address
 * comparison uses. Blank on either side is never a conflict: there is
 * nothing to disagree with.
 */
function customerAddressConflicts_(record, seedAddress) {
  return !!(seedAddress && record.address && seedAddress !== record.address);
}

/**
 * True when this row supplies an address and the matched record has none on
 * file — the mirror of customerAddressConflicts_'s blank-side bypass, which
 * otherwise leaves a same-batch stub (created with no address, then matched
 * again later in the same paste once a real address appears) permanently
 * addressless (Codex review on PR #92, round 5).
 */
function customerAddressFillable_(record, seedAddress) {
  return !!(seedAddress && !record.address);
}

/**
 * True when customerValue matched record via a literal exact-name equality
 * (case/whitespace-insensitive), not merely the same canonical/brand-alias
 * key — see CustomerBackfill.gs's matchedByExactName_ for the identical
 * cross-location risk this guards against.
 */
function matchedByExactName_(customerValue, record) {
  return customerValue.toUpperCase().replace(/\s+/g, " ").trim() === record.exactKey;
}

function fillCustomerAddress_(dbSheet, dbHeader, record, address) {
  if (dbHeader.map["ADDRESS"] === undefined) return;
  dbSheet.getRange(record.rowNumber, dbHeader.map["ADDRESS"] + 1).setValue(address);
}

function logCustomerAddressConflict_(spreadsheet, customerValue, whTruckingRow, record, seedAddress) {
  logPipelineFromBoundSpreadsheet_(spreadsheet, "CUSTOMER LOOKUP ADDRESS CONFLICT", customerValue, JSON.stringify({
    action: "address-conflict",
    customer: customerValue,
    whTruckingRow: whTruckingRow,
    matchedTruckingRow: record.rowNumber,
    existingAddress: record.address,
    seedAddress: seedAddress
  }));
}

function logAmbiguousCustomerFamily_(spreadsheet, customerValue, whTruckingRow) {
  logPipelineFromBoundSpreadsheet_(spreadsheet, "CUSTOMER LOOKUP AMBIGUOUS", customerValue, JSON.stringify({
    action: "ambiguous-location-family",
    customer: customerValue,
    whTruckingRow: whTruckingRow
  }));
}

/**
 * Matched only via the canonical/brand-alias fallback, not the literal
 * exact name — could be a different physical location under the same
 * multi-location brand. Never write (note, address, or otherwise); log for
 * a human to confirm which record this shipment actually belongs to
 * (Codex review on PR #92, round 8 — mirrors CustomerBackfill.gs's
 * canonical-match-needs-review classification).
 */
function logCanonicalMatchNeedsReview_(spreadsheet, customerValue, whTruckingRow, record) {
  logPipelineFromBoundSpreadsheet_(spreadsheet, "CUSTOMER LOOKUP CANONICAL MATCH NEEDS REVIEW", customerValue, JSON.stringify({
    action: "canonical-match-needs-review",
    customer: customerValue,
    whTruckingRow: whTruckingRow,
    matchedTruckingRow: record.rowNumber,
    matchedTruckingName: record.name
  }));
}

/**
 * The individual "Address: ..." / "Contact: ..." / "Services: ..." sections
 * a note is built from, before joining — kept separate so a later write can
 * add just the sections that are actually new (see appendCustomerNote_).
 */
function customerNoteParts_(record) {
  var parts = [];
  if (record.address) parts.push("Address: " + record.address);
  if (record.contact) parts.push("Contact: " + record.contact.replace(/\n+/g, " · "));
  if (record.services.length) parts.push("Services: " + record.services.join(", "));
  return parts;
}

function buildCustomerNoteText_(record) {
  return customerNoteParts_(record).join(" | ");
}

/**
 * Splits an existing NOTE cell's text into the individual pipe-delimited
 * sections it's actually made of (one or more "\n"-separated lines, each
 * itself one or more " | "-separated sections) — used to test a generated
 * part for exact membership instead of raw substring search (see
 * appendCustomerNote_ below).
 */
function existingCustomerNoteParts_(existing) {
  return existing
    .split("\n")
    .reduce(function (all, line) { return all.concat(line.split(" | ")); }, [])
    .map(function (part) { return part.trim(); })
    .filter(function (part) { return part; });
}

/**
 * Appends only the note sections not already present in the cell, not the
 * whole combined string. A customer typed and its address filled in as two
 * separate edits (Codex review on PR #92, round 6) matches the same record
 * twice: the first edit appends Contact/Services (Address is still blank on
 * file); the second fills the address and re-runs this with the now-complete
 * record. Comparing the full combined string against existing text missed
 * that the Contact/Services portion was already written — round 9's review
 * found that duplicated them on every address-fill. Filtering per-section
 * instead means only the new "Address: ..." piece gets appended.
 *
 * The per-section check itself must compare exact sections, not raw
 * substrings: a staff-typed manual note like "Previous Address: 123 Main St"
 * contains the generated "Address: 123 Main St" as a literal substring, and
 * "Contact: Jane Doe (old)" contains "Contact: Jane Doe" the same way —
 * plain indexOf treated both as "already present" and silently dropped a
 * genuinely new section (Codex review on PR #92, round 10). Splitting the
 * existing text into its own pipe-delimited sections and requiring an exact
 * match avoids both false positives.
 */
function appendCustomerNote_(sheet, rowNumber, noteCol, record) {
  var parts = customerNoteParts_(record);
  if (!parts.length) return;
  var noteRange = sheet.getRange(rowNumber, noteCol);
  var existing = String(noteRange.getDisplayValue() || "");
  var existingParts = existingCustomerNoteParts_(existing);
  var newParts = parts.filter(function (part) { return existingParts.indexOf(part) === -1; });
  if (!newParts.length) return;
  var noteText = newParts.join(" | ");
  noteRange.setValue(existing ? existing + "\n" + noteText : noteText);
}

/**
 * No TRUCKING record matched this customer name at all. Appends a new row
 * live with whatever address was already typed into this WH Trucking
 * Request row (often blank — filled in by staff later), unless
 * CUSTOMER_CREATE_DRY_RUN is set back to true, in which case it only logs
 * the proposal to PIPELINE LOG ("CUSTOMER DB DRY RUN") for review instead.
 */
function proposeNewCustomer_(spreadsheet, customerValue, seedAddress, seedProfile, whTruckingRow, dbSheet, dbHeader, targetDbRow) {
  if (CUSTOMER_CREATE_DRY_RUN) {
    logPipelineFromBoundSpreadsheet_(spreadsheet, "CUSTOMER DB DRY RUN", customerValue, JSON.stringify({
      action: "would-create",
      customer: customerValue,
      seedAddress: seedAddress,
      seedProfile: seedProfile,
      whTruckingRow: whTruckingRow
    }));
    return;
  }

  var width = Math.max.apply(null, Object.keys(dbHeader.map).map(function (key) { return dbHeader.map[key]; })) + 1;
  var newRow = new Array(width).fill("");
  newRow[dbHeader.map["CUSTOMER NAME"]] = customerValue;
  if (seedAddress && dbHeader.map["ADDRESS"] !== undefined) newRow[dbHeader.map["ADDRESS"]] = seedAddress;
  Object.keys(seedProfile || {}).forEach(function (name) {
    if (seedProfile[name] && dbHeader.map[name] !== undefined) newRow[dbHeader.map[name]] = seedProfile[name];
  });
  dbSheet.getRange(targetDbRow, 1, 1, width).setValues([newRow]);
}
