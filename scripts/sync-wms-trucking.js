#!/usr/bin/env node

/**
 * Sync Runner Script: WMS Trucking Scanner & Importer
 *
 * Scans the WMS "Invoice and Issues" spreadsheet for rows whose Shipping
 * Method is "Trucking", merges multiple invoices for the same customer + ship
 * date into a single shipment entry, then reports which entries are new and
 * which have changed relative to the "WH Trucking Request" tab.
 *
 * Sheet IDs can be overridden via environment variables:
 *   TARGET_SHEET_ID  — Logistics Master 2026 (default: 1M-vZ24…)
 *   WMS_SHEET_ID     — WMS Invoice & Issues  (default: 14lH9S…)
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const TARGET_SHEET_ID = process.env.TARGET_SHEET_ID || "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const WMS_SHEET_ID    = process.env.WMS_SHEET_ID    || "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";

/**
 * Maps each logical field to the column-header keywords used to locate it in
 * the WMS source sheet.  Keeping this declarative means adding a new field
 * only requires a single entry here — no other code needs to change.
 */
const WMS_COLUMN_SPECS = {
  method:   ["SHIPPING METHOD", "SHIP METHOD", "METHOD"],
  invoice:  ["INVOICE#", "INVOICE NO.", "INVOICE #", "INVOICE"],
  customer: ["CUSTOMER NAME", "CUSTOMER", "CLIENT"],
  shipDate: ["SHIP DATE", "DATE"],
  pallets:  ["PALLET", "PLT", "QTY", "CARTONS"],
  carrier:  ["CARRIER", "TRUCKING"],
  pro:      ["PRO#", "PRO", "TRACKING#", "BOL"],
  note:     ["REMARKS (SALES)", "REMARKS (WAREHOUSE)", "NOTE", "REMARK"],
};

// ─── GViz fetch helper ────────────────────────────────────────────────────────

/**
 * Fetches a Google Sheets table via the GViz JSON endpoint.
 *
 * @param {string} sheetId  - Spreadsheet ID.
 * @param {string} tabName  - Sheet/tab name (empty = first sheet).
 * @param {string} range    - A1 range (empty = entire sheet).
 * @param {string} headers  - "0" means the sheet has no header row to skip.
 * @returns {Promise<object>} The `table` object from the GViz payload.
 */
async function fetchGvizTable(sheetId, tabName = "", range = "", headers = "1") {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`);
  url.searchParams.set("tqx",     "out:json");
  url.searchParams.set("headers", headers);
  if (tabName) url.searchParams.set("sheet", tabName);
  if (range)   url.searchParams.set("range", range);

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching sheet '${sheetId}'${tabName ? ` / '${tabName}'` : ""}`);
  }

  const text = await res.text();
  // GViz wraps JSON in a callback — strip everything outside the outermost braces.
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`Invalid GViz payload for sheet '${sheetId}'`);

  const payload = JSON.parse(text.slice(start, end + 1));
  if (payload.status !== "ok") throw new Error(`GViz error for sheet '${sheetId}': ${payload.status}`);

  return payload.table;
}

// ─── Column-resolution helpers ────────────────────────────────────────────────

/**
 * Finds the first column index (0-based) whose header matches any of the given
 * keywords (case-insensitive substring match).
 *
 * @param {string[]} headerCols - Normalised (upper-cased) header names.
 * @param {string[]} keywords   - Candidate keywords to search for.
 * @returns {number} Column index, or -1 if not found.
 */
function findColIndex(headerCols, keywords) {
  return headerCols.findIndex(h => keywords.some(kw => h.includes(kw)));
}

/**
 * Builds a column-index map for every logical field defined in WMS_COLUMN_SPECS
 * by scanning a single header row.
 *
 * @param {string[]} headerCols - Normalised (upper-cased) header names.
 * @returns {Object<string, number>} e.g. { method: 5, invoice: 1, … }
 */
