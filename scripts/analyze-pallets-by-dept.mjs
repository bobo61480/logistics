#!/usr/bin/env node
/**
 * Pallets Shipped by Month × Department — 2026
 *
 * Sources (same IDs used throughout page.tsx / lib/sales-kpis.ts):
 *   1. WH Trucking Request  — LOGISTICS MASTER 2026, gid 852802817
 *      Department inferred from customer name + note column, fallback = Wholesale
 *
 *   2. NATIONAL ORDER PROGRESS — NATIONAL SHEET, gid 99300389 (GViz)
 *      Only rows where shippingMethod = "Trucking"; col 11
 *      Department from col 2 (department label) + col 1 (channel), fallback = Nationals
 *
 *   3. Stylekorean (WMS Sales) — SALES SHEET, gid 0 (GViz)
 *      Only rows where shippingMethod contains "truck(ing)"; col 5
 *      Department from customer(col2) + col3 + col11 + col12, fallback = B2B/E-Com
 *
 * Department logic mirrors outboundDepartment() in page.tsx exactly:
 *   MBX     → /\bMBX\b/
 *   NJ      → /\bNJ\b|\bNEW JERSEY\b/
 *   Nationals → /NATIONALS?|ULTA|ROSS|TJX|MARSHALLS|BURLINGTON|IHERB|SEPHORA|OLIVE YOUNG/
 *   B2B/E-Com → /B2B|E-?COM|STYLEKOREAN|WMS/
 *   Wholesale  → /WHOLESALE/ (or sheet fallback)
 *
 * 53ft rule: 1 × 53 trailer = 26 pallets
 */

const LOGISTICS_SHEET_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const NATIONAL_SHEET_ID  = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";
const SALES_SHEET_ID     = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DEPTS = ["Wholesale","B2B/E-Com","Nationals","MBX","NJ"];

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchCsv(sheetId, gid) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/export`);
  url.searchParams.set("format","csv"); url.searchParams.set("gid",String(gid));
  url.searchParams.set("_",String(Date.now()));
  const res = await fetch(url,{cache:"no-store"});
  if(!res.ok) throw new Error(`HTTP ${res.status} csv gid=${gid}`);
  return parseCsv(await res.text());
}

async function fetchGviz(sheetId, gid, range="", headers="1") {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`);
  url.searchParams.set("tqx","out:json"); url.searchParams.set("headers",headers);
  url.searchParams.set("gid",String(gid));
  if(range) url.searchParams.set("range",range);
  url.searchParams.set("_",String(Date.now()));
  const res = await fetch(url,{cache:"no-store"});
  if(!res.ok) throw new Error(`HTTP ${res.status} gviz gid=${gid}`);
  const text = await res.text();
  const s=text.indexOf("{"), e=text.lastIndexOf("}");
  const p=JSON.parse(text.slice(s,e+1));
  if(p.status!=="ok") throw new Error(`GViz error: ${p.status}`);
  return p.table;
}

function parseCsv(text) {
  const rows=[]; let row=[],value="",quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){ if(ch==='"'&&text[i+1]==='"'){value+='"';i++;}else if(ch==='"')quoted=false;else value+=ch; }
    else if(ch==='"')quoted=true;
    else if(ch===','){row.push(value);value="";}
    else if(ch==='\n'){row.push(value.replace(/\r$/,""));rows.push(row);row=[];value="";}
    else value+=ch;
  }
  if(value||row.length){row.push(value.replace(/\r$/,""));rows.push(row);}
  return rows;
}

function gvizCell(row, col) {
  const c = row?.c?.[col]; return String(c?(c.f??c.v??""):"").trim();
}

// ─── Classification helpers (mirrors page.tsx exactly) ───────────────────────

function outboundDepartment(values, fallback) {
  const text = values.map(v=>String(v||"").trim()).filter(Boolean).join(" ").toUpperCase();
  if(/\bMBX\b/.test(text)) return "MBX";
  if(/\bNJ\b|\bNEW JERSEY\b/.test(text)) return "NJ";
  if(/\bNATIONALS?\b|\bULTA\b|\bROSS\b|\bTJX\b|\bMARSHALLS\b|\bBURLINGTON\b|\bIHERB\b|\bSEPHORA\b|\bOLIVE YOUNG\b/.test(text)) return "Nationals";
  if(/\bB2B\b|\bE-?COM\b|\bSTYLEKOREAN\b|\bWMS\b/.test(text)) return "B2B/E-Com";
  if(/\bWHOLESALE\b/.test(text)) return "Wholesale";
  return fallback;
}

// ─── Pallet parsing ───────────────────────────────────────────────────────────

