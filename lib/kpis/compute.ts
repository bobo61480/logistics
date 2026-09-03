export type CarrierKpi = {
  name: string;
  earnings: number;
  moves: number;
  shipmentPercent: number;
};

/** Per-retailer or per-department sales totals (MTD or YTD). */
export type SalesByGroup = Record<string, number>;

export type KpiSnapshot = {
  nationalsSalesMtd: number;
  nationalsSalesYtd: number;
  wmsSalesMtd: number;
  wmsSalesYtd: number;
  shippingMtd: number;
  shippingYtd: number;
  transfersMtd: number;
  transfersYtd: number;
  njTransferMtd: number;
  njTransferYtd: number;
  topCarriers: CarrierKpi[];
  ltlPercent: number;
  ftlPercent: number;
  truckingMtd: number;
  truckingYtd: number;
  totalLocal: number;
  totalCalifornia: number;
  totalOutOfState: number;
  totalLocalMtd: number;
  totalCaliforniaMtd: number;
  totalOutOfStateMtd: number;
  // ── Sales breakdowns (2026 only, from National Order Progress sheet) ──────
  /** MTD dollar sales grouped by normalized retailer/channel name. */
  retailerSalesMtd: SalesByGroup;
  /** YTD dollar sales grouped by normalized retailer/channel name. */
  retailerSalesYtd: SalesByGroup;
  /** MTD dollar sales grouped by normalized department. */
  deptSalesMtd: SalesByGroup;
  /** YTD dollar sales grouped by normalized department. */
  deptSalesYtd: SalesByGroup;
};