function resolveWmsColumns(headerCols) {
  return Object.fromEntries(
    Object.entries(WMS_COLUMN_SPECS).map(([field, keywords]) => [
      field,
      findColIndex(headerCols, keywords),
    ])
  );
}

/**
 * Reads a cell value from a row by logical column name, falling back to "".
 *
 * @param {string[]}            vals - Raw cell values for the row.
 * @param {Object<string,number>} colMap - Output of resolveWmsColumns().
 * @param {string}              field  - Logical field name.
 */
function cellOf(vals, colMap, field) {
  const idx = colMap[field];
  return (idx !== undefined && idx >= 0) ? (vals[idx] || "") : "";
}

// ─── String normalisation utilities ──────────────────────────────────────────

/** Normalises a customer name to UPPER-CASE with collapsed whitespace. */
const normCustomer = str => str.toUpperCase().replace(/\s+/g, " ").trim();

/** Normalises a date string for key comparison. */
const normDate = str => str.toUpperCase().trim();

/**
 * Deduplicates and joins an array of strings, skipping empty values.
 *
 * @param {string[]} arr       - Source values.
 * @param {string}   separator - Joiner (default: newline).
 */
const dedupJoin = (arr, separator = "\n") =>
  [...new Set(arr.filter(Boolean))].join(separator);

// ─── Main scan function ───────────────────────────────────────────────────────

/**
 * Scans the WMS sheet and compares it against the existing target tab.
 *
 * @param {{ dryRun?: boolean }} options
 * @returns {Promise<ScanResult>}
 *
 * @typedef {{ ok: true,  scanned: number, truckingCount: number, groups: number,
 *             newCount: number, modifiedCount: number,
 *             newEntries: Entry[], modifiedEntries: ModifiedEntry[] }} ScanResult
 * @typedef {{ customer: string, shipDate: string, invoice: string, pallets: string,
 *             carrier: string, pro: string, note: string, status: string }} Entry
 * @typedef {Entry & { existingRow: number }} ModifiedEntry
 */
async function runScan({ dryRun = false } = {}) {
  log("INFO", `Starting WMS Trucking scan from WMS Sheet ${WMS_SHEET_ID}… (dryRun=${dryRun})`);

  // ── Step 1: Fetch and parse WMS sheet ──────────────────────────────────────
  let wmsRows;
  try {
    wmsRows = await fetchWmsRows();
  } catch (err) {
    log("ERROR", `Failed to fetch WMS sheet '${WMS_SHEET_ID}': ${err.message}`);
    return { ok: false, error: err.message };
  }

  // ── Step 2: Filter to Trucking rows only ───────────────────────────────────
  const truckingRows = wmsRows.filter(({ method }) =>
    method.toUpperCase().includes("TRUCKING")
  );
  log("INFO", `Scanned ${wmsRows.length} rows. Found ${truckingRows.length} with Shipping Method = "Trucking".`);

  // ── Step 3: Group by (normalised Customer + Ship Date) ────────────────────
  const groups = groupTruckingRows(truckingRows);
  log("INFO", `Grouped ${truckingRows.length} Trucking rows into ${groups.size} distinct shipments.`);

  // ── Step 4: Fetch existing target rows ─────────────────────────────────────
  let existingMap;
  try {
    existingMap = await fetchExistingTargetMap();
  } catch (err) {
    log("ERROR", `Failed to fetch target tab 'WH Trucking Request': ${err.message}`);
    return { ok: false, error: err.message };
  }

  // ── Step 5: Diff groups against existing entries ──────────────────────────
  const { newEntries, modifiedEntries } = diffGroups(groups, existingMap);

  // ── Step 6: Report ─────────────────────────────────────────────────────────
  logScanResult(newEntries, modifiedEntries);

  return {
    ok:            true,
    scanned:       wmsRows.length,
    truckingCount: truckingRows.length,
    groups:        groups.size,
    newCount:      newEntries.length,
    modifiedCount: modifiedEntries.length,
    newEntries,
    modifiedEntries,
  };
}

