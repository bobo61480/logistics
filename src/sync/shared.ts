/**
 * src/sync/shared.ts
 * Parsing utilities shared by all sync modules.
 * These are Worker-runtime ports of the equivalent logic in
 * lib/sales-kpis.ts and app/page.tsx (no DOM / React dependencies).
 */

// ── Sheet IDs ──────────────────────────────────────────────────────────────
export const MASTER_ID  = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
export const WMS_ID     = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";
export const NATIONAL_ID= "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";
export const FULFILLMENT_API =
  "https://script.google.com/macros/s/AKfycbykK9DWjem9ORHxfR_mpdZl5DVh-en0D6JpCdIuel305QmfqxoNU_NqSnjkhFk401hI/exec";

// ── String helpers ─────────────────────────────────────────────────────────
export function clean(v: unknown): string {
  return String(v ?? "").trim();
}

export function cell(row: unknown, i: number): string {
  if (Array.isArray(row)) return clean(row[i]);
  const v = (row as any)?.c?.[i];
  return clean(v?.f ?? v?.v ?? "");
}

// ── CSV parser (matches lib/sales-kpis.ts) ────────────────────────────────
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let val = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { val += '"'; i++; }
      else if (ch === '"') quoted = false;
      else val += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(val); val = "";
    } else if (ch === "\n") {
      row.push(val.replace(/\r$/, ""));
      rows.push(row);
      row = []; val = "";
    } else {
      val += ch;
    }
  }
  if (val || row.length) { row.push(val.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

// ── Network helpers ────────────────────────────────────────────────────────
export async function fetchCsvExport(spreadsheetId: string, gid: number): Promise<string[][]> {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
  url.searchParams.set("format", "csv");
  url.searchParams.set("gid", String(gid));
  url.searchParams.set("_", String(Date.now()));
  const res = await fetch(url.toString(), { cf: { cacheTtl: 0 } } as RequestInit);
  if (!res.ok) throw new Error(`CSV export ${gid} failed (${res.status})`);
  return parseCsv(await res.text());
}

export async function fetchGvizCsv(
  spreadsheetId: string,
  opts: { gid?: number; sheet?: string; range: string },
): Promise<string[][]> {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:csv");
  if (opts.gid !== undefined) url.searchParams.set("gid", String(opts.gid));
  if (opts.sheet) url.searchParams.set("sheet", opts.sheet);
  url.searchParams.set("range", opts.range);
  url.searchParams.set("_", String(Date.now()));
  const res = await fetch(url.toString(), { cf: { cacheTtl: 0 } } as RequestInit);
  if (!res.ok) throw new Error(`gviz ${opts.gid ?? opts.sheet} failed (${res.status})`);
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error("Sheet not publicly accessible");
  return parseCsv(text);
}

// ── Date helpers ───────────────────────────────────────────────────────────
export type PacificDate = { year: number; month: number; day: number; code: number };

export function pacificToday(): PacificDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  return { year: v.year, month: v.month, day: v.day, code: v.year * 10_000 + v.month * 100 + v.day };
}

/** M/D/YYYY → YYYYMMDD; 0 if unparseable. */
export function dateCode(value: string): number {
  const m = clean(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return 0;
  let y = Number(m[3]); if (y < 100) y += 2000;
  return y * 10_000 + Number(m[1]) * 100 + Number(m[2]);
}

/** Handles M/D (year inferred) or M/D/YYYY. */
export function freightDateCode(value: string, today: PacificDate): number {
  const full = dateCode(value);
  if (full) return full;
  const m = clean(value).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return 0;
  const mo = Number(m[1]), d = Number(m[2]);
  const y = (mo < today.month || (mo === today.month && d <= today.day)) ? today.year : today.year + 1;
  return y * 10_000 + mo * 100 + d;
}

/** YYYYMMDD → "YYYY-MM-DD" */
export function codeToIso(code: number): string {
  const y = Math.floor(code / 10_000);
  const m = Math.floor((code % 10_000) / 100);
  const d = code % 100;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** JS Date → "YYYY-MM-DD" (calendar date in LA timezone). */
export function dateToIso(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

// ── Money helpers ──────────────────────────────────────────────────────────
export function freightAmount(value: string): number {
  const text = clean(value).toUpperCase().replace(/\bUSD\b/g, "").trim();
  if (!text || /[A-Z]/.test(text) || !/^[\s$,\d().-]+$/.test(text)) return 0;
  const n = Number(text.replace(/[()$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 && n <= 250_000 ? n : 0;
}

export function parseAmount(value: string, allowSuffix = true): number {
  const text = clean(value).toUpperCase().replace(/[$,\s]/g, "");
  const re = allowSuffix ? /^(-?\d+(?:\.\d+)?)([KMB])?$/ : /^(-?\d+(?:\.\d+)?)$/;
  const m = text.match(re);
  if (!m) return 0;
  const mult = m[2] === "K" ? 1_000 : m[2] === "M" ? 1_000_000 : m[2] === "B" ? 1_000_000_000 : 1;
  const n = Number(m[1]) * mult;
  return Number.isFinite(n) ? n : 0;
}

// ── Freight classifiers (match lib/sales-kpis.ts exactly) ─────────────────
export function loadType(value: string): "LTL" | "FTL" {
  const t = clean(value);
  if (/\bFTL\b|FULL\s*TRUCK|TRUCKLOAD/i.test(t)) return "FTL";
  return Number(t.match(/\d+/)?.[0] ?? 0) >= 10 ? "FTL" : "LTL";
}

export function isNjDestination(dest: string): boolean {
  return /\b(?:NJ|NEW JERSEY)\b/i.test(dest.trim());
}

export function distanceBand(dest: string): "local" | "california" | "out-of-state" | "unknown" {
  const t = dest.trim().toUpperCase();
  if (!t) return "unknown";
  if (/\b(BUENA PARK|ANAHEIM|CERRITOS|LA MIRADA|FULLERTON|LA HABRA|BREA|ORANGE|SANTA ANA|IRVINE|COSTA MESA|HUNTINGTON BEACH|LONG BEACH|CARSON|TORRANCE|COMPTON|DOWNEY|NORWALK|WHITTIER|POMONA|ONTARIO|BLOOMINGTON|LOS ANGELES|GLENDALE|PASADENA)\b/.test(t)
    || /\b(90[0-8]\d{2}|91[0-2]\d{2}|917\d{2}|918\d{2}|92316|926\d{2}|927\d{2}|928\d{2})\b/.test(t)) return "local";
  if (/\bCA\b|CALIFORNIA/.test(t)) return "california";
  if (/\b(AL|AK|AZ|AR|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/.test(t)
    || /\b(NEW JERSEY|NEW YORK|WASHINGTON|TEXAS|ILLINOIS|FLORIDA|GEORGIA|PENNSYLVANIA|MASSACHUSETTS|ARIZONA|NEVADA|OREGON|COLORADO)\b/.test(t)) return "out-of-state";
  return "unknown";
}

// ── Status normalization (matches page.tsx) ────────────────────────────────
export function normalizeStatus(value: string): string {
  const s = clean(value).toLowerCase();
  if (!s) return "Scheduled";
  if (s === "wip") return "Work in Progress";
  if (["ready", "routed/booked", "picked up"].includes(s)) return "Scheduled";
  return s.replace(/\b\w/g, (l) => l.toUpperCase());
}

// ── Batch helpers ──────────────────────────────────────────────────────────
export function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

export async function batchUpsert(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (const ch of chunks(stmts, 100)) await db.batch(ch);
}

export async function markSynced(
  db: D1Database,
  source: string,
  count: number,
  error?: string,
): Promise<void> {
  await db.prepare(
    "UPDATE sync_log SET last_synced_at=?, row_count=?, error=? WHERE source=?"
  ).bind(Date.now(), error ? null : count, error ?? null, source).run();
}
