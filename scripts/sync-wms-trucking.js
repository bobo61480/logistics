#!/usr/bin/env node

/**
 * Sync Runner Script: WMS Trucking Scanner & Importer
 * Scans WMS Invoice and Issues spreadsheet (14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I)
 * for rows with Shipping Method = "Trucking", combines multiple invoices for the same customer
 * and ship date into one entry, and synchronizes new/updated entries to the WH Trucking Request tab.
 */

const TARGET_SHEET_ID = process.env.TARGET_SHEET_ID || "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const WMS_SHEET_ID = process.env.WMS_SHEET_ID || "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";

async function fetchGvizTable(sheetId, tabName = "", range = "", headersVal = "1") {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:json");
  url.searchParams.set("headers", headersVal);
  if (tabName) url.searchParams.set("sheet", tabName);
  if (range) url.searchParams.set("range", range);

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching sheet '${sheetId}' / '${tabName}'`);
  const text = await res.text();
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error(`Invalid GViz payload for sheet '${sheetId}'`);
  const payload = JSON.parse(text.slice(a, b + 1));
  if (payload.status !== "ok") throw new Error(`GViz error on '${sheetId}': ${payload.status}`);
  return payload.table;
}

function getColValue(row, ...names) {
  const normalizedNames = names.map(n => n.toUpperCase());
  for (const key of Object.keys(row)) {
    if (normalizedNames.some(n => key.includes(n)) && row[key]) {
      return row[key];
    }
  }
  return "";
}

function normalizeShipDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return text.toUpperCase();
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  return [year, String(Number(match[1])).padStart(2, "0"), String(Number(match[2])).padStart(2, "0")].join("-");
}

async function runScan({ dryRun = false } = {}) {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}] Starting WMS Trucking scan from WMS Sheet ${WMS_SHEET_ID}... (dryRun=${dryRun})`);

  let wmsRows = [];
  try {
    const table = await fetchGvizTable(WMS_SHEET_ID, "", "", "0");
    const rawRows = table.rows || [];
    
    // Header is on Row 2 (idx 1)
    let headerRowIdx = 1;
    if (rawRows.length <= headerRowIdx) throw new Error("WMS sheet has fewer than 2 rows.");
    const headerCols = rawRows[headerRowIdx].c.map(c => c ? String(c.f ?? c.v ?? "").trim().toUpperCase() : "");

    wmsRows = rawRows.slice(headerRowIdx + 1).map((r, rowIndex) => {
      const vals = r.c ? r.c.map(c => c ? String(c.f ?? c.v ?? "").trim() : "") : [];
      const rowObj = { __sourceRow: rowIndex + headerRowIdx + 2 };
      headerCols.forEach((h, i) => {
        const key = h || `COL_${i}`;
        rowObj[key] = vals[i] || "";
      });
      // Fallback positional indexing if header labels vary
      rowObj["_DATE"] = vals[0] || "";
      rowObj["_INVOICE"] = vals[1] || "";
      rowObj["_CUSTOMER"] = vals[2] || "";
      rowObj["_SALES"] = vals[3] || "";
      rowObj["_SHIPDATE"] = vals[4] || vals[0] || "";
      rowObj["_METHOD"] = vals[5] || "";
      return rowObj;
    });
  } catch (err) {
    console.error(`[ERROR] Failed to fetch external WMS sheet '${WMS_SHEET_ID}':`, err.message);
    return { ok: false, error: err.message };
  }

  // Filter rows where Shipping Method is "Trucking"
  const truckingRows = wmsRows.filter(row => {
    const method = row["_METHOD"] || getColValue(row, "SHIPPING METHOD", "SHIP METHOD", "METHOD");
    return method.toUpperCase().includes("TRUCKING");
  });

  console.log(`[INFO] Scanned ${wmsRows.length} total rows from WMS sheet. Found ${truckingRows.length} with Shipping Method = 'Trucking'.`);

  // Group by (Customer + Ship Date)
  const groups = new Map();
  truckingRows.forEach((row, idx) => {
    const invoice = row["_INVOICE"] || getColValue(row, "INVOICE#", "INVOICE NO.", "INVOICE #", "INVOICE");
    const customer = row["_CUSTOMER"] || getColValue(row, "CUSTOMER NAME", "CUSTOMER", "CLIENT");
    const shipDate = row["_SHIPDATE"] || getColValue(row, "SHIP DATE", "DATE");
    const pallets = getColValue(row, "PALLET", "PLT", "QTY", "CARTONS");
    const carrier = getColValue(row, "CARRIER", "TRUCKING");
    const pro = getColValue(row, "PRO#", "PRO", "TRACKING#", "BOL");
    const note = getColValue(row, "REMARKS (SALES)", "REMARKS (WAREHOUSE)", "NOTE", "REMARK");

    const normCust = customer.toUpperCase().replace(/\s+/g, " ").trim();
    const normDate = normalizeShipDate(shipDate);
    const groupKey = normCust ? (normCust + "___" + normDate) : ("UNKNOWN___" + idx);

    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ invoice, customer, shipDate, pallets, carrier, pro, note, sourceRow: row.__sourceRow });
  });

  console.log(`[INFO] Grouped ${truckingRows.length} Trucking rows into ${groups.size} distinct customer + ship date shipments.`);

  // Fetch target WH Trucking Request tab from Logistics Master 2026
  let targetRows = [];
  try {
    const table = await fetchGvizTable(TARGET_SHEET_ID, "WH Trucking Request", "A2:U", "1");
    const headers = table.cols.map((c, i) => (c.label || `COL_${i}`).toUpperCase().replace(/\s+/g, " ").trim());
    targetRows = table.rows.map((r, rowIndex) => ({
      __sourceRow: rowIndex + 3,
      ...Object.fromEntries(headers.map((h, i) => {
        const c = r.c?.[i];
        return [h, String(c ? (c.f ?? c.v ?? "") : "").trim()];
      }))
    }));
  } catch (err) {
    console.error(`[ERROR] Failed to fetch target tab 'WH Trucking Request':`, err.message);
    return { ok: false, error: err.message };
  }

  // Index existing target rows by exact normalized Customer + Ship Date.
  const existingMap = new Map();
  const existingInvoiceMap = new Map();
  targetRows.forEach((row) => {
    const invoices = getColValue(row, "INVOICE NO.", "INVOICE #", "INVOICE").split(/[\r\n,;·]+/);
    const cust = getColValue(row, "CUSTOMER").toUpperCase().replace(/\s+/g, " ").trim();
    const date = normalizeShipDate(getColValue(row, "SHIP DATE"));
    if (cust && date) existingMap.set(cust + "___" + date, row);
    invoices.forEach(invoice => {
      const key = invoice.trim().toUpperCase();
      if (!key) return;
      if (!existingInvoiceMap.has(key)) existingInvoiceMap.set(key, new Set());
      existingInvoiceMap.get(key).add(row);
    });
  });

  const newEntries = [];
  const modifiedEntries = [];
  const skippedRescheduled = [];

  groups.forEach((items, groupKey) => {
    const customer = items[0].customer;
    const shipDate = items[0].shipDate;
    const combinedInvoices = [...new Set(items.map(i => i.invoice).filter(Boolean))].join("\n");
    const combinedCarrier = items.map(i => i.carrier).find(Boolean) || "Trucking";
    const combinedPro = [...new Set(items.map(i => i.pro).filter(Boolean))].join("\n");
    const combinedPallets = [...new Set(items.map(i => i.pallets).filter(Boolean))].join(" · ");
    const combinedNote = [...new Set(items.map(i => i.note).filter(Boolean))].join(" · ") || "Imported from WMS Invoice & Issues";

    const normCust = customer.toUpperCase().replace(/\s+/g, " ").trim();
    const normDate = normalizeShipDate(shipDate);
    const matchKey = normCust + "___" + normDate;

    let matchedRow = existingMap.get(matchKey);
    if (!matchedRow) {
      const invoiceMatches = new Set();
      items.forEach(item => {
        const rows = existingInvoiceMap.get(String(item.invoice || "").trim().toUpperCase());
        if (rows) rows.forEach(row => invoiceMatches.add(row));
      });
      if (invoiceMatches.size === 1) {
        const candidate = [...invoiceMatches][0];
        if (normalizeShipDate(getColValue(candidate, "SHIP DATE")) === normDate) {
          matchedRow = candidate;
        } else {
          skippedRescheduled.push({ customer, shipDate, invoice: combinedInvoices, existingRow: candidate.__sourceRow });
          return;
        }
      } else if (invoiceMatches.size > 1) {
        skippedRescheduled.push({ customer, shipDate, invoice: combinedInvoices, existingRow: "ambiguous" });
        return;
      }
    }

    const entry = {
      customer,
      shipDate,
      invoice: combinedInvoices,
      pallets: combinedPallets,
      carrier: combinedCarrier,
      pro: combinedPro,
      note: combinedNote,
      status: "WORK IN PROGRESS"
    };

    if (matchedRow) {
      const curInvs = getColValue(matchedRow, "INVOICE NO.", "INVOICE #", "INVOICE");
      const mergedInvoices = [...new Set(
        [curInvs, combinedInvoices]
          .join("\n")
          .split(/[\r\n,;·]+/)
          .map(invoice => invoice.trim())
          .filter(Boolean)
      )].join("\n");
      if (curInvs !== mergedInvoices) {
        modifiedEntries.push({ ...entry, invoice: mergedInvoices, existingRow: matchedRow.__sourceRow });
      }
    } else {
      newEntries.push(entry);
    }
  });

  console.log(`\n[RESULT] Scan complete: ${newEntries.length} new entries to append, ${modifiedEntries.length} entries to update, ${skippedRescheduled.length} rescheduled/ambiguous entries skipped.`);
  if (newEntries.length > 0) {
    console.log(`\n[NEW COMBINED ENTRIES (${newEntries.length})]:`);
    newEntries.forEach((e, idx) => console.log(`  ${idx+1}. ${e.customer} (${e.shipDate}) -> Invoices: ${e.invoice.replace(/\n/g, ", ")}`));
  }
  if (modifiedEntries.length > 0) {
    console.log(`\n[MODIFIED COMBINED ENTRIES (${modifiedEntries.length})]:`);
    modifiedEntries.forEach((e, idx) => console.log(`  ${idx+1}. Row ${e.existingRow}: ${e.customer} (${e.shipDate}) -> Invoices: ${e.invoice.replace(/\n/g, ", ")}`));
  }

  return {
    ok: true,
    scanned: wmsRows.length,
    truckingCount: truckingRows.length,
    groups: groups.size,
    newCount: newEntries.length,
    modifiedCount: modifiedEntries.length,
    skippedRescheduledCount: skippedRescheduled.length,
    newEntries,
    modifiedEntries,
    skippedRescheduled
  };
}

// Support CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const loop = args.includes("--loop");

  runScan({ dryRun }).then(res => {
    if (loop) {
      console.log("Entering 30-minute recurring loop...");
      setInterval(() => runScan({ dryRun }), 30 * 60 * 1000);
    }
  });
}

module.exports = { runScan };