// ─── Step implementations ─────────────────────────────────────────────────────

/**
 * Fetches and parses every data row from the WMS sheet into plain objects.
 * The WMS header lives on row 2 (index 1); row 1 is a title/merge row.
 */
async function fetchWmsRows() {
  const table   = await fetchGvizTable(WMS_SHEET_ID, "", "", "0");
  const rawRows = table.rows || [];

  const HEADER_ROW_IDX = 1; // WMS header is always on the second row
  if (rawRows.length <= HEADER_ROW_IDX) {
    throw new Error("WMS sheet has fewer than 2 rows — expected a header on row 2.");
  }

  const headerCols = rawRows[HEADER_ROW_IDX].c.map(c =>
    c ? String(c.f ?? c.v ?? "").trim().toUpperCase() : ""
  );
  const colMap = resolveWmsColumns(headerCols);

  return rawRows.slice(HEADER_ROW_IDX + 1).map((r, i) => {
    const vals = r.c ? r.c.map(c => (c ? String(c.f ?? c.v ?? "").trim() : "")) : [];
    return {
      sourceRow: i + HEADER_ROW_IDX + 2, // 1-based sheet row number
      method:    cellOf(vals, colMap, "method"),
      invoice:   cellOf(vals, colMap, "invoice"),
      customer:  cellOf(vals, colMap, "customer"),
      shipDate:  cellOf(vals, colMap, "shipDate"),
      pallets:   cellOf(vals, colMap, "pallets"),
      carrier:   cellOf(vals, colMap, "carrier"),
      pro:       cellOf(vals, colMap, "pro"),
      note:      cellOf(vals, colMap, "note"),
    };
  });
}

/**
 * Groups parsed trucking rows by (normalised customer + normalised ship date).
 * Rows with no customer name get a unique per-row key so they are never merged.
 *
 * @param {object[]} rows - Output of fetchWmsRows(), pre-filtered to Trucking.
 * @returns {Map<string, object[]>}
 */
