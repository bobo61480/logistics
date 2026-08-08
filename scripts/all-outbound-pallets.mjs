#!/usr/bin/env node
/**
 * all-outbound-pallets.mjs
 *
 * Calculates total outbound pallet quantities by month (2026) across every
 * outbound shipment tab:
 *
 *  LOGISTICS MASTER 2026 (1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc):
 *    ① WH Trucking Request  — gid 852802817
 *       cols: CUSTOMER, SHIP DATE, PALLET TYPE, WEBSITE STATUS
 *       53ft rule: any "Nx53'" cell → N×26 pallets
 *
 *    ② ULTA                 — fetched by tab name
 *       cols: [0]DC/store, [8]ship date, [7]Total Cartons, [13]STATUS
 *       No pallet column; each row = 1 LTL shipment.
 *       Pallet count = ceil(Cartons / 20) — standard LTL pallet estimate,
 *       minimum 1 per row.
 *
 *    ③ IHERB                — fetched by tab name
 *       cols: [2]QTY (pallets), [6]PU date, [12]STATUS
 *
 *    ④ B2B/E-COM TRUCKING   — fetched by tab name
 *       cols: [4]PLT, [5]PU date, [17]STATUS
 *
 *    ⑤ TRANSFERS            — fetched by tab name
 *       cols: [1]PLT (e.g. "28 PLTS"), [5]PU date (MM/DD, year inferred),
 *             [13]STATUS
 *       Dates are MM/DD only — Jan–Jun → 2026, Jul–Dec ambiguous,
 *       we use the STATUS ("COMPLETED" in context) plus sequential ordering
 *       to decide year. Rows where PU ≥ 07/01 and status=COMPLETED are
 *       assumed 2025 (historical) unless the date sequence clearly continues
 *       into 2026.  We apply a simple heuristic: track the running year and
 *       flip to 2026 when month wraps backward (Dec→Jan).
 *
 *  NATIONAL SHEET (12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8):
 *    ⑥ TJX/ROSS (= Outbound Shipping Schedule)
 *       cols: [0]Account, [3]Ship Method, [4]# of Pallets, [7]SSD (MM/DD, 2026 inferred)
 *       Only "Trucking" rows. Filter: Account header rows excluded.
 *       No pallet → treat as 1 if trucking.
 *
 *    ⑦ NATIONAL ORDER PROGRESS
 *       cols: [0]Status, [1]Channel, [7]SSD / [9]Pick up Date (M/D/YYYY), [11]Ship Via
 *       Only trucking rows. No pallet column → each row = 1 move.
 *
 *    ⑧ TJX/ROSS DIMENSION   — col[10]=PLT, col[12]=SSD, col[17]=STATUS
 *       (Only used if non-empty; currently sparse)
 *
 * Exclusion rules applied uniformly:
 *   - Status matches /^cancel/i → skip
 *   - Rows with no date and no pallet data → skip
 *   - Template / header repetition rows → skip
 */

const LOGISTICS = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const NATIONAL  = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";

const MONTH_NAMES = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"];
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun",
                     "Jul","Aug","Sep","Oct","Nov","Dec"];

// ─── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchGviz(sheetId, tab, range = "A1:Z2000") {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json` +
    `&sheet=${encodeURIComponent(tab)}&range=${range}&headers=1&_=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching tab "${tab}"`);
  const text = await res.text();
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0) throw new Error(`No JSON in response for tab "${tab}"`);
  const j = JSON.parse(text.slice(s, e + 1));
  if (j.status !== "ok") throw new Error(`GViz error on "${tab}": ${JSON.stringify(j.errors||j).slice(0,200)}`);
  return j.table;
}