function parsePallets(raw) {
  const text = String(raw||"").trim().toUpperCase().replace(/[""]/g,"");
  if(!text) return null;
  // 53-foot trailer → 26 pallets each
  const trailerMatch = text.match(/(?:(\d+)\s*[xX×]\s*)?53\s*(?:['′]|FT|FOOT|FEET|TRAILER)/);
  if(trailerMatch){ const n=trailerMatch[1]?Number(trailerMatch[1]):1; return n*26; }
  // Explicit pallet keywords
  const pltMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:PALLETS?|PLTS?|SKIDS?)\b/i);
  if(pltMatch) return Math.round(Number(pltMatch[1]));
  // NxNxN dimension → 1 pallet
  if(/\d+\s*[xX×]\s*\d+\s*[xX×]\s*\d+/.test(text)) return 1;
  // NxN where both dims > 12 → 1 pallet
  const two=text.match(/^(\d+)\s*[xX×]\s*(\d+)$/);
  if(two&&Number(two[1])>12&&Number(two[2])>12) return 1;
  // Bare integer
  const bare=text.match(/^(\d+)$/);
  if(bare) return Number(bare[1]);
  return null;
}

function parseShipDate(value) {
  const m=String(value||"").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if(!m) return null;
  let y=Number(m[3]); if(y<100) y+=2000;
  return { year:y, month:Number(m[1]) };
}

// Accumulator: depts × months (0-indexed)
function makeMatrix() {
  return Object.fromEntries(DEPTS.map(d=>[d, new Array(12).fill(0)]));
}

// ─── Source 1: WH Trucking Request ───────────────────────────────────────────

async function analyzeWHTrucking(matrix, details) {
  const rows = await fetchCsv(LOGISTICS_SHEET_ID, 852802817);
  let headerIdx = 0;
  for(let i=0;i<Math.min(5,rows.length);i++){
    if(rows[i].join(" ").toUpperCase().includes("SHIP DATE")){headerIdx=i;break;}
  }
  const headers = rows[headerIdx].map(h=>String(h||"").trim().toUpperCase());
  const colOf = name => headers.findIndex(h=>h.includes(name));
  const colCustomer = 0;
  const colShipDate = colOf("SHIP DATE")!==-1?colOf("SHIP DATE"):colOf("DATE");
  const colPallets  = colOf("PALLET TYPE")!==-1?colOf("PALLET TYPE"):colOf("PALLET")!==-1?colOf("PALLET"):colOf("PLT");
  const colNote     = colOf("NOTE")!==-1?colOf("NOTE"):colOf("REMARK");
  const colStatus   = colOf("WEBSITE STATUS")!==-1?colOf("WEBSITE STATUS"):colOf("STATUS");

  // Find end of real data — rows where customer cell contains a plain date (MM/DD/YYYY) are
  // an internal scheduling grid appended at the bottom of the sheet and must be excluded.
  let dataEnd = rows.length;
  for(let i=headerIdx+1;i<rows.length;i++){
    if(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(rows[i][colCustomer]||"").trim())){
      dataEnd = i; break;
    }
  }

  let lastDate=null;
  let lastDept="Wholesale";
  let count=0;
  for(let i=headerIdx+1;i<dataEnd;i++){
    const row=rows[i];
    const customer = String(row[colCustomer]||"").trim();
    const rawDate  = colShipDate>=0?String(row[colShipDate]||"").trim():"";
    const rawPlt   = colPallets>=0?String(row[colPallets]||"").trim():"";
    const note     = colNote>=0?String(row[colNote]||"").trim():"";
    const status   = colStatus>=0?String(row[colStatus]||"").trim().toUpperCase():"";

    if(!customer&&!rawDate&&!rawPlt) continue;
    if(/^CANCEL/i.test(status)) continue;

    const parsed=parseShipDate(rawDate);
    if(parsed) lastDate=parsed; else if(!lastDate) continue;
    if(lastDate.year!==2026) continue;

    const pallets=parsePallets(rawPlt);
    const qty = pallets!==null ? pallets : (customer||rawPlt?1:0);
    if(qty<=0) continue;

    // Only update department when we have a real customer name on this row;
    // continuation sub-rows (blank customer) inherit the last known dept.
    if(customer) lastDept = outboundDepartment([note, customer], "Wholesale");
    const dept = lastDept;
    matrix[dept][lastDate.month-1] += qty;
    count++;
    details.push({ source:"WH Trucking", month:lastDate.month, customer, dept, qty, pltCell:rawPlt });
  }
  console.log(`  WH Trucking: ${count} rows processed`);
}

// ─── Source 2: NATIONAL ORDER PROGRESS ───────────────────────────────────────