function groupTruckingRows(rows) {
  const groups = new Map();

  rows.forEach((row, idx) => {
    const nc  = normCustomer(row.customer);
    const nd  = normDate(row.shipDate);
    const key = nc ? `${nc}___${nd}` : `UNKNOWN___${idx}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  return groups;
}

/**
 * Fetches the "WH Trucking Request" tab and builds a dual-keyed lookup map:
 *   "CUST___DATE"   → row object
 *   "INV___<inv>"   → row object  (one entry per invoice in the cell)
 *
 * @returns {Promise<Map<string, object>>}
 */
async function fetchExistingTargetMap() {
  const table   = await fetchGvizTable(TARGET_SHEET_ID, "WH Trucking Request", "A2:U", "1");
  const headers = table.cols.map((c, i) => (c.label || `COL_${i}`).toUpperCase().replace(/\s+/g, " ").trim());

  const existingMap = new Map();

  (table.rows || []).forEach((r, i) => {
    const rowObj = {
      __sourceRow: i + 3, // Row 1 = sheet header, row 2 = range start → data from row 3
      ...Object.fromEntries(
        headers.map((h, j) => {
          const c = r.c?.[j];
          return [h, String(c ? (c.f ?? c.v ?? "") : "").trim()];
        })
      ),
    };

    const cust = (rowObj["CUSTOMER"] || "").toUpperCase().replace(/\s+/g, " ").trim();
    const date = (rowObj["SHIP DATE"] || "").toUpperCase().trim();
    if (cust && date) existingMap.set(`${cust}___${date}`, rowObj);

    // Index every invoice so we can match by individual invoice number too.
    const rawInvs = rowObj["INVOICE NO."] || rowObj["INVOICE #"] || rowObj["INVOICE"] || "";
    rawInvs.split(/[\r\n,;·]+/).forEach(inv => {
      const clean = inv.trim().toUpperCase();
      if (clean) existingMap.set(`INV___${clean}`, rowObj);
    });
  });

  return existingMap;
}

/**
 * Compares each shipment group against `existingMap` and classifies it as
 * new (not found) or modified (invoices have changed since last import).
 *
 * @param {Map<string, object[]>} groups
 * @param {Map<string, object>}   existingMap
 * @returns {{ newEntries: Entry[], modifiedEntries: ModifiedEntry[] }}
 */
function diffGroups(groups, existingMap) {
  const newEntries      = [];
  const modifiedEntries = [];
  const skippedRescheduled = [];

  groups.forEach((items) => {
    const { customer, shipDate } = items[0];
    const combinedInvoices = dedupJoin(items.map(i => i.invoice));
    const combinedCarrier  = items.map(i => i.carrier).find(Boolean) || "Trucking";
    const combinedPro      = dedupJoin(items.map(i => i.pro));
    const combinedPallets  = dedupJoin(items.map(i => i.pallets), " · ");
    const combinedNote     = dedupJoin(items.map(i => i.note),    " · ")
                             || "Imported from WMS Invoice & Issues";

    const matchKey  = `${normCustomer(customer)}___${normDate(shipDate)}`;
    let   matchedRow = existingMap.get(matchKey);

    // Secondary lookup: match any individual invoice number.
    if (!matchedRow) {
      for (const item of items) {
        if (!item.invoice) continue;
        const candidate = existingMap.get(`INV___${item.invoice.toUpperCase()}`);
        if (candidate) { matchedRow = candidate; break; }
      }
    }

    const entry = {
      customer,
      shipDate,
      invoice: combinedInvoices,
      pallets: combinedPallets,
      carrier: combinedCarrier,
      pro:     combinedPro,
      note:    combinedNote,
      status:  "WORK IN PROGRESS",
    };

    if (matchedRow) {
      // Determine the stored invoice value using whichever column name exists.
      const curInvs = matchedRow["INVOICE NO."] || matchedRow["INVOICE #"] || matchedRow["INVOICE"] || "";
      if (curInvs !== combinedInvoices) {
        modifiedEntries.push({ ...entry, existingRow: matchedRow.__sourceRow });
      }
    } else {
      newEntries.push(entry);
    }
  });

  return { newEntries, modifiedEntries };
}

// ─── Logging helpers ──────────────────────────────────────────────────────────

/** Prefixes a message with a timestamp and severity label. */
function log(level, message) {
  const ts = new Date().toLocaleString();
  console.log(`[${ts}] [${level}] ${message}`);
}

/** Formats an entry for a single summary line in the result log. */
const entryLine = (e, idx) =>
  `  ${idx + 1}. ${e.customer} (${e.shipDate}) → Invoices: ${e.invoice.replace(/\n/g, ", ")}`;

function logScanResult(newEntries, modifiedEntries) {
  log("RESULT", `Scan complete: ${newEntries.length} new, ${modifiedEntries.length} modified.`);

  if (newEntries.length > 0) {
    console.log(`\n[NEW ENTRIES (${newEntries.length})]:`);
    newEntries.forEach((e, i) => console.log(entryLine(e, i)));
  }
  if (modifiedEntries.length > 0) {
    console.log(`\n[MODIFIED ENTRIES (${modifiedEntries.length})]:`);
    modifiedEntries.forEach((e, i) =>
      console.log(`  ${i + 1}. Row ${e.existingRow}: ${e.customer} (${e.shipDate}) → Invoices: ${e.invoice.replace(/\n/g, ", ")}`)
    );
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

// ESM equivalent of `if (require.main === module)`.
const isMain = process.argv[1] &&
  (await import("url")).fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const args   = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const loop   = args.includes("--loop");

  await runScan({ dryRun });

  if (loop) {
    const INTERVAL_MS = 30 * 60 * 1000;
    log("INFO", `Entering ${INTERVAL_MS / 60_000}-minute recurring loop…`);
    setInterval(() => runScan({ dryRun }), INTERVAL_MS);
  }
}

export { runScan };
