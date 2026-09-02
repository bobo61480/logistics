import { runCmsReadonlyQuery, type CmsGatewayEnv } from "./cms-client";

// The Imports invoices are intercompany (biz_type='SELF') shipments to the US
// warehouse, in USD. See docs/cms-imports-mapping.md for the verified mapping.
const BIZ_TYPE = "SELF";
const CUST_CD = "CU000731";
const WHOUSE_CD = "WH000095";
// USD (BASE_DB.dbo.TB_CODE gbn_cd='C005': 2 = USD). Part of the verified IMPORTS
// scope — a stale/mistyped sheet invoice can resolve to a non-USD record for the
// same SELF customer + warehouse, so the currency predicate keeps those out of
// the (public) snapshot, matching the mapping runner's scope check.
const BIZ_CURR_USD = 2;
// Bound the read to a recent window so the snapshot stays small and fast; the
// live IMPORTS grid only cares about in-flight/recent shipments.
const WINDOW_DAYS = 180;
const ROW_LIMIT = 2000;

export type CmsImportRow = {
  invoiceNo: string;
  etaDate: string;
  actualArrival: string;
  outboundDate: string;
  carrier: string;
  // null = the quantity was absent/masked by the caller's CMS access grade;
  // a number (including 0) = a real value the CMS supplied. Kept distinct so a
  // genuine "0 received" is not confused with a masked column downstream.
  invoicedQty: number | null;
  receivedQty: number | null;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

// Dates come back either as YYYY-MM-DD or a full ISO timestamp; keep only the
// calendar date. Empty/whitespace values (e.g. a masked TB_PNFM column) → "".
function dateOnly(value: unknown) {
  const trimmed = text(value);
  return trimmed ? trimmed.slice(0, 10) : "";
}

// null-preserving numeric parse: absent/blank/masked → null; a real numeric
// (including 0) → the number. Never coerces a masked column into a false 0.
function qty(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// Pure row mapper — exported for unit testing without touching the network.
export function mapCmsImportRows(rawRows: Record<string, unknown>[]): CmsImportRow[] {
  return rawRows
    .map((row): CmsImportRow => ({
      invoiceNo: text(row.invc_no),
      etaDate: dateOnly(row.eta_dt),
      actualArrival: dateOnly(row.arrv_dt),
      outboundDate: dateOnly(row.ow_dt),
      carrier: text(row.carrier),
      invoicedQty: qty(row.invc_qtot),
      receivedQty: qty(row.iw_qtot),
    }))
    .filter((row) => row.invoiceNo);
}

// Mirror the browser's IMPORTS invoice extraction (app/page.tsx): invoice is
// column 2, shipment column 0; the OSL10 shipment carries a known typo'd
// invoice, and an invoice cell may list several values split on newlines/commas.
const IMPORTS_SHIPMENT_COL = 0;
const IMPORTS_INVOICE_COL = 2;

function splitInvoiceValues(value: string): string[] {
  return value.split(/\r?\n|,\s*/).map((part) => part.trim()).filter(Boolean);
}

function correctInvoice(shipmentNo: string, value: string): string {
  if (/^OSL10(?:\s*-\s*2026)?$/i.test(shipmentNo.trim())) {
    return value.replace(/\bN00451013\b/g, "IN00451013");
  }
  return value;
}

// The uppercased set of invoice numbers actually present on the IMPORTS sheet.
export function importsInvoiceSet(importsRows: string[][] | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(importsRows)) return set;
  for (const row of importsRows) {
    if (!Array.isArray(row)) continue;
    const shipmentNo = text(row[IMPORTS_SHIPMENT_COL]);
    const invoiceCell = correctInvoice(shipmentNo, text(row[IMPORTS_INVOICE_COL]));
    for (const invoice of splitInvoiceValues(invoiceCell)) set.add(invoice.toUpperCase());
  }
  return set;
}

// Server-side reduction so the public (unauthenticated) snapshot never
// serializes the full CMS query: only records whose invoice appears on the
// IMPORTS sheet are exposed; every other CMS invoice from the 180-day window is
// dropped before it leaves the Worker. The exposed fields are already the
// approved logistics subset (invoice, dates, carrier, qtys).
export function reduceCmsImportsToImports(
  cmsRows: CmsImportRow[],
  importsRows: string[][] | null | undefined,
): CmsImportRow[] {
  const allowed = importsInvoiceSet(importsRows);
  if (allowed.size === 0) return [];
  return cmsRows.filter((row) => allowed.has(row.invoiceNo.trim().toUpperCase()));
}

function windowStart(now: Date) {
  const start = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 10);
}

export async function fetchCmsImports(env: CmsGatewayEnv, now = new Date()) {
  const started = Date.now();
  const fetchedAt = new Date().toISOString();
  const health = (ok: boolean, error?: string) => ({
    name: "Siliconii CMS Imports",
    ok,
    fetchedAt,
    latencyMs: Date.now() - started,
    error,
  });
  if (!env.CMS_MCP_URL) {
    return { configured: false, rows: [] as CmsImportRow[], health: health(false, "CMS gateway is not configured") };
  }
  try {
    const since = windowStart(now);
    // TB_PNFM (LEFT JOIN) carries the actual arrival + received qty; under a
    // masking access grade its columns come back null, which mapCmsImportRows
    // renders as empty actualArrival / null receivedQty — the TB_INVC columns
    // are unaffected, so the feature still shows ETA + invoiced qty.
    const sql = `SELECT TOP ${ROW_LIMIT} i.invc_no, i.eta_dt, i.ow_dt, i.carrier, i.invc_qtot, p.arrv_dt, p.iw_qtot
      FROM CSMS.dbo.TB_INVC i WITH (NOLOCK)
      LEFT JOIN CSMS.dbo.TB_PNFM p WITH (NOLOCK) ON p.invc_no = i.invc_no
      WHERE i.biz_type = '${BIZ_TYPE}' AND i.cust_cd = '${CUST_CD}' AND i.whouse_cd = '${WHOUSE_CD}'
        AND i.biz_curr = ${BIZ_CURR_USD}
        AND i.invc_dt >= '${since}'
      ORDER BY i.invc_dt DESC`;
    const result = await runCmsReadonlyQuery(
      env,
      sql,
      ROW_LIMIT,
      "Read recent CMS import invoice headers (actual arrival + received vs invoiced qty) to reconcile the IMPORTS logistics schedule",
    );
    return { configured: true, rows: mapCmsImportRows(result), health: health(true) };
  } catch (error) {
    console.error(JSON.stringify({ event: "siliconii-cms-imports-failed", error: String(error) }));
    return { configured: true, rows: [] as CmsImportRow[], health: health(false, error instanceof Error ? error.message : String(error)) };
  }
}
