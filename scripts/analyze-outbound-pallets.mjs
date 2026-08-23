#!/usr/bin/env node
/**
 * Analyze outbound pallets shipped by month in 2026.
 *
 * Data sources:
 *   1. "WH Trucking Request" tab  (LOGISTICS MASTER 2026, gid=852802817? No — see below)
 *      The sheet is fetched via the GViz public endpoint.
 *
 * Special rules:
 *   - "1x53", "1 x 53'", "53' trailer", "53ft", etc. → 26 pallets each
 *   - Numeric pallet counts (e.g. "3 PALLETS", "2 PLTS", "5 PLT") → face value
 *   - Dimension-only rows (e.g. "43x43x59") → 1 pallet
 *   - CANCELLED rows are excluded from the count
 *
 * Sheet IDs are the same constants used throughout the codebase.
 */

const TARGET_SHEET_ID = process.env.TARGET_SHEET_ID || "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ─── GViz helpers ─────────────────────────────────────────────────────────────

async function fetchGviz(sheetId, tabName, range = "", headers = "1") {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`);
  url.searchParams.set("tqx",     "out:json");
  url.searchParams.set("headers", headers);
  if (tabName) url.searchParams.set("sheet", tabName);
  if (range)   url.searchParams.set("range", range);
  url.searchParams.set("_", String(Date.now()));

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching '${tabName}'`);

  const text  = await res.text();
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`Invalid GViz payload for '${tabName}'`);

  const payload = JSON.parse(text.slice(start, end + 1));
  if (payload.status !== "ok") throw new Error(`GViz error for '${tabName}': ${payload.status}`);
  return payload.table;
}