async function analyzeNationals(matrix, details) {
  const table = await fetchGviz(NATIONAL_SHEET_ID, 99300389, "A1:U3500", "1");
  let count=0;
  for(const row of (table.rows||[])) {
    const pickupDate = gvizCell(row,9);
    const startShip  = gvizCell(row,7);
    const cancelDate = gvizCell(row,8);
    const dateText   = pickupDate||startShip||cancelDate;
    const parsed     = parseShipDate(dateText);
    if(!parsed||parsed.year!==2026) continue;

    const channel        = gvizCell(row,1);
    const shippingMethod = gvizCell(row,11);
    if(!channel||!/^trucking$/i.test(shippingMethod)) continue;

    const status = gvizCell(row,0);
    if(/^cancel/i.test(status)) continue;

    const departmentLabel = gvizCell(row,2);
    const dept = outboundDepartment([departmentLabel, channel], "Nationals");

    // Nationals sheet doesn't have a dedicated pallet count column; each row = 1 trucking move
    const qty = 1;
    matrix[dept][parsed.month-1] += qty;
    count++;
    details.push({ source:"Nationals", month:parsed.month, customer:channel, dept, qty, pltCell:"(1 move)" });
  }
  console.log(`  Nationals: ${count} rows processed`);
}

// ─── Source 3: Stylekorean / WMS Sales ───────────────────────────────────────

async function analyzeSales(matrix, details) {
  const table = await fetchGviz(SALES_SHEET_ID, 0, "A2:AF4200", "1");
  let count=0;
  for(const row of (table.rows||[])) {
    const shipDate = gvizCell(row,4);
    const parsed   = parseShipDate(shipDate);
    if(!parsed||parsed.year!==2026) continue;

    const customer       = gvizCell(row,2);
    const shippingMethod = gvizCell(row,5);
    const isTrucking     = /\btruck(?:ing)?\b/i.test(shippingMethod);
    if(!customer||!isTrucking) continue;

    const issue  = gvizCell(row,7);
    if(/^cancel/i.test(issue)) continue;

    const dept = outboundDepartment([customer, gvizCell(row,3), gvizCell(row,11), gvizCell(row,12)], "B2B/E-Com");

    const qty = 1; // WMS trucking rows don't carry pallet counts; each = 1 move
    matrix[dept][parsed.month-1] += qty;
    count++;
    details.push({ source:"Sales/WMS", month:parsed.month, customer, dept, qty, pltCell:"(1 move)" });
  }
  console.log(`  Sales/WMS: ${count} rows processed`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching all outbound sources…\n");
  const matrix  = makeMatrix();
  const details = [];

  await analyzeWHTrucking(matrix, details);
  await analyzeNationals(matrix, details);
  await analyzeSales(matrix, details);

  // ── Print table ──────────────────────────────────────────────────────────
  const colW = 12;
  const pad = (s,w=colW) => String(s).padStart(w);
  const padL = (s,w=14) => String(s).padEnd(w);

  console.log("\n╔══════════════════════════════════════════════════════════════════════════╗");
  console.log("║         OUTBOUND PALLETS SHIPPED BY MONTH × DEPARTMENT — 2026          ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════╣");
  console.log("║ " + padL("Department") + MONTHS.map(m=>pad(m)).join("") + pad("TOTAL") + " ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════╣");

  const grandTotal = new Array(12).fill(0);
  let overallTotal = 0;

  for(const dept of DEPTS) {
    const row = matrix[dept];
    const total = row.reduce((a,b)=>a+b,0);
    if(total===0) continue;
    overallTotal += total;
    row.forEach((v,i)=>{ grandTotal[i]+=v; });
    console.log("║ " + padL(dept) + row.map(v=>pad(v===0?"—":v)).join("") + pad(total) + " ║");
  }

  console.log("╠══════════════════════════════════════════════════════════════════════════╣");
  console.log("║ " + padL("TOTAL") + grandTotal.map(v=>pad(v===0?"—":v)).join("") + pad(overallTotal) + " ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════╝");

  // ── Top customers per dept ───────────────────────────────────────────────
  console.log("\n── Top customers by dept (WH Trucking source, pallets) ──");
  for(const dept of DEPTS) {
    const rows = details.filter(d=>d.source==="WH Trucking"&&d.dept===dept);
    if(!rows.length) continue;
    const cMap = new Map();
    rows.forEach(r=>cMap.set(r.customer,(cMap.get(r.customer)||0)+r.qty));
    const top = [...cMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5);
    console.log(`\n  [${dept}]`);
    top.forEach(([c,q])=>console.log(`    ${String(q).padStart(4)}  ${c}`));
  }

  // Output JSON for HTML builder
  const output = {
    generatedAt: new Date().toISOString(),
    rule53ft: "1×53 trailer = 26 pallets",
    matrix: Object.fromEntries(DEPTS.map(d=>[d, matrix[d]])),
    monthlyTotals: grandTotal,
    grandTotal: overallTotal,
    topCustomers: Object.fromEntries(
      DEPTS.map(dept=>{
        const rows=details.filter(d=>d.source==="WH Trucking"&&d.dept===dept);
        const cMap=new Map();
        rows.forEach(r=>cMap.set(r.customer,(cMap.get(r.customer)||0)+r.qty));
        return [dept, [...cMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8)
          .map(([name,pallets])=>({name,pallets}))];
      })
    ),
  };
  process.stdout.write("\n__JSON_RESULT__\n"+JSON.stringify(output,null,2)+"\n");
}

main().catch(err=>{console.error(err);process.exit(1);});
