// Client-side port of the former /api/sales-kpis server route.
// Runs entirely in the browser: the workbooks are link-readable, and the
// docs.google.com /export CSV endpoint serves CORS headers for them
// (page.tsx already fetches the same endpoint client-side elsewhere).

const NATIONAL_SHEET_ID = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";
const WMS_SHEET_ID = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";
const LOGISTICS_SHEET_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";

type CarrierKpi = {
  name: string;
  earnings: number;
  moves: number;
  shipmentPercent: number;
};

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

async function fullCsv(spreadsheetId: string, gid: number) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
  url.searchParams.set("format", "csv");
  url.searchParams.set("gid", String(gid));
  url.searchParams.set("_", String(Date.now()));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`KPI workbook read failed (${response.status}).`);
  return parseCsv(await response.text());
}

export async function computeLiveKpis(): Promise<Record<string, number | string | CarrierKpi[]>> {
  try {
    const [nationalRows, wmsRows, truckingRows, transferRows] = await Promise.all([
      fullCsv(NATIONAL_SHEET_ID, 99300389),
      fullCsv(WMS_SHEET_ID, 0),
      fullCsv(LOGISTICS_SHEET_ID, 852802817),
      fullCsv(LOGISTICS_SHEET_ID, 1834454901),
    ]);
    const today = pacificDateParts();
    const yearStart = today.year * 10_000 + 101;
    const monthStart = today.year * 10_000 + today.month * 100 + 1;

    const nationalSales = nationalRows.slice(1).flatMap((row) => {
      if ((row[0] ?? "").trim().toLowerCase() === "cancelled") return [];
      const date = dateCode(row[6] ?? "");
      const value = amount(row[4] ?? "", true);
      return date >= yearStart && date <= today.code && value !== null && value > 0
        ? [{ date, value }]
        : [];
    });
    const wmsSales = wmsRows.slice(2).flatMap((row) => {
      const date = dateCode(row[0] ?? "");
      const value = amount(row[6] ?? "", false);
      return date >= yearStart && date <= today.code && value !== null
        ? [{ date, value }]
        : [];
    });
    const sum = (records: Array<{ date: number; value: number }>, start: number) =>
      records
        .filter((record) => record.date >= start)
        .reduce((total, record) => total + record.value, 0);
    const trucking = truckingRows.slice(2).flatMap((row) => {
      const date = freightDateCode(row[3] ?? "", today);
      if (!date) return [];
      return [{
        date,
        cost: freightAmount(row[21] ?? "") || freightAmount(row[17] ?? ""),
        carrier: (row[16] ?? "").trim().replace(/\s+/g, " "),
        destination: (row[2] ?? "").trim(),
        loadType: loadType([row[4], row[5]].filter(Boolean).join(" ")),
        isTransfer: false,
      }];
    });
    const transfer = transferRows.slice(1).flatMap((row) => {
      const date = freightDateCode(row[5] ?? "", today);
      if (!date) return [];
      return [{
        date,
        cost: freightAmount(row[9] ?? "") || freightAmount(row[8] ?? ""),
        carrier: (row[6] ?? "").trim().replace(/\s+/g, " "),
        destination: (row[4] ?? "").trim(),
        loadType: loadType(row[1] ?? ""),
        isTransfer: true,
      }];
    });
    const freight = [...trucking, ...transfer].filter(
      (record) => record.date >= yearStart && record.date <= today.code,
    );
    const freightMtd = freight.filter((record) => record.date >= monthStart);
    const transferYtd = freight.filter((record) => record.isTransfer);
    const transferMtd = freightMtd.filter((record) => record.isTransfer);
    const njTransferYtd = transferYtd.filter((record) =>
      isNewJerseyDestination(record.destination),
    );
    const njTransferMtd = transferMtd.filter((record) =>
      isNewJerseyDestination(record.destination),
    );
    const carrierTotals = freight.reduce((totals, record) => {
      if (!record.carrier) return totals;
      const key = record.carrier.toUpperCase();
      const current = totals.get(key) ?? { name: record.carrier, earnings: 0, moves: 0 };
      current.earnings += record.cost;
      current.moves += 1;
      totals.set(key, current);
      return totals;
    }, new Map<string, { name: string; earnings: number; moves: number }>());
    const namedCarrierMoves = [...carrierTotals.values()].reduce(
      (total, carrier) => total + carrier.moves,
      0,
    );
    const topCarriers: CarrierKpi[] = [...carrierTotals.values()]
      .sort((a, b) => b.moves - a.moves || b.earnings - a.earnings)
      .slice(0, 3)
      .map((carrier) => ({
        ...carrier,
        shipmentPercent: namedCarrierMoves
          ? Math.round((carrier.moves / namedCarrierMoves) * 1_000) / 10
          : 0,
      }));
    const classified = freight.filter((record) => !record.isTransfer || record.cost > 0);
    const ltl = classified.filter((record) => record.loadType === "LTL").length;
    const ftl = classified.filter((record) => record.loadType === "FTL").length;
    const splitTotal = ltl + ftl;
    const average = (
      records: typeof freight,
      band: "local" | "california" | "out-of-state",
    ) => {
      const matching = records.filter(
        (record) =>
          !record.isTransfer &&
          record.cost > 0 &&
          distanceBand(record.destination) === band,
      );
      return matching.length
        ? matching.reduce((total, record) => total + record.cost, 0) / matching.length
        : 0;
    };

    return {
        nationalsSalesMtd: sum(nationalSales, monthStart),
        nationalsSalesYtd: sum(nationalSales, yearStart),
        wmsSalesMtd: sum(wmsSales, monthStart),
        wmsSalesYtd: sum(wmsSales, yearStart),
        shippingMtd: freightMtd.reduce((total, record) => total + record.cost, 0),
        shippingYtd: freight.reduce((total, record) => total + record.cost, 0),
        transfersMtd: transferMtd.reduce((total, record) => total + record.cost, 0),
        transfersYtd: transferYtd.reduce((total, record) => total + record.cost, 0),
        njTransferMtd: njTransferMtd.reduce((total, record) => total + record.cost, 0),
        njTransferYtd: njTransferYtd.reduce((total, record) => total + record.cost, 0),
        topCarriers,
        ltlPercent: splitTotal ? Math.round((ltl / splitTotal) * 100) : 0,
        ftlPercent: splitTotal ? Math.round((ftl / splitTotal) * 100) : 0,
        avgLocal: average(freight, "local"),
        avgCalifornia: average(freight, "california"),
        avgOutOfState: average(freight, "out-of-state"),
        avgLocalMtd: average(freightMtd, "local"),
        avgCaliforniaMtd: average(freightMtd, "california"),
        avgOutOfStateMtd: average(freightMtd, "out-of-state"),
    };
  } catch (error) {
    throw error instanceof Error ? error : new Error("KPI calculation failed.");
  }
}
