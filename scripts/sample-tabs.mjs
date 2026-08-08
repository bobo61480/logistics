#!/usr/bin/env node
// Deep-sample all outbound tabs to understand date formats, pallet columns, status values
const LOGISTICS = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const NATIONAL  = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";

async function fetchGviz(id, tab, range = "A1:Z200") {
  const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tab)}&range=${range}&headers=1&_=${Date.now()}`;
  const res = await fetch(url);
  const text = await res.text();
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0) throw new Error('no json');
  const j = JSON.parse(text.slice(s, e+1));
  if (j.status !== 'ok') throw new Error(JSON.stringify(j.errors||j).slice(0,200));
  return j.table;
}

function cell(row, i) {
  const c = row?.c?.[i]; return String(c ? (c.f ?? c.v ?? '') : '').trim();
}

async function sample(id, tab, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label}`);
  console.log('='.repeat(60));
  try {
    const t = await fetchGviz(id, tab);
    const cols = (t.cols||[]).map(c => c.label||'');
    console.log('COLS:', cols.map((c,i)=>`[${i}]${c||'—'}`).join('  '));
    const rows = t.rows||[];
    console.log(`ROWS: ${rows.length}`);
    // Print first 25 non-empty rows
    let printed = 0;
    for (const row of rows) {
      const vals = (row.c||[]).map(c => String(c?(c.f??c.v??''):'').trim());
      if (vals.every(v=>!v)) continue;
      console.log('  ', vals.map((v,i)=>`[${i}]${v.slice(0,25)}`).filter((_,i)=>cols[i]||vals[i]).join('  '));
      if (++printed >= 25) break;
    }
  } catch(e) { console.log('ERROR:', e.message); }
}

(async () => {
  await sample(LOGISTICS, "ULTA",              "ULTA (LOGISTICS MASTER)");
  await sample(LOGISTICS, "IHERB",             "IHERB (LOGISTICS MASTER)");
  await sample(LOGISTICS, "B2B/E-COM TRUCKING","B2B/E-COM TRUCKING (LOGISTICS MASTER)");
  await sample(LOGISTICS, "TRANSFERS",         "TRANSFERS (LOGISTICS MASTER)");
  await sample(NATIONAL,  "TJX/ROSS",          "TJX/ROSS (NATIONAL) — same as Outbound Shipping Schedule");
  await sample(NATIONAL,  "TJX/ROSS DIMENSION","TJX/ROSS DIMENSION (NATIONAL)");
  await sample(NATIONAL,  "NATIONAL ORDER PROGRESS", "NATIONAL ORDER PROGRESS");
  await sample(NATIONAL,  "Outbound Shipping Schedule", "Outbound Shipping Schedule (NATIONAL)");
})();
