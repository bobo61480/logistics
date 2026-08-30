export type CarrierKpi = {
  name: string;
  earnings: number;
  moves: number;
  shipmentPercent: number;
};

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
  avgLocal: number;
  avgCalifornia: number;
  avgOutOfState: number;
  avgLocalMtd: number;
  avgCaliforniaMtd: number;
  avgOutOfStateMtd: number;
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

function nationalSalesRecords(rows: string[][], yearStart: number, todayCode: number) {
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
    return date >= yearStart && date <= todayCode && value !== null && value > 0 ? [{ date, value }] : [];
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
  const day = Number(match[2]);
  const hasOccurred = month < today.month || (month === today.month && day <= today.day);
  const year = hasOccurred ? today.year : today.year + 1;
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
  const localZip = /\b(90[0-8]\d{2}|91[0-2]\d{2}|917\d{2}|918\d{2}|92316|926\d{2}|927\d{2}|928\d{2})\b/;
  if (localCity.test(text) || localZip.test(text)) return "local" as const;
  if (/\bCA\b|CALIFORNIA/.test(text)) return "california" as const;
  if (/\b(AL|AK|AZ|AR|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/.test(text) || /\b(NEW JERSEY|NEW YORK|WASHINGTON|TEXAS|ILLINOIS|FLORIDA|GEORGIA|PENNSYLVANIA|MASSACHUSETTS|ARIZONA|NEVADA|OREGON|COLORADO)\b/.test(text)) return "out-of-state" as const;
  return "unknown" as const;
}

export type KpiToday = { year: number; month: number; day: number; code: number };

export function pacificToday(): KpiToday {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, code: values.year * 10_000 + values.month * 100 + values.day };
}

type Input = {
  nationalRows: string[][];
  wmsRows: string[][];
  truckingRows: string[][];
  transferRows: string[][];
  today?: KpiToday;
};

export function computeKpisFromRows(input: Input): KpiSnapshot {
  const today = input.today ?? pacificToday();
  const yearStart = today.year * 10_000 + 101;
  const monthStart = today.year * 10_000 + today.month * 100 + 1;
  const nationalSales = nationalSalesRecords(input.nationalRows, yearStart, today.code);
  const wmsSales = input.wmsRows.slice(1).flatMap((row) => {
    const date = dateCode(row[0] ?? "");
    const value = amount(row[6] ?? "", false);
    return date >= yearStart && date <= today.code && value !== null ? [{ date, value }] : [];
  });
  const sum = (records: Array<{ date: number; value: number }>, start: number) => records.filter((r) => r.date >= start).reduce((total, r) => total + r.value, 0);
  const trucking = input.truckingRows.slice(2).flatMap((row) => {
    const date = freightDateCode(row[3] ?? "", today);
    if (!date) return [];
    return [{ date, cost: freightAmount(row[21] ?? "") || freightAmount(row[17] ?? ""), carrier: (row[16] ?? "").trim().replace(/\s+/g, " "), destination: (row[2] ?? "").trim(), loadType: loadType([row[4], row[5]].filter(Boolean).join(" ")), isTransfer: false }];
  });
  const transfer = input.transferRows.slice(1).flatMap((row) => {
    const date = freightDateCode(row[5] ?? "", today);
    if (!date) return [];
    return [{ date, cost: freightAmount(row[9] ?? "") || freightAmount(row[8] ?? ""), carrier: (row[6] ?? "").trim().replace(/\s+/g, " "), destination: (row[4] ?? "").trim(), loadType: loadType(row[1] ?? ""), isTransfer: true }];
  });
  const freight = [...trucking, ...transfer].filter((r) => r.date >= yearStart && r.date <= today.code);
  const freightMtd = freight.filter((r) => r.date >= monthStart);
  const transferYtd = freight.filter((r) => r.isTransfer);
  const transferMtd = freightMtd.filter((r) => r.isTransfer);
  const njTransferYtd = transferYtd.filter((r) => isNewJerseyDestination(r.destination));
  const njTransferMtd = transferMtd.filter((r) => isNewJerseyDestination(r.destination));
  const carrierTotals = freight.reduce((totals, record) => {
    if (!record.carrier) return totals;
    const key = record.carrier.toUpperCase();
    const current = totals.get(key) ?? { name: record.carrier, earnings: 0, moves: 0 };
    current.earnings += record.cost;
    current.moves += 1;
    totals.set(key, current);
    return totals;
  }, new Map<string, { name: string; earnings: number; moves: number }>());
  const namedMoves = [...carrierTotals.values()].reduce((total, carrier) => total + carrier.moves, 0);
  const topCarriers = [...carrierTotals.values()].sort((a, b) => b.moves - a.moves || b.earnings - a.earnings).slice(0, 3).map((carrier) => ({ ...carrier, shipmentPercent: namedMoves ? Math.round((carrier.moves / namedMoves) * 1_000) / 10 : 0 }));
  const classified = freight.filter((r) => !r.isTransfer || r.cost > 0);
  const ltl = classified.filter((r) => r.loadType === "LTL").length;
  const ftl = classified.filter((r) => r.loadType === "FTL").length;
  const splitTotal = ltl + ftl;
  const average = (records: typeof freight, band: "local" | "california" | "out-of-state") => {
    const matching = records.filter((r) => !r.isTransfer && r.cost > 0 && distanceBand(r.destination) === band);
    return matching.length ? matching.reduce((total, r) => total + r.cost, 0) / matching.length : 0;
  };
  return {
    nationalsSalesMtd: sum(nationalSales, monthStart), nationalsSalesYtd: sum(nationalSales, yearStart),
    wmsSalesMtd: sum(wmsSales, monthStart), wmsSalesYtd: sum(wmsSales, yearStart),
    shippingMtd: freightMtd.reduce((t, r) => t + r.cost, 0), shippingYtd: freight.reduce((t, r) => t + r.cost, 0),
    transfersMtd: transferMtd.reduce((t, r) => t + r.cost, 0), transfersYtd: transferYtd.reduce((t, r) => t + r.cost, 0),
    njTransferMtd: njTransferMtd.reduce((t, r) => t + r.cost, 0), njTransferYtd: njTransferYtd.reduce((t, r) => t + r.cost, 0),
    topCarriers, ltlPercent: splitTotal ? Math.round((ltl / splitTotal) * 100) : 0, ftlPercent: splitTotal ? Math.round((ftl / splitTotal) * 100) : 0,
    avgLocal: average(freight, "local"), avgCalifornia: average(freight, "california"), avgOutOfState: average(freight, "out-of-state"),
    avgLocalMtd: average(freightMtd, "local"), avgCaliforniaMtd: average(freightMtd, "california"), avgOutOfStateMtd: average(freightMtd, "out-of-state"),
  };
}