export function dateCode(value: string) {
  const match = String(value ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return 0;
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  return year * 10_000 + Number(match[1]) * 100 + Number(match[2]);
}

export function amount(value: string, allowSuffix: boolean) {
  const text = String(value ?? "").trim().toUpperCase().replace(/[$,\s]/g, "");
  const match = text.match(allowSuffix ? /^(-?\d+(?:\.\d+)?)([KMB])?$/ : /^(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const multiplier = match[2] === "K" ? 1_000 : match[2] === "M" ? 1_000_000 : match[2] === "B" ? 1_000_000_000 : 1;
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

/** Maps IATA airline prefixes and common abbreviations to full carrier names. */
function normalizeCarrierName(carrier: string): string {
  const text = carrier.replace(/\s+/g, " ").trim();
  if (!text) return text;
  if (/^YP[-\s]/i.test(text)) return "Air Premia";
  if (/^OZ[-\s]/i.test(text)) return "Asiana Airlines";
  if (/^KE[-\s]/i.test(text)) return "Korean Air";
  if (/^KJ[-\s]/i.test(text)) return "Jin Air";
  if (/^7C[-\s]/i.test(text)) return "Jeju Air";
  if (/^LJ[-\s]/i.test(text)) return "Jin Air";
  if (/^BX[-\s]/i.test(text)) return "Air Busan";
  if (/^C\.?H\.?\s*ROBINSON/i.test(text)) return "C.H. Robinson";
  if (/^XPO\b/i.test(text)) return "XPO Logistics";
  if (/^ESTES\b/i.test(text)) return "Estes Express";
  if (/^SAIA\b/i.test(text)) return "Saia Inc.";
  if (/^FEDEX\b/i.test(text)) return "FedEx Freight";
  if (/^UPS\s*FREIGHT/i.test(text)) return "UPS Freight";
  return text;
}

/**
 * Normalizes a Channel column value to a canonical retailer name.
 * Case-insensitive; handles variant spellings (TJX/Tjx, ULTA STY/ULTA-STY).
 */
function normalizeRetailer(channel: string): string {
  const c = (channel ?? "").trim().toUpperCase();
  if (!c) return "Other";
  if (c.startsWith("TJX") || c === "TJXC") return "TJX";
  if (c.startsWith("ROSS")) return "Ross";
  if (c.startsWith("MACY")) return "Macy's";
  if (c.startsWith("NORDSTROM")) return "Nordstrom";
  if (c === "IHERB" || c.startsWith("IHERB")) return "iHerb";
  if (c.startsWith("ULTA")) return "Ulta";
  if (c.startsWith("BURLINGTON")) return "Burlington";
  if (c.startsWith("TARGET")) return "Target";
  if (c.startsWith("CVS")) return "CVS";
  if (c.startsWith("WALGREENS")) return "Walgreens";
  if (c.startsWith("MINISO")) return "Miniso";
  return channel.trim();
}

/**
 * Normalizes a Dept column value to a canonical department name.
 * The National sheet's Dept column uses inconsistent casing and sometimes
 * mirrors the Channel column for early-schema rows.
 */
function normalizeDept(dept: string): string {
  const d = (dept ?? "").trim().toLowerCase();
  if (!d) return "Other";
  if (d === "national" || d === "nationals") return "Nationals";
  if (d === "mbx" || d === "mbx mkt") return "MBX";
  if (d === "iherb") return "iHerb";
  if (d.includes("wholesale b2b") || d === "b2b") return "Wholesale B2B";
  if (d.includes("wholesale b2c") || d === "b2c") return "Wholesale B2C";
  if (d === "moida") return "Moida";
  // Early-schema rows where Dept mirrors Channel name — normalize to retailer
  if (d.startsWith("tjx") || d === "tjxc") return "TJX";
  if (d.startsWith("ross")) return "Ross";
  if (d.startsWith("ulta")) return "Ulta";
  if (d.startsWith("burlington")) return "Burlington";
  return dept.trim() || "Other";
}

type NationalRecord = { date: number; value: number; retailer: string; dept: string };

function nationalSalesRecords(
  rows: string[][],
  yearStart: number,
  todayCode: number,
): NationalRecord[] {
  if (!rows.length) return [];
  const header = rows[0] ?? [];
  const statusCol   = headerIndex(header, ["Status", "Overall PO Status"], 0);
  const channelCol  = headerIndex(header, ["Channel"], 1);
  const deptCol     = headerIndex(header, ["Dept", "Department"], 2);
  // "Amount in $" (col F) is the dollar column; "Amount" (col E) holds unit
  // quantities on the current schema (e.g. "103K" units against "$613,881.32").
  //
  // Older layouts predate "Amount in $" and carry dollars in "Total Order
  // Amount". That legacy column is therefore consulted only when the dollar
  // column is missing from the SCHEMA — never as a per-row fallback for a blank
  // cell. Falling back per row would read a unit quantity as revenue and turn
  // "50K units, no dollar value yet" into $50,000 of money that does not exist.
  //
  // Both are resolved by header with an explicit -1 miss rather than a
  // positional default: a positional guess lands on whatever sits at that
  // index — a spacer or PO# — and reports $0 for every row.
  const dollarCol = headerIndex(header, ["Amount in $", "Amount in USD", "Amount In $"], -1);
  const legacyDollarCol = dollarCol >= 0
    ? -1
    : headerIndex(header, ["Total Order Amount", "Amount"], -1);
  const amountCol = dollarCol >= 0 ? dollarCol : legacyDollarCol;
  const orderDateCol = headerIndex(header, ["Order Date"], 7);

  // NOTE: Dept column carries "National", "MBX", "Iherb" etc. — NOT the Channel
  // column which carries retailer names. Earlier code filtered Channel against
  // "national" which always matched $0.
  return rows.slice(1).flatMap((row): NationalRecord[] => {
    if ((row[statusCol] ?? "").trim().toLowerCase() === "cancelled") return [];
    const dateStr = row[orderDateCol] ?? "";
    const date    = dateCode(dateStr);
    if (!date || date < yearStart || date > todayCode) return [];
    const value = amountCol >= 0 ? amount(row[amountCol] ?? "", true) : null;
    if (value === null || value <= 0) return [];
    const retailer = normalizeRetailer(row[channelCol] ?? "");
    const dept     = normalizeDept(row[deptCol] ?? "");
    return [{ date, value, retailer, dept }];
  });
}

function freightAmount(value: string) {
  const text = String(value ?? "").trim().toUpperCase().replace(/\bUSD\b/g, "").trim();
  if (!text || /[A-Z]/.test(text) || !/^[\s$,\d().-]+$/.test(text)) return 0;
  const parsed = amount(text.replace(/[()]/g, ""), true) ?? 0;
  return parsed > 0 && parsed <= 250_000 ? parsed : 0;
}

function freightDateCode(value: string, today: KpiToday) {
  const full = dateCode(value);
  if (full) return full;
  const match = String(value ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return 0;
  const month = Number(match[1]);
  const day   = Number(match[2]);
  const hasOccurred = month < today.month || (month === today.month && day <= today.day);
  const year  = hasOccurred ? today.year : today.year + 1;
  return year * 10_000 + month * 100 + day;
}

function loadType(value: string) {
  const text = String(value ?? "").trim();
  if (/\bFTL\b|FULL\s*TRUCK|TRUCKLOAD/i.test(text)) return "FTL" as const;
  return Number(text.match(/\d+/)?.[0] ?? 0) >= 10 ? ("FTL" as const) : ("LTL" as const);
}

function isNewJerseyDestination(destination: string) {
  return /\b(?:NJ|NEW JERSEY)\b/i.test(String(destination ?? "").trim());
}

function distanceBand(destination: string) {
  const text = String(destination ?? "").trim().toUpperCase();
  if (!text) return "unknown" as const;
  const localCity = /\b(BUENA PARK|ANAHEIM|CERRITOS|LA MIRADA|FULLERTON|LA HABRA|BREA|ORANGE|SANTA ANA|IRVINE|COSTA MESA|HUNTINGTON BEACH|LONG BEACH|CARSON|TORRANCE|COMPTON|DOWNEY|NORWALK|WHITTIER|POMONA|ONTARIO|BLOOMINGTON|LOS ANGELES|GLENDALE|PASADENA)\b/;
  const localZip  = /\b(90[0-8]\d{2}|91[0-2]\d{2}|917\d{2}|918\d{2}|92316|926\d{2}|927\d{2}|928\d{2})\b/;
  if (localCity.test(text) || localZip.test(text)) return "local" as const;
  if (/\bCA\b|CALIFORNIA/.test(text)) return "california" as const;
  if (/\b(AL|AK|AZ|AR|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/.test(text) || /\b(NEW JERSEY|NEW YORK|WASHINGTON|TEXAS|ILLINOIS|FLORIDA|GEORGIA|PENNSYLVANIA|MASSACHUSETTS|ARIZONA|NEVADA|OREGON|COLORADO)\b/.test(text)) return "out-of-state" as const;
  return "unknown" as const;
}

export type KpiToday = { year: number; month: number; day: number; code: number };

export function pacificToday(): KpiToday {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year, month: values.month, day: values.day,
    code: values.year * 10_000 + values.month * 100 + values.day,
  };
}

export function selectedMonthBounds(today: KpiToday, selectedMonth?: string) {
  const fallback = `${today.year}-${String(today.month).padStart(2, "0")}`;
  const monthKey = String(selectedMonth ?? fallback).trim();
  const match    = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error("KPI_MONTH_INVALID");
  const year  = Number(match[1]);
  const month = Number(match[2]);
  if (year !== today.year || month < 1 || month > today.month) throw new Error("KPI_MONTH_INVALID");
  const lastDay = new Date(year, month, 0).getDate();
  const endDay  = month === today.month ? today.day : lastDay;
  return {
    monthKey,
    monthStart: year * 10_000 + month * 100 + 1,
    monthEnd:   year * 10_000 + month * 100 + endDay,
  };
}

/** Accumulates sales amounts into a SalesByGroup map. */
function accumulate(
  records: NationalRecord[],
  start: number,
  end: number,
  groupFn: (r: NationalRecord) => string,
): SalesByGroup {
  const out: SalesByGroup = {};
  for (const r of records) {
    if (r.date < start || r.date > end) continue;
    const key = groupFn(r);
    out[key] = (out[key] ?? 0) + r.value;
  }
  return out;
}

type Input = {
  nationalRows: string[][];
  wmsRows: string[][];
  truckingRows: string[][];
  transferRows: string[][];
  today?: KpiToday;
  selectedMonth?: string;
};

export function computeKpisFromRows(input: Input): KpiSnapshot {
  const today    = input.today ?? pacificToday();
  // YTD = 2026 Jan 1 through today (today.year ensures this stays correct)
  const yearStart = today.year * 10_000 + 101;
  const { monthStart, monthEnd } = selectedMonthBounds(today, input.selectedMonth);

  // ── National sales (using "Amount in $" column, includes retailer + dept) ──
  const nationalSales = nationalSalesRecords(input.nationalRows, yearStart, today.code);

  const sum = (records: Array<{ date: number; value: number }>, start: number, end = today.code) =>
    records.filter((r) => r.date >= start && r.date <= end).reduce((t, r) => t + r.value, 0);

  // The Nationals KPI card reports the Nationals department only. MBX and iHerb
  // ride along in the same sheet and are reported separately, so folding them
  // into this total overstates Nationals revenue. The per-retailer/per-dept
  // breakdown below still sees every record.
  const nationalsOnly = nationalSales.filter((record) => record.dept === "Nationals");

  // ── WMS sales ─────────────────────────────────────────────────────────────
  const wmsSales = input.wmsRows.slice(1).flatMap((row) => {
    const date  = dateCode(row[0] ?? "");
    const value = amount(row[6] ?? "", false);
    return date >= yearStart && date <= today.code && value !== null ? [{ date, value }] : [];
  });

  // ── Freight records ───────────────────────────────────────────────────────
  const trucking = input.truckingRows.slice(2).flatMap((row) => {
    const date = freightDateCode(row[3] ?? "", today);
    if (!date) return [];
    return [{
      date, isTransfer: false,
      cost:        freightAmount(row[21] ?? "") || freightAmount(row[17] ?? ""),
      carrier:     normalizeCarrierName((row[16] ?? "").trim()),
      destination: (row[2] ?? "").trim(),
      loadType:    loadType([row[4], row[5]].filter(Boolean).join(" ")),
    }];
  });

  const transfer = input.transferRows.slice(1).flatMap((row) => {
    const date = freightDateCode(row[5] ?? "", today);
    if (!date) return [];
    return [{
      date, isTransfer: true,
      cost:        freightAmount(row[9] ?? "") || freightAmount(row[8] ?? ""),
      carrier:     normalizeCarrierName((row[6] ?? "").trim()),
      destination: (row[4] ?? "").trim(),
      loadType:    loadType(row[1] ?? ""),
    }];
  });

  const freight     = [...trucking, ...transfer].filter((r) => r.date >= yearStart && r.date <= today.code);
  const freightMtd  = freight.filter((r) => r.date >= monthStart && r.date <= monthEnd);
  const truckingYtd = freight.filter((r) => !r.isTransfer);
  const truckingMtd = freightMtd.filter((r) => !r.isTransfer);
  const transferYtd = freight.filter((r) => r.isTransfer);
  const transferMtd = freightMtd.filter((r) => r.isTransfer);
  const njTransferYtd = transferYtd.filter((r) => isNewJerseyDestination(r.destination));
  const njTransferMtd = transferMtd.filter((r) => isNewJerseyDestination(r.destination));

  // ── Carrier stats ─────────────────────────────────────────────────────────
  const carrierTotals = freight.reduce((totals, record) => {
    if (!record.carrier) return totals;
    const key     = record.carrier.toUpperCase();
    const current = totals.get(key) ?? { name: record.carrier, earnings: 0, moves: 0 };
    current.earnings += record.cost;
    current.moves    += 1;
    totals.set(key, current);
    return totals;
  }, new Map<string, { name: string; earnings: number; moves: number }>());

  const namedMoves = [...carrierTotals.values()].reduce((t, c) => t + c.moves, 0);
  const topCarriers = [...carrierTotals.values()]
    .sort((a, b) => b.moves - a.moves || b.earnings - a.earnings)
    .slice(0, 3)
    .map((c) => ({ ...c, shipmentPercent: namedMoves ? Math.round((c.moves / namedMoves) * 1_000) / 10 : 0 }));

  const classified = freight.filter((r) => !r.isTransfer || r.cost > 0);
  const ltl = classified.filter((r) => r.loadType === "LTL").length;
  const ftl = classified.filter((r) => r.loadType === "FTL").length;
  const splitTotal = ltl + ftl;

  const laneTotal = (records: typeof freight, band: "local" | "california" | "out-of-state") =>
    records
      .filter((r) => !r.isTransfer && r.cost > 0 && distanceBand(r.destination) === band)
      .reduce((t, r) => t + r.cost, 0);

  // ── Retailer & department breakdowns (2026 only) ──────────────────────────
  const retailerSalesMtd = accumulate(nationalSales, monthStart, monthEnd, (r) => r.retailer);
  const retailerSalesYtd = accumulate(nationalSales, yearStart, today.code, (r) => r.retailer);
  const deptSalesMtd     = accumulate(nationalSales, monthStart, monthEnd, (r) => r.dept);
  const deptSalesYtd     = accumulate(nationalSales, yearStart, today.code, (r) => r.dept);

  return {
    nationalsSalesMtd: sum(nationalsOnly, monthStart, monthEnd),
    nationalsSalesYtd: sum(nationalsOnly, yearStart),
    wmsSalesMtd:       sum(wmsSales, monthStart, monthEnd),
    wmsSalesYtd:       sum(wmsSales, yearStart),
    shippingMtd:       freightMtd.reduce((t, r) => t + r.cost, 0),
    shippingYtd:       freight.reduce((t, r) => t + r.cost, 0),
    transfersMtd:      transferMtd.reduce((t, r) => t + r.cost, 0),
    transfersYtd:      transferYtd.reduce((t, r) => t + r.cost, 0),
    njTransferMtd:     njTransferMtd.reduce((t, r) => t + r.cost, 0),
    njTransferYtd:     njTransferYtd.reduce((t, r) => t + r.cost, 0),
    topCarriers,
    ltlPercent:  splitTotal ? Math.round((ltl / splitTotal) * 100) : 0,
    ftlPercent:  splitTotal ? Math.round((ftl / splitTotal) * 100) : 0,
    truckingMtd: truckingMtd.reduce((t, r) => t + r.cost, 0),
    truckingYtd: truckingYtd.reduce((t, r) => t + r.cost, 0),
    totalLocal:             laneTotal(freight, "local"),
    totalCalifornia:        laneTotal(freight, "california"),
    totalOutOfState:        laneTotal(freight, "out-of-state"),
    totalLocalMtd:          laneTotal(freightMtd, "local"),
    totalCaliforniaMtd:     laneTotal(freightMtd, "california"),
    totalOutOfStateMtd:     laneTotal(freightMtd, "out-of-state"),
    retailerSalesMtd,
    retailerSalesYtd,
    deptSalesMtd,
    deptSalesYtd,
  };
}
