import { selectedMonthBounds, type KpiToday } from "../lib/kpis/compute";

const DEFAULT_CMS_GATEWAY_URL = "https://stylekorean-cms-gateway.stylekorean.workers.dev";

type CmsSalesEnv = {
  CMS_GATEWAY_URL?: string;
};

type GatewaySalesRow = {
  currency?: unknown;
  invoiceCount?: unknown;
  totalSales?: unknown;
};

type GatewaySalesPayload = {
  ok?: unknown;
  month?: unknown;
  rows?: unknown;
  error?: unknown;
};

export type CmsSalesMonth = {
  month: string;
  currency: string | null;
  invoiceCount: number;
  totalSales: number;
};

export type CmsSalesKpis = {
  source: "siliconii-cms-invoices";
  selectedMonth: string;
  currency: string;
  wmsSalesMtd: number;
  wmsSalesYtd: number;
  invoiceCountMtd: number;
  invoiceCountYtd: number;
  months: CmsSalesMonth[];
  generatedAt: string;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pacificTodayAt(now: Date): KpiToday {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    code: values.year * 10_000 + values.month * 100 + values.day,
  };
}

function monthKeys(today: KpiToday) {
  return Array.from({ length: today.month }, (_, index) =>
    `${today.year}-${String(index + 1).padStart(2, "0")}`,
  );
}

function parseMonthPayload(payload: GatewaySalesPayload, expectedMonth: string): CmsSalesMonth {
  if (payload.ok !== true) throw new Error("CMS_SALES_GATEWAY_FAILED");
  const payloadMonth = text(payload.month);
  if (payloadMonth && payloadMonth !== expectedMonth) throw new Error("CMS_SALES_GATEWAY_MONTH_MISMATCH");
  const rows = Array.isArray(payload.rows) ? payload.rows as GatewaySalesRow[] : [];
  const currencies = [...new Set(rows.map((row) => text(row.currency)).filter(Boolean))];
  if (currencies.length > 1) throw new Error("CMS_SALES_MULTIPLE_CURRENCIES");
  return {
    month: expectedMonth,
    currency: currencies[0] ?? null,
    invoiceCount: rows.reduce((total, row) => total + number(row.invoiceCount), 0),
    totalSales: rows.reduce((total, row) => total + number(row.totalSales), 0),
  };
}

async function fetchMonth(
  gatewayUrl: string,
  month: string,
  fetchImpl: typeof fetch,
): Promise<CmsSalesMonth> {
  const url = new URL("/sales-summary", gatewayUrl.endsWith("/") ? gatewayUrl : `${gatewayUrl}/`);
  url.searchParams.set("month", month);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("CMS_SALES_GATEWAY_FAILED");
  let payload: GatewaySalesPayload;
  try {
    payload = await response.json() as GatewaySalesPayload;
  } catch {
    throw new Error("CMS_SALES_GATEWAY_INVALID_JSON");
  }
  return parseMonthPayload(payload, month);
}

export async function fetchCmsSalesKpis(
  env: CmsSalesEnv,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
  selectedMonth?: string,
): Promise<CmsSalesKpis> {
  const today = pacificTodayAt(now);
  const { monthKey } = selectedMonthBounds(today, selectedMonth);
  const gatewayUrl = text(env.CMS_GATEWAY_URL) || DEFAULT_CMS_GATEWAY_URL;
  const months = await Promise.all(monthKeys(today).map((month) => fetchMonth(gatewayUrl, month, fetchImpl)));
  const currencies = [...new Set(months.map((month) => month.currency).filter((value): value is string => Boolean(value)))];
  if (currencies.length > 1) throw new Error("CMS_SALES_MULTIPLE_CURRENCIES");
  const selected = months.find((month) => month.month === monthKey);
  if (!selected) throw new Error("KPI_MONTH_INVALID");

  return {
    source: "siliconii-cms-invoices",
    selectedMonth: monthKey,
    currency: currencies[0] ?? "UNKNOWN",
    wmsSalesMtd: selected.totalSales,
    wmsSalesYtd: months.reduce((total, month) => total + month.totalSales, 0),
    invoiceCountMtd: selected.invoiceCount,
    invoiceCountYtd: months.reduce((total, month) => total + month.invoiceCount, 0),
    months,
    generatedAt: now.toISOString(),
  };
}
