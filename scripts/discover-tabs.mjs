#!/usr/bin/env node
// Discover all tab names + gids for both spreadsheets, then sample headers
const LOGISTICS = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const NATIONAL  = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";

async function fetchCsvRows(id, gid, maxRows = 5) {
  const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}&_=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) return [`HTTP ${res.status}`];
  const text = await res.text();
  return text.split('\n').slice(0, maxRows).map(r => r.replace(/\r$/, '').slice(0, 150));
}

async function getTabsViaHtml(id, label) {
  // Use the GViz endpoint with a dummy query — the error response reveals the sheet names
  const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json&tq=select%20*%20limit%200&_=${Date.now()}`;
  const res = await fetch(url);
  const text = await res.text();
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0) { console.log(label, "no JSON"); return; }
  try {
    const j = JSON.parse(text.slice(s, e+1));
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(j, null, 2).slice(0, 2000));
  } catch(err) { console.log(label, "parse error", err.message); }
}

// Try fetching the HTML to grab sheet gids from the tab list
async function getTabsFromHtml(id, label) {
  const url = `https://docs.google.com/spreadsheets/d/${id}/edit`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();
  // Extract gid and sheet name from the HTML
  const matches = [...text.matchAll(/"gid":(\d+).*?"name":"([^"]+)"/g)];
  const seen = new Set();
  console.log(`\n=== ${label} (${id}) ===`);
  if (matches.length) {
    matches.forEach(m => {
      const key = m[1]+m[2];
      if (!seen.has(key)) { seen.add(key); console.log(`  gid=${m[1]}  name="${m[2]}"`); }
    });
  } else {
    // Try alternate pattern
    const alt = [...text.matchAll(/tid="(\d+)"[^>]*>([^<]{2,40})</g)];
    alt.slice(0,30).forEach(m => console.log(`  tid=${m[1]}  label="${m[2].trim()}"`));
    if (!alt.length) console.log("  (no tabs found in HTML — sheet may require login)");
  }
}

// Just fetch known gids by trying CSV exports
async function probeKnownGids(id, label) {
  // Known gids from URL fragments in the codebase + user's message
  const probes = [
    { gid: 0,         name: "Sheet1/first" },
    { gid: 852802817, name: "WH Trucking Request" },
    { gid: 1234,      name: "ULTA?" },
    { gid: 99300389,  name: "NATIONAL" },
  ];
  console.log(`\n=== ${label} tab probe ===`);
  for (const p of probes) {
    const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${p.gid}&_=${Date.now()}`;
    const res = await fetch(url);
    const first = (await res.text()).split('\n')[0].replace(/\r$/,'').slice(0,100);
    console.log(`  gid=${p.gid} (${p.name}): ${res.status} → ${first.slice(0,80)}`);
  }
}

(async () => {
  // Fetch header rows of ALL sheets we need by tab name via GViz
  const sheets = [
    { id: LOGISTICS, tab: "WH Trucking Request" },
    { id: LOGISTICS, tab: "ULTA" },
    { id: LOGISTICS, tab: "IHERB" },
    { id: LOGISTICS, tab: "B2B/E-COM TRUCKING" },
    { id: LOGISTICS, tab: "TRANSFERS" },
    { id: NATIONAL,  tab: "TJX/ROSS DIMENSION" },
    { id: NATIONAL,  tab: "NATIONAL ORDER PROGRESS" },
    { id: NATIONAL,  tab: "Outbound Shipping Schedule" },
    { id: NATIONAL,  tab: "TJX/ROSS" },
  ];

  for (const s of sheets) {
    const url = `https://docs.google.com/spreadsheets/d/${s.id}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(s.tab)}&range=A1:Z5&headers=1&_=${Date.now()}`;
    const res = await fetch(url);
    const text = await res.text();
    const si = text.indexOf('{'), ei = text.lastIndexOf('}');
    console.log(`\n--- ${s.tab} (${s.id === LOGISTICS ? 'LOGISTICS' : 'NATIONAL'}) ---`);
    if (si < 0) { console.log('  no response'); continue; }
    try {
      const j = JSON.parse(text.slice(si, ei+1));
      if (j.status !== 'ok') { console.log('  status:', j.status, JSON.stringify(j.errors||j).slice(0,200)); continue; }
      const cols = (j.table?.cols||[]).map(c => c.label||'').filter(Boolean);
      const r0   = (j.table?.rows?.[0]?.c||[]).map(c => String(c?.f ?? c?.v ?? '')).join(' | ');
      console.log('  cols:', cols.join(' | '));
      console.log('  row1:', r0.slice(0,150));
    } catch(e) { console.log('  parse error:', e.message); }
  }
})();
