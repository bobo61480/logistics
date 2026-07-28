#!/usr/bin/env node

/**
 * Sync Runner Script: WMS Trucking Scanner & Importer
 * Scans WMS Invoice and Issues tab for rows with Shipping Method = "Trucking"
 * and synchronizes new or updated entries to the WH Trucking Request tab.
 */

const SHEET_ID = process.env.SHEET_ID || "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";

async function fetchGvizTable(tabName, range = "") {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`);
  url.searchParams.set("tqx", "out:json");
  url.searchParams.set("headers", "1");
  url.searchParams.set("sheet", tabName);
  if (range) url.searchParams.set("range", range);

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching sheet '${tabName}'`);
  const text = await res.text();
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error(`Invalid GViz payload for '${tabName}'`);
  const payload = JSON.parse(text.slice(a, b + 1));
  if (payload.status !== "ok") throw new Error(`GViz error on '${tabName}': ${payload.status}`);
  return payload.table;
}

function tableToObjects(table) {
  const headers = table.cols.map((c, i) =>
    (c.label || `COL_${i}`).toUpperCase().replace(/\s+/g, " ").trim()
  );
  return table.rows.map((r, rowIndex) => ({
    __sourceRow: rowIndex + 2,
    ...Object.fromEntries(headers.map((h, i) => {
      const c = r.c?.[i];
      return [h, String(c ? (c.f ?? c.v ?? "") : "").trim()];
    }))
  }));
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

async function runScan({ dryRun = false } = {}) {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}] Starting WMS Trucking scan... (dryRun=${dryRun})`);

  let wmsRows = [];
  let wmsTabName = "WMS Invoice and Issues";
  try {
    const table = await fetchGvizTable(wmsTabName);
    wmsRows = tableToObjects(table);
  } catch (err) {
    wmsTabName = "WMS Invoice & Issues";
    try {
      const table = await fetchGvizTable(wmsTabName);
      wmsRows = tableToObjects(table);
    } catch (err2) {
      console.warn(`[WARN] Neither 'WMS Invoice and Issues' nor 'WMS Invoice & Issues' tab found in sheet.`);
      return { ok: false, error: "WMS tab not reachable" };
    }
  }

  // Filter rows where Shipping Method is "Trucking"
  const truckingRows = wmsRows.filter(row => {
    const method = getColValue(row, "SHIPPING METHOD", "SHIP METHOD", "METHOD");
    return method.toUpperCase() === "TRUCKING";
  });

  console.log(`[INFO] Scanned ${wmsRows.length} total rows from '${wmsTabName}'. Found ${truckingRows.length} with Shipping Method = 'Trucking'.`);

  // Fetch target WH Trucking Request tab
  let targetRows = [];
  try {
    const table = await fetchGvizTable("WH Trucking Request", "A2:U");
    targetRows = tableToObjects(table);
  } catch (err) {
    console.error(`[ERROR] Failed to fetch target tab 'WH Trucking Request':`, err.message);
    return { ok: false, error: err.message };
  }

  // Index existing target rows by Invoice No / Customer
  const existingMap = new Map();
  targetRows.forEach((row, idx) => {
    const inv = getColValue(row, "INVOICE NO.", "INVOICE #", "INVOICE");
    const cust = getColValue(row, "CUSTOMER");
    const pro = getColValue(row, "PRO#", "PRO");
    const key = (inv || pro || (cust + "_" + idx)).toUpperCase();
    if (key) existingMap.set(key, row);
  });

  const newEntries = [];
  const modifiedEntries = [];

  truckingRows.forEach((row, idx) => {
    const invoice = getColValue(row, "INVOICE NO.", "INVOICE #", "INVOICE", "PO#");
    const customer = getColValue(row, "CUSTOMER", "CLIENT", "ACCOUNT");
    const shipDate = getColValue(row, "SHIP DATE", "DATE", "PU DATE");
    const pallets = getColValue(row, "PALLET", "PLT", "QTY", "CARTONS");
    const carrier = getColValue(row, "CARRIER", "TRUCKING") || "Trucking";
    const pro = getColValue(row, "PRO#", "PRO", "TRACKING#", "BOL");
    const note = getColValue(row, "NOTE", "REMARK", "MEMO", "ISSUE") || "Imported from WMS Invoice & Issues";

    const lookupKey = (invoice || pro || (customer + "_" + idx)).toUpperCase();

    const entry = {
      sourceRow: row.__sourceRow,
      customer,
      invoice,
      shipDate,
      pallets,
      carrier,
      pro,
      note,
      status: "WORK IN PROGRESS"
    };

    if (existingMap.has(lookupKey)) {
      const existing = existingMap.get(lookupKey);
      const existingStatus = getColValue(existing, "STATUS");
      if (!existingStatus) {
        modifiedEntries.push({ ...entry, existingRow: existing.__sourceRow });
      }
    } else {
      newEntries.push(entry);
    }
  });

  console.log(`[RESULT] Scan complete: ${newEntries.length} new entries, ${modifiedEntries.length} modified entries to import.`);
  if (newEntries.length > 0) {
    console.log(`[NEW ENTRIES]:`, newEntries);
  }
  if (modifiedEntries.length > 0) {
    console.log(`[MODIFIED ENTRIES]:`, modifiedEntries);
  }

  return {
    ok: true,
    scanned: wmsRows.length,
    truckingCount: truckingRows.length,
    newCount: newEntries.length,
    modifiedCount: modifiedEntries.length,
    newEntries,
    modifiedEntries
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
