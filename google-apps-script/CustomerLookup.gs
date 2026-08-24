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

function onEdit(e) {
  try {
    handleWhTruckingCustomerEdit_(e);
  } catch (err) {
    Logger.log("onEdit customer lookup failed: " + (err && err.message || err));
  }
}

function handleWhTruckingCustomerEdit_(e) {
  if (!CUSTOMER_LOOKUP_ENABLED || !e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== "WH Trucking Request") return;

  var headerScan = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 10), sheet.getLastColumn()).getDisplayValues();
  var whHeader = findWhTruckingHeader_(headerScan);
  var customerCol = whHeader.map["CUSTOMER"] + 1;
  if (whHeader.map["NOTE"] === undefined) return;
  var noteCol = whHeader.map["NOTE"] + 1;
  var addressCol = whHeader.map["ADDRESS"] !== undefined ? whHeader.map["ADDRESS"] + 1 : null;

  var editedColStart = e.range.getColumn();
  var editedColEnd = editedColStart + e.range.getNumColumns() - 1;
  if (customerCol < editedColStart || customerCol > editedColEnd) return;

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
    return;
  }

  try {
    var dbSheet = e.source.getSheetByName(CUSTOMER_DB_SHEET_NAME);
    if (!dbSheet) return;
    var dbValues = dbSheet.getDataRange().getDisplayValues();
    var dbHeader = findCustomerDbHeader_(dbValues);
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

      var record = matchCustomerRecord_(customerValue, records);
      if (record) {
        appendCustomerNote_(sheet, rowNumber, noteCol, record);
      } else if (isAmbiguousLocationFamily_(customerValue, records)) {
        // Multiple existing TRUCKING rows already share this base name
        // (distinct locations) — never guess which one, and never pile a
        // new blank duplicate on top. Log for a human, write nothing.
        logAmbiguousCustomerFamily_(customerValue, rowNumber);
      } else {
        var seedAddress = addressCol ? String(sheet.getRange(rowNumber, addressCol).getDisplayValue() || "").trim() : "";
        proposeNewCustomer_(customerValue, seedAddress, rowNumber, dbSheet, dbHeader, nextDbRow);
        if (!CUSTOMER_CREATE_DRY_RUN) {
          records.push(makeCustomerRecord_(nextDbRow, customerValue, seedAddress));
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
    records.push({
      rowNumber: r + 1,
      name: name,
      exactKey: name.toUpperCase().replace(/\s+/g, " "),
      canonicalKey: normalizeWmsCustomerKey_(canonicalWmsCustomer_(name)),
      address: header.map["ADDRESS"] !== undefined ? String(row[header.map["ADDRESS"]] || "").trim() : "",
      contact: header.map["CONTACT"] !== undefined ? String(row[header.map["CONTACT"]] || "").trim() : "",
      services: services
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
  var exactKey = customerValue.toUpperCase().replace(/\s+/g, " ").trim();
  var suffixMatches = records.filter(function (r) {
    return stripCustomerLocationSuffix_(r.name).toUpperCase().replace(/\s+/g, " ").trim() === exactKey;
  });
  if (suffixMatches.length > 1) return true;

  var canonicalKey = normalizeWmsCustomerKey_(canonicalWmsCustomer_(customerValue));
  if (!canonicalKey) return false;
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
    services: []
  };
}

function logAmbiguousCustomerFamily_(customerValue, whTruckingRow) {
  try {
    logPipeline_("CUSTOMER LOOKUP AMBIGUOUS", customerValue, JSON.stringify({
      action: "ambiguous-location-family",
      customer: customerValue,
      whTruckingRow: whTruckingRow
    }));
  } catch (e) {
    Logger.log("logAmbiguousCustomerFamily_ failed: " + e.message);
  }
}

function buildCustomerNoteText_(record) {
  var parts = [];
  if (record.address) parts.push("Address: " + record.address);
  if (record.contact) parts.push("Contact: " + record.contact.replace(/\n+/g, " · "));
  if (record.services.length) parts.push("Services: " + record.services.join(", "));
  return parts.join(" | ");
}

function appendCustomerNote_(sheet, rowNumber, noteCol, record) {
  var noteText = buildCustomerNoteText_(record);
  if (!noteText) return;
  var noteRange = sheet.getRange(rowNumber, noteCol);
  var existing = String(noteRange.getDisplayValue() || "");
  if (existing.indexOf(noteText) !== -1) return;
  noteRange.setValue(existing ? existing + "\n" + noteText : noteText);
}

/**
 * No TRUCKING record matched this customer name at all. Appends a new row
 * live with whatever address was already typed into this WH Trucking
 * Request row (often blank — filled in by staff later), unless
 * CUSTOMER_CREATE_DRY_RUN is set back to true, in which case it only logs
 * the proposal to PIPELINE LOG ("CUSTOMER DB DRY RUN") for review instead.
 */
function proposeNewCustomer_(customerValue, seedAddress, whTruckingRow, dbSheet, dbHeader, targetDbRow) {
  if (CUSTOMER_CREATE_DRY_RUN) {
    try {
      logPipeline_("CUSTOMER DB DRY RUN", customerValue, JSON.stringify({
        action: "would-create",
        customer: customerValue,
        seedAddress: seedAddress,
        whTruckingRow: whTruckingRow
      }));
    } catch (e) {
      Logger.log("proposeNewCustomer_ logging failed: " + e.message);
    }
    return;
  }

  var width = Math.max.apply(null, Object.keys(dbHeader.map).map(function (key) { return dbHeader.map[key]; })) + 1;
  var newRow = new Array(width).fill("");
  newRow[dbHeader.map["CUSTOMER NAME"]] = customerValue;
  if (seedAddress && dbHeader.map["ADDRESS"] !== undefined) newRow[dbHeader.map["ADDRESS"]] = seedAddress;
  dbSheet.getRange(targetDbRow, 1, 1, width).setValues([newRow]);
}
