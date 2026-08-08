#!/usr/bin/env node
/**
 * Debug helper — prints every row that contributes pallets, especially 53ft entries.
 */

const TARGET_SHEET_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";

async function fetchCsv(sheetId, gid) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/export`);
  url.searchParams.set("format", "csv");
  url.searchParams.set("gid", String(gid));
  url.searchParams.set("_", String(Date.now()));
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

function parsePallets(raw) {
  const text = String(raw || "").trim().toUpperCase().replace(/[""]/g, "");
  if (!text) return null;

  // 1. 53-foot trailer
  const trailerMatch = text.match(/(?:(\d+)\s*[xX×]\s*)?53\s*(?:['′]|FT|FOOT|FEET|TRAILER)/);
  if (trailerMatch) {
    const count = trailerMatch[1] ? Number(trailerMatch[1]) : 1;
    return count * 26;
  }

  // 2. Explicit pallet keyword
  const pltMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:PALLETS?|PLTS?|SKIDS?)\b/);
  if (pltMatch) return Math.round(Number(pltMatch[1]));

  // 3. Dimensions (NxNxN)
  if (/\d+\s*[xX×]\s*\d+\s*[xX×]\s*\d+/.test(text)) return 1;

  // 4. Two-dim: NxN with large values → 1 pallet
  const twoDimMatch = text.match(/^(\d+)\s*[xX×]\s*(\d+)$/);
  if (twoDimMatch) {
    const a = Number(twoDimMatch[1]), b = Number(twoDimMatch[2]);
    if (a > 12 && b > 12) return 1;
  }

  // 5. Bare integer
  const bareMatch = text.match(/^(\d+)$/);
  if (bareMatch) return Number(bareMatch[1]);

  return null;
}

function parseShipDate(value) {
  const m = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  return { year, month: Number(m[1]) };
}

async function main() {
  const rows = await fetchCsv(TARGET_SHEET_ID, 852802817);
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].join(" ").toUpperCase().includes("SHIP DATE")) { headerIdx = i; break; }
  }
  const headers = rows[headerIdx].map(h => String(h || "").trim().toUpperCase());
  const col = name => headers.findIndex(h => h.includes(name));
  const colCustomer  = 0;
  const colShipDate  = col("SHIP DATE") !== -1 ? col("SHIP DATE") : col("DATE");
  const colPallets   = col("PALLET TYPE") !== -1 ? col("PALLET TYPE") : col("PALLET");
  const colStatus    = col("WEBSITE STATUS") !== -1 ? col("WEBSITE STATUS") : col("STATUS");

  let lastKnownDate = null;

  console.log("ROW | CUSTOMER                          | DATE       | PALLET_CELL         | COUNTED | STATUS");
  console.log("----+-----------------------------------+------------+---------------------+---------+--------");

  const monthSummary = new Array(12).fill(0);

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row       = rows[i];
    const customer  = String(row[colCustomer] || "").trim();
    const rawDate   = String(row[colShipDate] || "").trim();
    const rawPlt    = String(row[colPallets] || "").trim();
    const rawStatus = String(row[colStatus] || "").trim().toUpperCase();

    if (!customer && !rawDate && !rawPlt) continue;
    if (/^CANCEL/i.test(rawStatus)) continue;

    const parsed = parseShipDate(rawDate);
    if (parsed) lastKnownDate = parsed;
    else if (!lastKnownDate) continue;

    if (lastKnownDate.year !== 2026) continue;

    const pallets = parsePallets(rawPlt);
    const qty = pallets !== null ? pallets : (customer || rawPlt ? 1 : 0);
    if (qty <= 0) continue;

    monthSummary[lastKnownDate.month - 1] += qty;

    // Print only notable rows (53ft, multi-pallet, or just show all)
    console.log(
      `${String(i + 1).padStart(4)} | ${customer.substring(0,33).padEnd(33)} | ${rawDate.padEnd(10)} | ${rawPlt.substring(0,19).padEnd(19)} | ${String(qty).padStart(7)} | ${rawStatus.substring(0,20)}`
    );
  }

  console.log("\n─── Monthly Summary ───");
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  for (let m = 0; m < 12; m++) {
    if (monthSummary[m]) console.log(`  ${names[m]}: ${monthSummary[m]}`);
  }
  console.log(`  TOTAL: ${monthSummary.reduce((a,b)=>a+b,0)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
