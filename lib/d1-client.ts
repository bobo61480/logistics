/**
 * lib/d1-client.ts
 * Browser-side API client for the D1 read model served by src/worker.ts.
 *
 * Each function tries the local Worker API first (fast, cached) and returns
 * null on any failure so callers can fall back to the direct gviz/CSV path.
 *
 * Usage pattern in page.tsx:
 *   const cached = await apiImports({ status: "active" });
 *   const rows = cached ?? (await fetchGvizImports());
 */

const BASE = "/api";
const TIMEOUT_MS = 4_000; // abandon API call quickly if Worker is unresponsive

async function get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
  try {
    const url = new URL(BASE + path, globalThis.location?.href ?? "http://localhost");
    if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const res = await fetch(url.toString(), { cache: "no-store", signal: ac.signal });
    clearTimeout(timer);

    if (!res.ok) return null;
    const json = await res.json() as { ok: boolean } & Record<string, unknown>;
    return json.ok ? (json as T) : null;
  } catch {
    return null;
  }
}

// ── Types (mirror D1 table schemas) ─────────────────────────────────────────

export interface D1ImportRow {
  id: string;
  source_row: number;
  shipment_no: string;
  invoice: string;
  mbl: string;
  hbl: string;
  container: string;
  vessel: string;
  etd: string;
  eta: string;
  delivery_expected: string;
  status: string;
  synced_at: number;
}

export interface D1FreightRow {
  id: string;
  move_type: "trucking" | "transfer";
  date_iso: string;
  date_code: number;
  destination: string;
  carrier: string;
  cost_usd: number;
  load_type: "LTL" | "FTL";
  is_nj_transfer: number;
  distance_band: string;
  source_row: number;
  synced_at: number;
}

export interface D1SalesRow {
  id: string;
  source: "wms" | "nationals";
  date_iso: string;
  date_code: number;
  amount_usd: number;
  status: string;
  synced_at: number;
}

export interface D1FulfillmentRow {
  id: string;
  invoice: string;
  customer: string;
  ship_date: string;
  amount_usd: number;
  inspection: string;
  insp_end: string;
  moved_to_packing: number;
  dims_count: number;
  dim_included_in: string;
  pick_start: string;
  pick_complete: number;
  status: string;
  pick_anomaly: number;
  synced_at: number;
}

export interface D1Kpis {
  nationalsSalesYtd: number;
  nationalsSalesMtd: number;
  wmsSalesYtd: number;
  wmsSalesMtd: number;
  shippingYtd: number;
  shippingMtd: number;
  transfersYtd: number;
  transfersMtd: number;
  njTransferYtd: number;
  njTransferMtd: number;
  topCarriers: { name: string; earnings: number; moves: number; shipmentPercent: number }[];
  ltlPercent: number;
  ftlPercent: number;
  avgLocal: number;
  avgCalifornia: number;
  avgOutOfState: number;
  avgLocalMtd: number;
  avgCaliforniaMtd: number;
  avgOutOfStateMtd: number;
}

export interface D1SyncSource {
  source: string;
  last_synced_at: number | null;
  row_count: number | null;
  error: string | null;
}

// ── API wrappers ─────────────────────────────────────────────────────────────

/** Fetch cached import rows. status="active" filters out terminal statuses. */
export async function apiImports(opts: {
  status?: "active" | string;
  limit?: number;
} = {}): Promise<{ items: D1ImportRow[]; count: number } | null> {
  const params: Record<string, string> = {};
  if (opts.status) params.status = opts.status;
  if (opts.limit)  params.limit  = String(opts.limit);
  return get("/imports", params);
}

/** Fetch cached freight moves for KPI computation. */
export async function apiFreight(opts: {
  since?: number;   // YYYYMMDD
  type?: "trucking" | "transfer";
  limit?: number;
} = {}): Promise<{ items: D1FreightRow[]; count: number } | null> {
  const params: Record<string, string> = {};
  if (opts.since) params.since = String(opts.since);
  if (opts.type)  params.type  = opts.type;
  if (opts.limit) params.limit = String(opts.limit);
  return get("/freight", params);
}

/** Fetch cached sales entries for KPI computation. */
export async function apiSales(opts: {
  source?: "wms" | "nationals";
  since?: number;   // YYYYMMDD
  limit?: number;
} = {}): Promise<{ items: D1SalesRow[]; count: number } | null> {
  const params: Record<string, string> = {};
  if (opts.source) params.source = opts.source;
  if (opts.since)  params.since  = String(opts.since);
  if (opts.limit)  params.limit  = String(opts.limit);
  return get("/sales", params);
}

/** Fetch cached TK fulfillment jobs. */
export async function apiFulfillment(opts: {
  status?: string;
  limit?: number;
} = {}): Promise<{ items: D1FulfillmentRow[]; count: number } | null> {
  const params: Record<string, string> = {};
  if (opts.status) params.status = opts.status;
  if (opts.limit)  params.limit  = String(opts.limit);
  return get("/fulfillment", params);
}

/** Fetch pre-computed KPIs from D1 (no Sheet fetch needed). */
export async function apiKpis(): Promise<D1Kpis | null> {
  return get<D1Kpis>("/kpis");
}

/** Fetch sync_log health status for all sources. */
export async function apiHealth(): Promise<{ sources: D1SyncSource[] } | null> {
  return get("/health");
}

/**
 * Trigger a manual sync from the browser (calls the Worker's /api/sync).
 * Returns the sync result or null if the Worker is unreachable.
 * source omitted = full sync.
 */
export async function apiSync(source?: string): Promise<unknown | null> {
  const params: Record<string, string> = {};
  if (source) params.source = source;
  return get("/sync", params);
}

/**
 * Returns true if the D1 cache is fresh enough to use (last_synced_at within
 * maxAgeMs for ALL requested sources). Use before deciding to skip gviz calls.
 */
export async function isCacheFresh(
  sources: string[],
  maxAgeMs = 20 * 60 * 1000,   // 20 minutes (> cron interval)
): Promise<boolean> {
  const health = await apiHealth();
  if (!health) return false;
  const now = Date.now();
  return sources.every((name) => {
    const src = health.sources.find((s) => s.source === name);
    return src?.last_synced_at != null && !src.error && now - src.last_synced_at <= maxAgeMs;
  });
}