// Also fetch via the CSV export (for sheets with complex merged headers)
async function fetchCsv(sheetId, gid) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/export`);
  url.searchParams.set("format", "csv");
  url.searchParams.set("gid", String(gid));
  url.searchParams.set("_", String(Date.now()));
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching CSV gid=${gid}`);
  return parseCsv(await res.text());
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(value); value = "";
    } else if (ch === '\n') {
      row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = "";
    } else {
      value += ch;
    }
  }
  if (value || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

// ─── Pallet parsing ───────────────────────────────────────────────────────────

/**
 * Parse a raw "PALLET TYPE" / "QTY" cell and return the numeric pallet count.
 *
 * Rules (applied in order):
 *  1. Any mention of a 53-foot trailer → 26 pallets per trailer.
 *     Patterns: "1x53", "1 x 53", "2x53", "53'", "53ft", "53 ft", "53-footer"
 *  2. Explicit pallet keywords: "N PALLETS", "N PLT", "N PLTS", "N PALLET"
 *  3. Bare integer / decimal with no dimensional context → treat as pallet count
 *  4. Dimension-like cell (e.g. "43x43x59", "40 x 48 x 52") → 1 pallet
 *  5. Empty / unparseable → 0 (will default to 1 at call site if row is valid)
 */
function parsePallets(raw) {
  const text = String(raw || "").trim().toUpperCase().replace(/[""]/g, "");
  if (!text) return null;

  // 1. 53-foot trailer  (e.g. "1x53", "2 x 53'", "1 X 53 FT", "53' TRAILER")
  //    Count the number before the "53"; default to 1 if no prefix number.
  const trailerMatch = text.match(/(?:(\d+)\s*[xX×]\s*)?53\s*(?:['′]|FT|FOOT|FEET|TRAILER)/);
  if (trailerMatch) {
    const count = trailerMatch[1] ? Number(trailerMatch[1]) : 1;
    return count * 26;
  }

  // 2. Explicit pallet keyword
  const pltMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:PALLETS?|PLTS?|SKIDS?)\b/);
  if (pltMatch) return Math.round(Number(pltMatch[1]));

  // 3. Dimensions (NxNxN or N x N x N) → 1 pallet
  if (/\d+\s*[xX×]\s*\d+\s*[xX×]\s*\d+/.test(text)) return 1;

  // 4. Two-way dimension (NxN) where values look like inches (> 12) → 1 pallet
  const twoDimMatch = text.match(/^(\d+)\s*[xX×]\s*(\d+)$/);
  if (twoDimMatch) {
    const a = Number(twoDimMatch[1]), b = Number(twoDimMatch[2]);
    if (a > 12 && b > 12) return 1; // Dimension pair, not a count
  }

  // 5. Bare integer
  const bareMatch = text.match(/^(\d+)$/);
  if (bareMatch) return Number(bareMatch[1]);

  return null; // Unrecognised format
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function parseShipDate(value) {
  const text = String(value || "").trim();
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  return { year, month: Number(m[1]) };   // month is 1-based
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching WH Trucking Request…");

  // The WH Trucking Request tab is gid 852802817 (used in lib/sales-kpis.ts for the
  // trucking KPI feed).  Try both GViz-by-name and CSV-by-gid to be resilient.
  let rows;
  try {
    rows = await fetchCsv(TARGET_SHEET_ID, 852802817);
    console.log(`CSV fetch succeeded: ${rows.length} raw rows`);
  } catch (e) {
    console.warn("CSV fetch failed:", e.message, "— falling back to GViz by tab name");
    const table = await fetchGviz(TARGET_SHEET_ID, "WH Trucking Request", "A1:U3500", "1");
    rows = [
      table.cols.map(c => c.label || ""),
      ...(table.rows || []).map(r =>
        (table.cols || []).map((_, i) => {
          const c = r.c?.[i];
          return c ? String(c.f ?? c.v ?? "").trim() : "";
        })
      ),
    ];
    console.log(`GViz fetch succeeded: ${rows.length} raw rows`);
  }

  if (rows.length < 2) {
    console.error("No data rows found.");
    process.exit(1);
  }

  // Locate the header row (first row containing "SHIP DATE" or "CUSTOMER")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const joined = rows[i].join(" ").toUpperCase();
    if (joined.includes("SHIP DATE") || joined.includes("CUSTOMER")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) headerIdx = 0; // Fallback

  const headers = rows[headerIdx].map(h => String(h || "").trim().toUpperCase());
  console.log("Headers found:", headers.filter(Boolean).join(" | "));

  // Map logical columns
  const col = name => headers.findIndex(h => h.includes(name));
  const colCustomer   = Math.max(col("CUSTOMER"), 0);
  const colShipDate   = col("SHIP DATE") !== -1 ? col("SHIP DATE") : col("DATE");
  const colPallets    = col("PALLET TYPE") !== -1 ? col("PALLET TYPE")
                      : col("PALLET") !== -1 ? col("PALLET")
                      : col("PLT") !== -1 ? col("PLT")
                      : col("QTY");
  const colStatus     = col("STATUS") !== -1 ? col("STATUS") : col("WEBSITE STATUS");

  console.log(`Column indices → customer:${colCustomer}, shipDate:${colShipDate}, pallets:${colPallets}, status:${colStatus}`);

  // ── Process data rows ───────────────────────────────────────────────────────
  const monthlyTotals = new Array(12).fill(0);
  const details = [];   // for verbose logging
  let skipped = 0, excluded = 0, counted = 0;
  let lastKnownDate = null;  // carry forward for continuation sub-rows

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row      = rows[i];
    const customer = String(row[colCustomer] || "").trim();
    const rawDate  = colShipDate >= 0 ? String(row[colShipDate] || "").trim() : "";
    const rawPlt   = colPallets  >= 0 ? String(row[colPallets]  || "").trim() : "";
    const rawStatus = colStatus  >= 0 ? String(row[colStatus]   || "").trim().toUpperCase() : "";

    // Skip completely empty rows
    if (!customer && !rawDate && !rawPlt) { skipped++; continue; }

    // Exclude cancelled rows
    if (/^CANCEL/i.test(rawStatus)) { excluded++; continue; }

    // Date resolution: use current cell's date or carry-forward from previous row
    const parsed = parseShipDate(rawDate);
    if (parsed) {
      lastKnownDate = parsed;
    } else if (!lastKnownDate) {
      skipped++;  // No date yet, can't attribute
      continue;
    }

    // Only 2026 rows
    if (lastKnownDate.year !== 2026) { skipped++; continue; }

    const monthIdx = lastKnownDate.month - 1; // 0-based

    // Pallet count
    const pallets = parsePallets(rawPlt);
    const qty = pallets !== null ? pallets : (customer || rawPlt ? 1 : 0);
    if (qty <= 0) { skipped++; continue; }

    monthlyTotals[monthIdx] += qty;
    counted++;
    details.push({ row: i + 1, customer, date: rawDate || "(carry-forward)", palletCell: rawPlt, counted: qty, status: rawStatus });
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const grandTotal = monthlyTotals.reduce((a, b) => a + b, 0);
  const maxPallets = Math.max(...monthlyTotals);

  console.log("\n═══════════════════════════════════════");
  console.log("  OUTBOUND PALLETS SHIPPED — 2026");
  console.log("═══════════════════════════════════════");

  let running = 0;
  for (let m = 0; m < 12; m++) {
    if (monthlyTotals[m] === 0) continue;
    running += monthlyTotals[m];
    const bar = "█".repeat(Math.round((monthlyTotals[m] / maxPallets) * 30));
    console.log(
      `  ${MONTH_NAMES[m].padEnd(10)} │ ${String(monthlyTotals[m]).padStart(4)} pallets  ${bar}`
    );
  }

  console.log("───────────────────────────────────────");
  console.log(`  TOTAL      │ ${String(grandTotal).padStart(4)} pallets`);
  console.log("═══════════════════════════════════════");
  console.log(`  Rows counted: ${counted}  Excluded (cancelled): ${excluded}  Skipped (no data): ${skipped}`);

  // Machine-readable JSON for the HTML generator
  const output = {
    generatedAt: new Date().toISOString(),
    rule53ft: "1x53 = 26 pallets",
    months: MONTH_NAMES.map((name, i) => ({
      month: name,
      year: 2026,
      pallets: monthlyTotals[i],
    })).filter(m => m.pallets > 0),
    grandTotal,
  };
  process.stdout.write("\n__JSON_RESULT__\n" + JSON.stringify(output, null, 2) + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
