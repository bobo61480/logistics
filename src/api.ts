/**
 * src/api.ts
 * Route handlers for all /api/* endpoints.
 *
 * Routes:
 *   GET /api/health          — sync_log status for all sources
 *   GET /api/sync[?source=]  — trigger a sync (full or single source)
 *   GET /api/imports         — raw imports rows (+ optional ?status=active&limit=N)
 *   GET /api/freight         — freight_moves (+ ?since=YYYYMMDD&type=trucking|transfer)
 *   GET /api/sales           — sales_entries (+ ?source=wms|nationals&since=YYYYMMDD)
 *   GET /api/fulfillment     — fulfillment_tk_jobs (+ ?status=…)
 *   GET /api/kpis            — computed KPIs from D1 (mirrors KpiSnapshot shape)
 */

import { syncAll } from "./sync/index";

export interface Env {
  LOGISTICS_DB: D1Database;
  ASSETS: Fetcher;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function err(msg: string, status = 400): Response {
  return json({ ok: false, error: msg }, status);
}

// ── /api/health ─────────────────────────────────────────────────────────────
async function handleHealth(env: Env): Promise<Response> {
  const { results } = await env.LOGISTICS_DB.prepare(
    "SELECT source, last_synced_at, row_count, error FROM sync_log ORDER BY source"
  ).all<{ source: string; last_synced_at: number | null; row_count: number | null; error: string | null }>();
  return json({ ok: true, sources: results });
}

// ── /api/sync ────────────────────────────────────────────────────────────────
async function handleSync(url: URL, env: Env): Promise<Response> {
  const source = (url.searchParams.get("source") ?? undefined) as Parameters<typeof syncAll>[1];
  const result = await syncAll(env.LOGISTICS_DB, source);
  return json(result);
}

// ── /api/imports ─────────────────────────────────────────────────────────────
async function handleImports(url: URL, env: Env): Promise<Response> {
  const status = url.searchParams.get("status"); // "active" | any status string
  const limit  = Math.min(Number(url.searchParams.get("limit") || 500), 2000);

  let query = "SELECT * FROM imports";
  const bindings: unknown[] = [];

  if (status === "active") {
    query += " WHERE status NOT IN ('Delivered','Received','Cancelled','Completed')";
  } else if (status) {
    query += " WHERE status = ?";
    bindings.push(status);
  }
  query += " ORDER BY source_row LIMIT ?";
  bindings.push(limit);

  const stmt = env.LOGISTICS_DB.prepare(query);
  const { results } = await (bindings.length
    ? stmt.bind(...bindings)
    : stmt
  ).all();

  return json({ ok: true, count: results.length, items: results });
}

// ── /api/freight ─────────────────────────────────────────────────────────────
async function handleFreight(url: URL, env: Env): Promise<Response> {
  const since = Number(url.searchParams.get("since") || 0);
  const type  = url.searchParams.get("type"); // "trucking" | "transfer" | null
  const limit = Math.min(Number(url.searchParams.get("limit") || 2000), 5000);

  const parts: string[] = [];
  const bindings: unknown[] = [];
  if (since) { parts.push("date_code >= ?"); bindings.push(since); }
  if (type)  { parts.push("move_type = ?");  bindings.push(type);  }

  const where = parts.length ? " WHERE " + parts.join(" AND ") : "";
  const { results } = await env.LOGISTICS_DB.prepare(
    `SELECT * FROM freight_moves${where} ORDER BY date_code DESC LIMIT ?`
  ).bind(...bindings, limit).all();

  return json({ ok: true, count: results.length, items: results });
}

// ── /api/sales ────────────────────────────────────────────────────────────────
async function handleSales(url: URL, env: Env): Promise<Response> {
  const source = url.searchParams.get("source"); // "wms" | "nationals" | null
  const since  = Number(url.searchParams.get("since") || 0);
  const limit  = Math.min(Number(url.searchParams.get("limit") || 5000), 20000);

  const parts: string[] = [];
  const bindings: unknown[] = [];
  if (source) { parts.push("source = ?");      bindings.push(source); }
  if (since)  { parts.push("date_code >= ?");  bindings.push(since);  }

  const where = parts.length ? " WHERE " + parts.join(" AND ") : "";
  const { results } = await env.LOGISTICS_DB.prepare(
    `SELECT * FROM sales_entries${where} ORDER BY date_code DESC LIMIT ?`
  ).bind(...bindings, limit).all();

  return json({ ok: true, count: results.length, items: results });
}

// ── /api/fulfillment ──────────────────────────────────────────────────────────
async function handleFulfillment(url: URL, env: Env): Promise<Response> {
  const status = url.searchParams.get("status");
  const limit  = Math.min(Number(url.searchParams.get("limit") || 200), 1000);

  const where  = status ? " WHERE status = ?" : "";
  const { results } = await env.LOGISTICS_DB.prepare(
    `SELECT * FROM fulfillment_tk_jobs${where} ORDER BY ship_date DESC LIMIT ?`
  ).bind(...(status ? [status, limit] : [limit])).all();

  return json({ ok: true, count: results.length, items: results });
}

// ── /api/kpis ────────────────────────────────────────────────────────────────
async function handleKpis(env: Env): Promise<Response> {
  const db = env.LOGISTICS_DB;

  // Determine YTD/MTD boundaries using Pacific time.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  const today     = v.year * 10_000 + v.month * 100 + v.day;
  const yearStart = v.year * 10_000 + 101;
  const monthStart= v.year * 10_000 + v.month * 100 + 1;

  const [
    nationalsYtd, nationalsMtd,
    wmsYtd, wmsMtd,
    freightRows, transferRows,
  ] = await Promise.all([
    db.prepare("SELECT SUM(amount_usd) AS total FROM sales_entries WHERE source='nationals' AND date_code>=? AND date_code<=?").bind(yearStart, today).first<{total:number}>(),
    db.prepare("SELECT SUM(amount_usd) AS total FROM sales_entries WHERE source='nationals' AND date_code>=? AND date_code<=?").bind(monthStart, today).first<{total:number}>(),
    db.prepare("SELECT SUM(amount_usd) AS total FROM sales_entries WHERE source='wms' AND date_code>=? AND date_code<=?").bind(yearStart, today).first<{total:number}>(),
    db.prepare("SELECT SUM(amount_usd) AS total FROM sales_entries WHERE source='wms' AND date_code>=? AND date_code<=?").bind(monthStart, today).first<{total:number}>(),
    db.prepare("SELECT carrier,cost_usd,load_type,distance_band,is_nj_transfer,move_type,date_code FROM freight_moves WHERE date_code>=? AND date_code<=?").bind(yearStart, today).all<{carrier:string;cost_usd:number;load_type:string;distance_band:string;is_nj_transfer:number;move_type:string;date_code:number}>(),
    db.prepare("SELECT cost_usd,is_nj_transfer,date_code FROM freight_moves WHERE move_type='transfer' AND date_code>=? AND date_code<=?").bind(yearStart, today).all<{cost_usd:number;is_nj_transfer:number;date_code:number}>(),
  ]);

  const freight = freightRows.results;
  const transfers = transferRows.results;

  // Carrier aggregation (trucking only, top 3 by move count)
  const carriers = new Map<string, { name: string; earnings: number; moves: number }>();
  let ltl = 0; let ftl = 0;
  let shippingYtd = 0; let shippingMtd = 0;
  let transfersYtd = 0; let transfersMtd = 0;
  let njTransferYtd = 0; let njTransferMtd = 0;

  for (const row of freight) {
    shippingYtd += row.cost_usd;
    if (row.date_code >= monthStart) shippingMtd += row.cost_usd;
    if (row.move_type === "transfer") {
      transfersYtd += row.cost_usd;
      if (row.date_code >= monthStart) transfersMtd += row.cost_usd;
      if (row.is_nj_transfer) {
        njTransferYtd += row.cost_usd;
        if (row.date_code >= monthStart) njTransferMtd += row.cost_usd;
      }
    } else {
      // Trucking only for LTL/FTL split and carrier stats
      if (row.load_type === "FTL") ftl++; else ltl++;
      if (row.carrier) {
        const key = row.carrier.toUpperCase();
        const c = carriers.get(key) ?? { name: row.carrier, earnings: 0, moves: 0 };
        c.earnings += row.cost_usd; c.moves++;
        carriers.set(key, c);
      }
    }
  }

  const total = ltl + ftl;
  const topCarriers = [...carriers.values()]
    .sort((a: {moves:number;earnings:number}, b: {moves:number;earnings:number}) => b.moves - a.moves || b.earnings - a.earnings)
    .slice(0, 3)
    .map((c: {name:string;earnings:number;moves:number}) => ({ ...c, shipmentPercent: total ? Math.round((c.moves / total) * 1000) / 10 : 0 }));

  // Lane averages (trucking only)
  const avgBand = (band: string) => {
    const rows = freight.filter((r) => r.move_type !== "transfer" && r.distance_band === band && r.cost_usd > 0);
    return rows.length ? rows.reduce((s, r) => s + r.cost_usd, 0) / rows.length : 0;
  };
  const avgBandMtd = (band: string) => {
    const rows = freight.filter((r) => r.move_type !== "transfer" && r.distance_band === band && r.cost_usd > 0 && r.date_code >= monthStart);
    return rows.length ? rows.reduce((s, r) => s + r.cost_usd, 0) / rows.length : 0;
  };

  return json({
    ok: true,
    nationalsSalesYtd: nationalsYtd?.total ?? 0,
    nationalsSalesMtd: nationalsMtd?.total ?? 0,
    wmsSalesYtd:       wmsYtd?.total ?? 0,
    wmsSalesMtd:       wmsMtd?.total ?? 0,
    shippingYtd, shippingMtd,
    transfersYtd, transfersMtd,
    njTransferYtd, njTransferMtd,
    topCarriers,
    ltlPercent: total ? Math.round((ltl / total) * 100) : 0,
    ftlPercent: total ? Math.round((ftl / total) * 100) : 0,
    avgLocal:         avgBand("local"),
    avgCalifornia:    avgBand("california"),
    avgOutOfState:    avgBand("out-of-state"),
    avgLocalMtd:      avgBandMtd("local"),
    avgCaliforniaMtd: avgBandMtd("california"),
    avgOutOfStateMtd: avgBandMtd("out-of-state"),
  });
}

// ── Main dispatcher ────────────────────────────────────────────────────────────
export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "");

  try {
    if (path === "/health")      return handleHealth(env);
    if (path === "/sync")        return handleSync(url, env);
    if (path === "/imports")     return handleImports(url, env);
    if (path === "/freight")     return handleFreight(url, env);
    if (path === "/sales")       return handleSales(url, env);
    if (path === "/fulfillment") return handleFulfillment(url, env);
    if (path === "/kpis")        return handleKpis(env);
    return err("Unknown API route", 404);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}
