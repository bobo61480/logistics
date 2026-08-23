#!/usr/bin/env node
const S = '1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc';
function parseCsv(text) {
  const rows = []; let row = [], v = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i+1] === '"') { v += '"'; i++; } else if (ch === '"') q = false; else v += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(v); v = ''; }
    else if (ch === '\n') { row.push(v.replace(/\r$/, '')); rows.push(row); row = []; v = ''; }
    else v += ch;
  }
  if (v || row.length) { row.push(v.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
async function go() {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${S}/export`);
  url.searchParams.set('format', 'csv'); url.searchParams.set('gid', '852802817'); url.searchParams.set('_', String(Date.now()));
  const r = await fetch(url); const rows = parseCsv(await r.text());
  let hIdx = 0;
  for (let i = 0; i < 5; i++) { if (rows[i].join(' ').toUpperCase().includes('SHIP DATE')) { hIdx = i; break; } }

  // Identify where the bottom-of-sheet noise grid starts
  // Noise rows have customer cell that is a date (MM/DD/YYYY) OR person name (single word, no invoice)
  let noiseStart = -1;
  for (let i = hIdx + 1; i < rows.length; i++) {
    const cust = String(rows[i][0] || '').trim();
    const inv  = String(rows[i][1] || '').trim();
    const date = String(rows[i][3] || '').trim();
    // Pattern: customer looks like "8/5/2026" or "8/6/2026"
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cust)) {
      noiseStart = i;
      break;
    }
  }
  console.log('Noise starts at row index:', noiseStart, '(1-based:', noiseStart + 1, ')');
  console.log('Total rows:', rows.length, '  Header at:', hIdx);

  // Show rows around the boundary
  for (let i = Math.max(hIdx, noiseStart - 3); i < Math.min(rows.length, noiseStart + 8); i++) {
    const cust = String(rows[i][0] || '').trim();
    const inv  = String(rows[i][1] || '').trim().substring(0, 20);
    const date = String(rows[i][3] || '').trim();
    const plt  = String(rows[i][4] || '').trim();
    console.log(`${String(i+1).padStart(4)} | ${cust.substring(0,28).padEnd(28)} | ${date.padEnd(12)} | ${plt.substring(0,20).padEnd(20)} | inv: ${inv}`);
  }
}
go().catch(console.error);
