// Shared KPI parsing primitives: CSV reading, date/amount coercion, freight
// classification, and the Pacific-time helpers the KPI math is defined in.
//
// This module holds parsing only. KPI totals are computed server-side in
// lib/kpis/compute.ts and published through D1 — the browser must never read
// Google Sheets directly.

export function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

export function dateCode(value: string) {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return 0;
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  return year * 10_000 + Number(match[1]) * 100 + Number(match[2]);
}

export function freightDateCode(value: string, today: ReturnType<typeof pacificDateParts>) {
  const full = dateCode(value);
  if (full) return full;
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return 0;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const hasOccurredThisYear = month < today.month || (month === today.month && day <= today.day);
  const year = hasOccurredThisYear ? today.year : today.year + 1;
  return year * 10_000 + month * 100 + day;
}

export function amount(value: string, allowSuffix: boolean) {
  const text = value.trim().toUpperCase().replace(/[$,\s]/g, "");
  const match = text.match(allowSuffix ? /^(-?\d+(?:\.\d+)?)([KMB])?$/ : /^(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const multiplier =
    match[2] === "K"
      ? 1_000
      : match[2] === "M"
        ? 1_000_000
        : match[2] === "B"
          ? 1_000_000_000
          : 1;
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function headerIndex(header: string[], aliases: string[], fallback: number) {
  const wanted = new Set(aliases.map(normalizeHeader));
  const index = header.findIndex((value) => wanted.has(normalizeHeader(value)));
  return index >= 0 ? index : fallback;
}

export function nationalSalesRecords(
  rows: string[][],
  yearStart: number,
  todayCode: number,
) {
  if (!rows.length) return [] as Array<{ date: number; value: number }>;
  const header = rows[0] ?? [];
  const statusCol = headerIndex(header, ["Status", "Overall PO Status"], 0);
  const departmentCol = headerIndex(header, ["Dept", "Department"], 2);
  const amountCol = headerIndex(header, ["Amount", "Total Order Amount"], 4);
  const orderDateCol = headerIndex(header, ["Order Date"], 6);
  const hasDepartmentHeader = header.some((value) => ["DEPT", "DEPARTMENT"].includes(normalizeHeader(value)));

  return rows.slice(1).flatMap((row) => {
    if ((row[statusCol] ?? "").trim().toLowerCase() === "cancelled") return [];
    if (hasDepartmentHeader && (row[departmentCol] ?? "").trim().toLowerCase() !== "national") return [];
    const date = dateCode(row[orderDateCol] ?? "");
    const value = amount(row[amountCol] ?? "", true);
    return date >= yearStart && date <= todayCode && value !== null && value > 0
      ? [{ date, value }]
      : [];
  });
}

export function freightAmount(value: string) {
  const text = value.trim().toUpperCase().replace(/\bUSD\b/g, "").trim();
  if (!text || /[A-Z]/.test(text) || !/^[\s$,\d().-]+$/.test(text)) return 0;
  const parsed = amount(text.replace(/[()]/g, ""), true) ?? 0;
  return parsed > 0 && parsed <= 250_000 ? parsed : 0;
}

export function loadType(value: string) {
  const text = value.trim();
  if (/\bFTL\b|FULL\s*TRUCK|TRUCKLOAD/i.test(text)) return "FTL" as const;
  return Number(text.match(/\d+/)?.[0] ?? 0) >= 10 ? ("FTL" as const) : ("LTL" as const);
}

export function isNewJerseyDestination(destination: string) {
  return /\b(?:NJ|NEW JERSEY)\b/i.test(destination.trim());
}

export function distanceBand(destination: string) {
  const text = destination.trim().toUpperCase();
  if (!text) return "unknown" as const;
  const localCity =
    /\b(BUENA PARK|ANAHEIM|CERRITOS|LA MIRADA|FULLERTON|LA HABRA|BREA|ORANGE|SANTA ANA|IRVINE|COSTA MESA|HUNTINGTON BEACH|LONG BEACH|CARSON|TORRANCE|COMPTON|DOWNEY|NORWALK|WHITTIER|POMONA|ONTARIO|BLOOMINGTON|LOS ANGELES|GLENDALE|PASADENA)\b/;
  const localZip =
    /\b(90[0-8]\d{2}|91[0-2]\d{2}|917\d{2}|918\d{2}|92316|926\d{2}|927\d{2}|928\d{2})\b/;
  if (localCity.test(text) || localZip.test(text)) return "local" as const;
  if (/\bCA\b|CALIFORNIA/.test(text)) return "california" as const;
  if (
    /\b(AL|AK|AZ|AR|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/.test(
      text,
    ) ||
    /\b(NEW JERSEY|NEW YORK|WASHINGTON|TEXAS|ILLINOIS|FLORIDA|GEORGIA|PENNSYLVANIA|MASSACHUSETTS|ARIZONA|NEVADA|OREGON|COLORADO)\b/.test(
      text,
    )
  ) {
    return "out-of-state" as const;
  }
  return "unknown" as const;
}

export function pacificDateParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    code: values.year * 10_000 + values.month * 100 + values.day,
  };
}