async function fetchCsv(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}&_=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching CSV gid=${gid}`);
  return parseCsv(await res.text());
}

function parseCsv(text) {
  const rows = []; let row = [], val = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i+1] === '"') { val += '"'; i++; } else if (ch === '"') q = false; else val += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(val); val = ""; }
    else if (ch === '\n') { row.push(val.replace(/\r$/, "")); rows.push(row); row = []; val = ""; }
    else val += ch;
  }
  if (val || row.length) { row.push(val.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function c(row, i) {
  const cell = row?.c?.[i];
  return String(cell ? (cell.f ?? cell.v ?? "") : "").trim();
}

// ─── Pallet parsing ───────────────────────────────────────────────────────────

function parsePallets(raw) {
  const text = String(raw || "").trim().toUpperCase().replace(/[""]/g, "");
  if (!text) return null;
  // 53-foot trailer (e.g. "1x53'", "2 x 53 FT", "53' TRAILER")
  const t53 = text.match(/(?:(\d+)\s*[xX×]\s*)?53\s*(?:['′]|FT\b|FOOT|FEET|TRAILER)/);
  if (t53) return (t53[1] ? Number(t53[1]) : 1) * 26;
  // Explicit pallet keywords  "28 PLTS", "3 PALLETS", "1 PLT"
  const plt = text.match(/(\d+(?:\.\d+)?)\s*(?:PALLETS?|PLTS?|SKIDS?)\b/);
  if (plt) return Math.round(Number(plt[1]));
  // NxNxN dimension → 1 pallet
  if (/\d+\s*[xX×]\s*\d+\s*[xX×]\s*\d+/.test(text)) return 1;
  // NxN where both > 12 (inch dims) → 1 pallet
  const two = text.match(/^(\d+)\s*[xX×]\s*(\d+)$/);
  if (two && Number(two[1]) > 12 && Number(two[2]) > 12) return 1;
  // Bare integer
  const bare = text.match(/^(\d+)$/);
  if (bare) return Number(bare[1]);
  return null;
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

/** Full date: M/D/YY, M/D/YYYY, MM/DD/YY, MM/DD/YYYY → { year, month } */
function parseFullDate(val) {
  const m = String(val || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]); if (y < 100) y += 2000;
  return { year: y, month: Number(m[1]) };
}

/** Short date: M/D or MM/DD — returns { month, day } only */
function parseShortDate(val) {
  const m = String(val || "").trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return { month: Number(m[1]), day: Number(m[2]) };
}

/**
 * Resolve year for a short MM/DD date in the TRANSFERS / TJX sheet context.
 * We track a running "current year" and month, flipping the year when the month
 * sequence wraps backwards (i.e. the sheet runs chronologically).
 */
function makeYearTracker(startYear) {
  let year = startYear, lastMonth = 0;
  return function resolve(month) {
    if (month < lastMonth && lastMonth >= 11) year++; // month wrapped (Dec→Jan)
    lastMonth = month;
    return year;
  };
}

// ─── Accumulator ─────────────────────────────────────────────────────────────

// tabs × months matrix
const TABS = [
  "WH Trucking Request",
  "ULTA",
  "IHERB",
  "B2B/E-COM Trucking",
  "TRANSFERS",
  "TJX/ROSS",
  "Nationals",
  "TJX/ROSS Dimension",
];

function makeMatrix() {
  return Object.fromEntries(TABS.map(t => [t, new Array(12).fill(0)]));
}

// ─── Source processors ────────────────────────────────────────────────────────

/** ① WH Trucking Request — main trucking log */
async function processWHTrucking(matrix) {
  const rows = await fetchCsv(LOGISTICS, 852802817);
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].join(" ").toUpperCase().includes("SHIP DATE")) { headerIdx = i; break; }
  }
  const h = rows[headerIdx].map(v => String(v || "").trim().toUpperCase());
  const ci = name => h.findIndex(v => v.includes(name));
  const colCustomer = 0;
  const colDate   = ci("SHIP DATE") >= 0 ? ci("SHIP DATE") : ci("DATE");
  const colPlt    = ci("PALLET TYPE") >= 0 ? ci("PALLET TYPE") : ci("PALLET") >= 0 ? ci("PALLET") : ci("PLT");
  const colStatus = ci("WEBSITE STATUS") >= 0 ? ci("WEBSITE STATUS") : ci("STATUS");

  let lastDate = null, count = 0, skipped = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row      = rows[i];
    const customer = String(row[colCustomer] || "").trim();
    const rawDate  = colDate   >= 0 ? String(row[colDate]   || "").trim() : "";
    const rawPlt   = colPlt    >= 0 ? String(row[colPlt]    || "").trim() : "";
    const status   = colStatus >= 0 ? String(row[colStatus] || "").trim().toUpperCase() : "";

    // Stop at the internal scheduling grid (customer col becomes a bare date)
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(customer)) break;

    if (!customer && !rawDate && !rawPlt) { skipped++; continue; }
    if (/^cancel/i.test(status)) { skipped++; continue; }

    const parsed = parseFullDate(rawDate);
    if (parsed) lastDate = parsed;
    else if (!lastDate) { skipped++; continue; }
    if (lastDate.year !== 2026) { skipped++; continue; }

    const qty = parsePallets(rawPlt) ?? (customer || rawPlt ? 1 : 0);
    if (qty <= 0) { skipped++; continue; }

    matrix["WH Trucking Request"][lastDate.month - 1] += qty;
    count++;
  }
  console.log(`  ① WH Trucking Request: ${count} rows counted (${skipped} skipped)`);
}

/** ② ULTA — each row is one LTL shipment; pallet count = ceil(cartons/20), min 1 */
async function processULTA(matrix) {
  const table = await fetchGviz(LOGISTICS, "ULTA");
  // cols: [0]DC [1]Date [2]PO# [3]ShipTo [4]Trucking [5]Height [6]Weight [7]TotalCartons [8]ship date [13]STATUS
  let count = 0, skipped = 0;
  for (const row of (table.rows || [])) {
    const status   = c(row, 13).toUpperCase();
    const shipDate = c(row, 8) || c(row, 1);   // prefer "ship date" col, fallback to "Date"
    const cartons  = c(row, 7);
    const dc       = c(row, 0);

    if (!dc && !shipDate) { skipped++; continue; }
    if (/^cancel/i.test(status)) { skipped++; continue; }

    const parsed = parseFullDate(shipDate);
    if (!parsed || parsed.year !== 2026) { skipped++; continue; }

    // Pallet estimate: ceil(cartons/20), minimum 1 per LTL shipment
    const ctns = Number(cartons.replace(/[^0-9.]/g, "")) || 0;
    const qty  = ctns > 0 ? Math.max(1, Math.ceil(ctns / 20)) : 1;

    matrix["ULTA"][parsed.month - 1] += qty;
    count++;
  }
  console.log(`  ② ULTA: ${count} rows counted (${skipped} skipped)`);
}

/** ③ IHERB — col[2]=QTY (pallets), col[6]=PU date, col[12]=STATUS */
async function processIHERB(matrix) {
  const table = await fetchGviz(LOGISTICS, "IHERB");
  // cols: [0]PO# [1]BOL [2]QTY [3]FROM [4]TO [5]APPT# [6]PU [7]Delivery Appt [12]STATUS
  let count = 0, skipped = 0;
  for (const row of (table.rows || [])) {
    const status  = c(row, 12).toUpperCase();
    const puDate  = c(row, 6);
    const rawQty  = c(row, 2);

    if (!puDate && !rawQty) { skipped++; continue; }
    if (/^cancel/i.test(status)) { skipped++; continue; }

    const parsed = parseFullDate(puDate);
    if (!parsed || parsed.year !== 2026) { skipped++; continue; }

    // QTY column is pallet count directly
    const qty = parsePallets(rawQty) ?? (Number(rawQty.replace(/[^0-9]/g, "")) || 1);
    if (qty <= 0) { skipped++; continue; }

    matrix["IHERB"][parsed.month - 1] += qty;
    count++;
  }
  console.log(`  ③ IHERB: ${count} rows counted (${skipped} skipped)`);
}

/** ④ B2B/E-COM TRUCKING — col[4]=PLT, col[5]=PU date, col[17]=STATUS */
async function processB2BECOM(matrix) {
  // GViz returns 0 rows for this tab in A1:Z200; try a wider range
  const table = await fetchGviz(LOGISTICS, "B2B/E-COM TRUCKING", "A1:Z2000");
  // cols: [0]NOTE [1]NOTE [2]FROM [3]TO [4]PLT [5]PU [6]TRUCKING [7]PRO# [17]STATUS
  let count = 0, skipped = 0;
  for (const row of (table.rows || [])) {
    const status  = c(row, 17).toUpperCase();
    const puDate  = c(row, 5);
    const rawPlt  = c(row, 4);
    const note    = c(row, 0);

    if (!note && !puDate && !rawPlt) { skipped++; continue; }
    if (/^cancel/i.test(status)) { skipped++; continue; }

    const parsed = parseFullDate(puDate);
    if (!parsed || parsed.year !== 2026) { skipped++; continue; }

    const qty = parsePallets(rawPlt) ?? 1;
    if (qty <= 0) { skipped++; continue; }

    matrix["B2B/E-COM Trucking"][parsed.month - 1] += qty;
    count++;
  }
  console.log(`  ④ B2B/E-COM Trucking: ${count} rows counted (${skipped} skipped)`);
}

/**
 * ⑤ TRANSFERS — col[1]=PLT, col[5]=PU date (MM/DD only), col[13]=STATUS
 *
 * Year resolution:  The sheet is chronological.  It starts in late 2025 and
 * continues into 2026.  We start at year 2025 and flip to 2026 when month
 * sequence resets backward.  Rows with COMPLETED status in the Dec 2025 –
 * Jan 2026 boundary are handled correctly by the tracker.
 */
async function processTransfers(matrix) {
  const table = await fetchGviz(LOGISTICS, "TRANSFERS");
  // cols: [0]NOTE [1]PLT [2]VENDOR [3]FROM [4]TO [5]PU [6]TRUCKING [13]STATUS
  let count = 0, skipped = 0;
  const resolve = makeYearTracker(2025); // sheet starts in 2025

  for (const row of (table.rows || [])) {
    const status = c(row, 13).toUpperCase();
    const rawPlt = c(row, 1);
    const puRaw  = c(row, 5);
    const note   = c(row, 0);

    if (!note && !puRaw && !rawPlt) { skipped++; continue; }
    if (/^cancel/i.test(status)) { skipped++; continue; }

    // Try full date first; fall back to short MM/DD
    let year, month;
    const full = parseFullDate(puRaw);
    if (full) { year = full.year; month = full.month; }
    else {
      const short = parseShortDate(puRaw);
      if (!short) { skipped++; continue; }
      year  = resolve(short.month);
      month = short.month;
    }

    if (year !== 2026) { skipped++; continue; }

    const qty = parsePallets(rawPlt) ?? 1;
    if (qty <= 0) { skipped++; continue; }

    matrix["TRANSFERS"][month - 1] += qty;
    count++;
  }
  console.log(`  ⑤ TRANSFERS: ${count} rows counted (${skipped} skipped)`);
}

/**
 * ⑥ TJX/ROSS (Outbound Shipping Schedule) — NATIONAL sheet
 * cols: [0]Account [1]Order Name [2]#POs [3]Ship Method [4]#Pallets [5]#Cartons
 *       [6]Routing Date [7]SSD [8]Cancel Date [10]Work Progress
 *
 * Dates: MM/DD only (no year) → all treated as 2026 (sheet is current year).
 * Filter: Ship Method must include "Trucking" (case-insensitive).
 * Skip template rows where Account = "Account".
 * No pallet count → 1 trucking move.
 */
async function processTJXROSS(matrix) {
  const table = await fetchGviz(NATIONAL, "TJX/ROSS", "A1:K2000");
  // cols: [0]Account [1]Order Name [2]#POs [3]Ship Method [4]#Pallets [7]SSD [10]Work Progress
  let count = 0, skipped = 0;

  for (const row of (table.rows || [])) {
    const account    = c(row, 0);
    const shipMethod = c(row, 3);
    const rawPlt     = c(row, 4);
    const ssd        = c(row, 7);
    const routing    = c(row, 6);
    const progress   = c(row, 10);

    // Skip template / header repetition rows
    if (!account || account === "Account" || account === "Account ") { skipped++; continue; }
    if (/^Routing Date$/i.test(routing) || /^Start Ship Date$/i.test(ssd)) { skipped++; continue; }
    if (/^cancel/i.test(progress)) { skipped++; continue; }

    // Only trucking moves
    if (!shipMethod || !/trucking/i.test(shipMethod)) { skipped++; continue; }

    // Use SSD (Start Ship Date) as the date; fall back to Routing Date
    const dateStr = ssd || routing;
    if (!dateStr || dateStr === "미정" || dateStr === "Routing Date" || dateStr === "Start Ship Date") {
      skipped++; continue;
    }

    // Try full date, then short date (MM/DD → 2026)
    let month;
    const full = parseFullDate(dateStr);
    if (full && full.year === 2026) month = full.month;
    else {
      const short = parseShortDate(dateStr);
      if (!short) { skipped++; continue; }
      month = short.month; // assume 2026
    }

    const qty = parsePallets(rawPlt) ?? 1;
    // if qty resolved to 0 (empty cell but trucking), default to 1 move
    const finalQty = qty > 0 ? qty : 1;

    matrix["TJX/ROSS"][month - 1] += finalQty;
    count++;
  }
  console.log(`  ⑥ TJX/ROSS (Outbound Shipping Schedule): ${count} rows counted (${skipped} skipped)`);
}

/**
 * ⑦ NATIONAL ORDER PROGRESS — no pallet col, each trucking row = 1 move
 * cols: [0]Status [1]Channel [2]Dept [7]SSD [9]Pick up Date [11]Ship Via
 *
 * Date priority: Pick up Date [9] (M/D/YYYY) → SSD [7] (M/D/YYYY) → CXL Date [8]
 * Ship Via must be "TRUCKING" (case-insensitive).
 */
async function processNationals(matrix) {
  const table = await fetchGviz(NATIONAL, "NATIONAL ORDER PROGRESS", "A1:U2000");
  let count = 0, skipped = 0;

  for (const row of (table.rows || [])) {
    const status   = c(row, 0).toUpperCase();
    const shipVia  = c(row, 11).toUpperCase();
    const dateRaw  = c(row, 9) || c(row, 7) || c(row, 8);

    if (!c(row, 1) && !dateRaw) { skipped++; continue; }
    if (/^cancel/i.test(status)) { skipped++; continue; }
    if (!shipVia || !shipVia.includes("TRUCKING")) { skipped++; continue; }

    const parsed = parseFullDate(dateRaw);
    if (!parsed || parsed.year !== 2026) { skipped++; continue; }

    // No pallet column — each row = 1 trucking move
    matrix["Nationals"][parsed.month - 1] += 1;
    count++;
  }
  console.log(`  ⑦ NATIONAL ORDER PROGRESS: ${count} rows counted (${skipped} skipped)`);
}

/**
 * ⑧ TJX/ROSS DIMENSION — col[10]=PLT, col[12]=SSD, col[17]=STATUS
 * (Currently sparse but included for completeness)
 */
async function processTJXDimension(matrix) {
  const table = await fetchGviz(NATIONAL, "TJX/ROSS DIMENSION", "A1:R2000");
  // cols: [0]Order Received [4]Shipment# [7]Planned Qty [8]Box [9]Weight [10]PLT
  //       [11]CU [12]SSD [13]Cancel Date [14]Shipout Date [17]STATUS
  let count = 0, skipped = 0;

  for (const row of (table.rows || [])) {
    const status  = c(row, 17).toUpperCase();
    const rawPlt  = c(row, 10);
    const ssd     = c(row, 12);
    const shipOut = c(row, 14);
    const orderRec= c(row, 0);

    if (!orderRec && !rawPlt && !ssd) { skipped++; continue; }
    if (/^cancel/i.test(status)) { skipped++; continue; }

    const dateStr = ssd || shipOut;
    if (!dateStr) { skipped++; continue; }

    let month;
    const full = parseFullDate(dateStr);
    if (full && full.year === 2026) month = full.month;
    else {
      const short = parseShortDate(dateStr);
      if (!short) { skipped++; continue; }
      month = short.month;
    }

    const qty = parsePallets(rawPlt) ?? 1;
    if (qty <= 0) { skipped++; continue; }

    matrix["TJX/ROSS Dimension"][month - 1] += qty;
    count++;
  }
  console.log(`  ⑧ TJX/ROSS DIMENSION: ${count} rows counted (${skipped} skipped)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   ALL OUTBOUND PALLETS — FULL CALCULATION — 2026    ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");
  console.log("Fetching all outbound tabs…\n");

  const matrix = makeMatrix();

  await processWHTrucking(matrix);
  await processULTA(matrix);
  await processIHERB(matrix);
  await processB2BECOM(matrix);
  await processTransfers(matrix);
  await processTJXROSS(matrix);
  await processNationals(matrix);
  await processTJXDimension(matrix);

  // ── Monthly totals ───────────────────────────────────────────────────────
  const monthlyTotals = new Array(12).fill(0);
  for (const tab of TABS) {
    matrix[tab].forEach((v, i) => { monthlyTotals[i] += v; });
  }
  const grandTotal = monthlyTotals.reduce((a, b) => a + b, 0);

  // ── Print summary table ──────────────────────────────────────────────────
  const W = 9; // column width
  const padR = (s, w) => String(s).padStart(w);
  const padL = (s, w) => String(s).padEnd(w);

  console.log("\n");

  // Header row
  const tabCol = 24;
  const header = padL("TAB / SOURCE", tabCol) + MONTH_SHORT.map(m => padR(m, W)).join("") + padR("TOTAL", W);
  console.log("─".repeat(header.length));
  console.log(header);
  console.log("─".repeat(header.length));

  for (const tab of TABS) {
    const row = matrix[tab];
    const total = row.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    console.log(
      padL(tab, tabCol) +
      row.map(v => padR(v === 0 ? "—" : v, W)).join("") +
      padR(total, W)
    );
  }

  console.log("─".repeat(header.length));
  console.log(
    padL("GRAND TOTAL", tabCol) +
    monthlyTotals.map(v => padR(v === 0 ? "—" : v, W)).join("") +
    padR(grandTotal, W)
  );
  console.log("─".repeat(header.length));

  // ── Monthly breakdown ────────────────────────────────────────────────────
  const maxV = Math.max(...monthlyTotals, 1);
  console.log("\n  MONTHLY TOTALS (all tabs combined):\n");
  for (let m = 0; m < 12; m++) {
    if (monthlyTotals[m] === 0) continue;
    const bar = "█".repeat(Math.round((monthlyTotals[m] / maxV) * 32));
    console.log(
      `  ${MONTH_NAMES[m].padEnd(12)} │ ${String(monthlyTotals[m]).padStart(5)}  ${bar}`
    );
  }
  console.log(`\n  GRAND TOTAL: ${grandTotal} pallets (2026)`);

  // ── JSON output for HTML generator ──────────────────────────────────────
  const result = {
    generatedAt: new Date().toISOString(),
    year: 2026,
    notes: {
      "WH Trucking Request": "53ft trailer = 26 pallets; bare pallet counts face value",
      "ULTA": "each row = 1 LTL shipment; pallets = ceil(cartons/20), min 1",
      "IHERB": "QTY column = pallet count directly",
      "B2B/E-COM Trucking": "PLT column = pallet count",
      "TRANSFERS": "PLT column (e.g. '28 PLTS'); short dates resolved by sequence",
      "TJX/ROSS": "# of Pallets column; trucking rows only",
      "Nationals": "no pallet column — each trucking row counted as 1 move",
      "TJX/ROSS Dimension": "PLT column; currently sparse",
    },
    tabs: Object.fromEntries(
      TABS.map(t => [t, { monthly: matrix[t], total: matrix[t].reduce((a,b)=>a+b,0) }])
    ),
    monthlyTotals,
    grandTotal,
    monthLabels: MONTH_NAMES,
  };

  process.stdout.write("\n__JSON_RESULT__\n" + JSON.stringify(result, null, 2) + "\n");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
