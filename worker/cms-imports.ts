import { runCmsReadonlyQuery, type CmsGatewayEnv } from "./cms-client";

// The Imports invoices are intercompany (biz_type='SELF') shipments to the US
// warehouse, in USD. See docs/cms-imports-mapping.md for the verified mapping.
const BIZ_TYPE = "SELF";
const CUST_CD = "CU000731";
const WHOUSE_CD = "WH000095";
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
  invoicedQty: number;
  receivedQty: number;
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

function count(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
      invoicedQty: count(row.invc_qtot),
      receivedQty: count(row.iw_qtot),
    }))
    .filter((row) => row.invoiceNo);
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
    // renders as empty actualArrival/receivedQty (0) — the TB_INVC columns are
    // unaffected, so the feature still shows ETA + invoiced qty.
    const sql = `SELECT TOP ${ROW_LIMIT} i.invc_no, i.eta_dt, i.ow_dt, i.carrier, i.invc_qtot, p.arrv_dt, p.iw_qtot
      FROM CSMS.dbo.TB_INVC i WITH (NOLOCK)
      LEFT JOIN CSMS.dbo.TB_PNFM p WITH (NOLOCK) ON p.invc_no = i.invc_no
      WHERE i.biz_type = '${BIZ_TYPE}' AND i.cust_cd = '${CUST_CD}' AND i.whouse_cd = '${WHOUSE_CD}'
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
