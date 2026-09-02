import {
  computeKpisFromRows,
  pacificToday,
  selectedMonthBounds,
  type KpiSnapshot,
} from "../lib/kpis/compute";
import { dedupeShipmentRows } from "../lib/domain/dedupe";
import {
  persistSnapshot,
  readCurrentSnapshot,
  readDatabaseHealth,
  type OperationalSnapshot,
} from "./database";
import { fetchOperationalSources, type GmailIngestionEvent } from "./sources";
import { handleStatusCommand } from "./status-command";
import { handlePendingReviewCommand } from "./pending-review-command";
import { handleTrackingCommand } from "./tracking-command";
import { fetchCmsInventory } from "./cms-inventory";
import { fetchCmsImports } from "./cms-imports";
import { fetchCmsSalesKpis } from "./cms-sales-kpis";

const WORKER_VERSION = "2026-09-02-worker-v11-cms-sales-fallback";
const SNAPSHOT_CACHE_URL = "https://stylekorean.internal/api/logistics/snapshot";
const SNAPSHOT_CACHE_SECONDS = 60;
const SNAPSHOT_REFRESH_SECONDS = 15 * 60;

type DatabaseEnv = Env & { DB: D1Database };

function hasDatabase(env: Env): env is DatabaseEnv {
  return "DB" in env;
}

function json(value: unknown, status = 200, cacheControl = "no-store") {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function dedupeObjects<T>(items: T[], keyFor: (item: T) => string) {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function dedupeOperationalPayload(snapshot: Awaited<ReturnType<typeof fetchOperationalSources>>) {
  const startedAt = Date.now();
  const sources = { ...snapshot.sources };
  const rawImports = Array.isArray(sources.imports) ? sources.imports as string[][] : null;
  const rawOutbound = Array.isArray(sources.outbound) ? sources.outbound as string[][] : null;
  const imports = dedupeShipmentRows(rawImports, "inbound");
  const outbound = dedupeShipmentRows(rawOutbound, "outbound");
  sources.imports = rawImports ? imports.rows : null;
  sources.outbound = rawOutbound ? outbound.rows : null;

  if (Array.isArray(sources.gmailIngestion)) {
    sources.gmailIngestion = dedupeObjects<GmailIngestionEvent>(sources.gmailIngestion, (event) => {
      const sourceEmail = String(event.sourceEmailUrl ?? "").trim();
      const shipment = String(event.shipmentId ?? event.container ?? event.invoice ?? event.blOrPro ?? "").trim().toUpperCase();
      const status = String(event.status ?? "").trim().toUpperCase();
      const timestamp = String(event.timestamp ?? "").trim();
      return sourceEmail || [shipment, status, timestamp].join("|");
    });
  }

  const kpiRows = {
    nationalRows: dedupeShipmentRows(snapshot.kpiRows.nationalRows, "generic").rows,
    wmsRows: dedupeShipmentRows(snapshot.kpiRows.wmsRows, "generic").rows,
    truckingRows: dedupeShipmentRows(snapshot.kpiRows.truckingRows, "outbound").rows,
    transferRows: dedupeShipmentRows(snapshot.kpiRows.transferRows, "outbound").rows,
  };

  const totalRemoved = imports.removed + outbound.removed
    + (snapshot.kpiRows.nationalRows.length - kpiRows.nationalRows.length)
    + (snapshot.kpiRows.wmsRows.length - kpiRows.wmsRows.length)
    + (snapshot.kpiRows.truckingRows.length - kpiRows.truckingRows.length)
    + (snapshot.kpiRows.transferRows.length - kpiRows.transferRows.length);

  return {
    ...snapshot,
    sources,
    kpiRows,
    dedupe: {
      removed: totalRemoved,
      importsRemoved: imports.removed,
      importsMerged: imports.merged,
      importsConflicts: imports.conflicts,
      outboundRemoved: outbound.removed,
      outboundMerged: outbound.merged,
      outboundConflicts: outbound.conflicts,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

async function buildSnapshotPayload(env: Env): Promise<OperationalSnapshot> {
  const generatedAt = new Date().toISOString();
  const [raw, cmsInventory, cmsImports, cmsSalesResult] = await Promise.all([
    fetchOperationalSources(env.APPS_SCRIPT_WRITE_URL),
    fetchCmsInventory(env),
    fetchCmsImports(env),
    fetchCmsSalesKpis(env)
      .then((value) => ({ ok: true as const, value }))
      .catch((error) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      })),
  ]);
  raw.sourceHealth.push(cmsInventory.health);
  raw.sourceHealth.push(cmsImports.health);
  const rawSources = raw.sources as Record<string, unknown>;
  rawSources.cmsInventory = cmsInventory.rows;
  rawSources.cmsInventoryConfigured = cmsInventory.configured;
  rawSources.cmsImports = cmsImports.rows;
  rawSources.cmsImportsConfigured = cmsImports.configured;
  const snapshot = dedupeOperationalPayload(raw);
  const outboundMeta = snapshot.sources.outboundMeta as { rowCount?: number } | undefined;
  const hasOutboundRows = Number(outboundMeta?.rowCount ?? 0) > 0;
  if (!Array.isArray(snapshot.sources.imports) || snapshot.sources.imports.length === 0 || !Array.isArray(snapshot.sources.outbound) || !hasOutboundRows) {
    throw new Error("Core Logistics Master sources are unavailable");
  }

  let kpis = null;
  let kpiError = "";
  try {
    kpis = computeKpisFromRows(snapshot.kpiRows);
    if (cmsSalesResult.ok) {
      kpis = {
        ...kpis,
        wmsSalesMtd: cmsSalesResult.value.wmsSalesMtd,
        wmsSalesYtd: cmsSalesResult.value.wmsSalesYtd,
      };
      rawSources.cmsSalesKpis = cmsSalesResult.value;
    } else {
      rawSources.cmsSalesKpis = { ok: false, error: cmsSalesResult.error };
      kpiError = `CMS sales unavailable; WMS sheet fallback active (${cmsSalesResult.error})`;
    }
  } catch (error) {
    kpiError = error instanceof Error ? error.message : String(error);
  }

  console.log(JSON.stringify({ event: "snapshot-deduplicated", ...snapshot.dedupe }));
  return {
    ok: true,
    generatedAt,
    version: WORKER_VERSION,
    sourceHealth: snapshot.sourceHealth,
    sources: snapshot.sources,
    kpis,
    kpiError: kpiError || undefined,
  };
}

async function refreshDatabaseSnapshot(env: DatabaseEnv) {
  const startedAt = Date.now();
  const snapshot = await buildSnapshotPayload(env);
  const persisted = await persistSnapshot(env.DB, snapshot);
  console.log(JSON.stringify({ event: "d1-snapshot-refreshed", generatedAt: snapshot.generatedAt, durationMs: Date.now() - startedAt, ...persisted }));
  return { ...snapshot, storage: "d1" as const, storedAt: new Date().toISOString(), frontendSource: "d1" as const };
}

function snapshotResponse(payload: OperationalSnapshot & Record<string, unknown>) {
  return json(payload, 200, `public, max-age=0, s-maxage=${SNAPSHOT_CACHE_SECONDS}`);
}

function cacheSnapshot(context: ExecutionContext, response: Response) {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cachedResponse = response.clone();
  cachedResponse.headers.set("cache-control", `public, max-age=${SNAPSHOT_REFRESH_SECONDS}`);
  cachedResponse.headers.set("x-stylekorean-cached-at", String(Date.now()));
  context.waitUntil(cache.put(new Request(SNAPSHOT_CACHE_URL), cachedResponse));
}

async function readFreshCache() {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cached = await cache.match(new Request(SNAPSHOT_CACHE_URL));
  if (!cached) return null;
  const cachedAt = Number(cached.headers.get("x-stylekorean-cached-at") || 0);
  if (!cachedAt || Date.now() - cachedAt > SNAPSHOT_CACHE_SECONDS * 1000) return { cached, fresh: false };
  const response = new Response(cached.body, cached);
  response.headers.set("cache-control", "public, max-age=0, must-revalidate");
  response.headers.set("x-stylekorean-cache", "HIT-D1");
  return { cached: response, fresh: true };
}

async function handleSnapshot(env: Env, context: ExecutionContext, forceRefresh = false) {
  if (!hasDatabase(env)) return json({ ok: false, error: "D1 frontend database is not configured", frontendSource: "d1" }, 503);

  if (forceRefresh) {
    try {
      const refreshed = await refreshDatabaseSnapshot(env);
      const response = snapshotResponse({ ...refreshed, forcedRefresh: true, servedAt: new Date().toISOString() });
      cacheSnapshot(context, response);
      response.headers.set("x-stylekorean-cache", "D1-FORCED-REFRESH");
      return response;
    } catch (error) {
      console.error(JSON.stringify({ event: "d1-forced-refresh-failed", error: String(error) }));
      return json({ ok: false, error: "Canonical D1 refresh failed", frontendSource: "d1" }, 503);
    }
  }

  const cacheState = await readFreshCache();
  if (cacheState?.fresh) return cacheState.cached;

  try {
    const stored = await readCurrentSnapshot(env.DB);
    if (stored) {
      const stale = Date.now() - Date.parse(stored.generatedAt) > SNAPSHOT_REFRESH_SECONDS * 1000;
      if (stale) {
        context.waitUntil(refreshDatabaseSnapshot(env).then((refreshed) => {
          const refreshedResponse = snapshotResponse({ ...refreshed, servedAt: new Date().toISOString() });
          cacheSnapshot(context, refreshedResponse);
        }).catch((error) => {
          console.error(JSON.stringify({ event: "d1-background-refresh-failed", error: String(error) }));
        }));
        const response = snapshotResponse({
          ...stored,
          frontendSource: "d1",
          stale: true,
          staleReason: "The durable snapshot is refreshing in the background",
          servedAt: new Date().toISOString(),
        });
        response.headers.set("x-stylekorean-cache", "D1-STALE-WHILE-REVALIDATE");
        response.headers.set("warning", '110 - "Response is stale"');
        return response;
      }
      const response = snapshotResponse({ ...stored, frontendSource: "d1", servedAt: new Date().toISOString() });
      cacheSnapshot(context, response);
      response.headers.set("x-stylekorean-cache", "D1");
      return response;
    }

    const initial = await refreshDatabaseSnapshot(env);
    const response = snapshotResponse({ ...initial, servedAt: new Date().toISOString() });
    cacheSnapshot(context, response);
    response.headers.set("x-stylekorean-cache", "D1-INITIALIZED");
    return response;
  } catch (error) {
    console.error(JSON.stringify({ event: "d1-snapshot-unavailable", error: String(error) }));
    return json({ ok: false, error: "D1 frontend database is unavailable", frontendSource: "d1" }, 503);
  }
}

async function handleHealth(env: Env) {
  let databaseState: "unbound" | "initializing" | "ready" | "unavailable" = "unbound";
  let databaseAgeSeconds: number | undefined;
  if (hasDatabase(env)) {
    try {
      const health = await readDatabaseHealth(env.DB);
      databaseState = health.ready ? "ready" : "initializing";
      databaseAgeSeconds = health.ready ? health.ageSeconds : undefined;
    } catch (error) {
      databaseState = "unavailable";
      console.error(JSON.stringify({ event: "d1-health-summary-failed", error: String(error) }));
    }
  }
  return json({
    ok: databaseState === "ready",
    service: "stylekorean-logistics-control-tower",
    version: WORKER_VERSION,
    dataStore: "Cloudflare D1",
    frontendSource: "d1",
    googleSheetsRole: "synchronized operational source",
    accessPolicy: "public",
    databaseConfigured: hasDatabase(env),
    databaseReady: databaseState === "ready",
    databaseState,
    databaseAgeSeconds,
    deduplication: "enabled-before-d1-publish",
    statusWriteMode: "strict Google Sheets + D1 dual write",
    statusWriteAuthentication: "none",
    statusWriteRateLimit: "30 requests per 60 seconds per client IP and Cloudflare location",
    checkedAt: new Date().toISOString(),
  }, databaseState === "ready" ? 200 : 503);
}

async function handleReconciliation(env: Env) {
  if (!hasDatabase(env)) return json({ ok: false, databaseConfigured: false, ready: false, frontendSource: "d1" }, 503);
  try {
    return json({ ok: true, databaseConfigured: true, frontendSource: "d1", ...(await readDatabaseHealth(env.DB)) });
  } catch (error) {
    console.error(JSON.stringify({ event: "d1-health-read-failed", error: String(error) }));
    return json({ ok: false, databaseConfigured: true, ready: false, frontendSource: "d1", error: "Database health is unavailable" }, 503);
  }
}

function cmsSalesError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return json({ ok: false, error: code }, code === "KPI_MONTH_INVALID" ? 400 : 502);
}

type CmsSalesResult =
  | { ok: true; value: Awaited<ReturnType<typeof fetchCmsSalesKpis>> }
  | { ok: false; error: string };

export function resolveSalesKpiSource(sheetKpis: KpiSnapshot, cmsSales: CmsSalesResult) {
  if (cmsSales.ok) {
    return {
      source: cmsSales.value.source,
      currency: cmsSales.value.currency,
      fallback: false,
      gatewayError: undefined,
      kpis: {
        ...sheetKpis,
        wmsSalesMtd: cmsSales.value.wmsSalesMtd,
        wmsSalesYtd: cmsSales.value.wmsSalesYtd,
      },
      cms: cmsSales.value,
    };
  }
  return {
    source: "wms-sheet-fallback" as const,
    currency: "USD",
    fallback: true,
    gatewayError: cmsSales.error,
    kpis: sheetKpis,
    cms: null,
  };
}

async function loadMonthlyKpis(env: Env, selectedMonth?: string) {
  const now = new Date();
  const today = pacificToday();
  const { monthKey } = selectedMonthBounds(today, selectedMonth);
  const [raw, cmsSales] = await Promise.all([
    fetchOperationalSources(env.APPS_SCRIPT_WRITE_URL),
    fetchCmsSalesKpis(env, now, fetch, monthKey)
      .then((value): CmsSalesResult => ({ ok: true, value }))
      .catch((error): CmsSalesResult => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })),
  ]);
  const snapshot = dedupeOperationalPayload(raw);
  const sheetKpis = computeKpisFromRows({
    ...snapshot.kpiRows,
    today,
    selectedMonth: monthKey,
  });
  const resolved = resolveSalesKpiSource(sheetKpis, cmsSales);
  return { ...resolved, month: resolved.cms?.selectedMonth ?? monthKey, generatedAt: now.toISOString() };
}

async function handleCmsSalesKpis(request: Request, env: Env) {
  try {
    const month = new URL(request.url).searchParams.get("month")?.trim() || undefined;
    const result = await loadMonthlyKpis(env, month);
    return json({
      ok: true,
      source: result.source,
      selectedMonth: result.month,
      currency: result.currency,
      wmsSalesMtd: result.kpis.wmsSalesMtd,
      wmsSalesYtd: result.kpis.wmsSalesYtd,
      invoiceCountMtd: result.cms?.invoiceCountMtd ?? null,
      invoiceCountYtd: result.cms?.invoiceCountYtd ?? null,
      months: result.cms?.months ?? [],
      generatedAt: result.generatedAt,
      fallback: result.fallback,
      gatewayError: result.gatewayError,
    });
  } catch (error) {
    return cmsSalesError(error);
  }
}

async function handleMonthlyKpis(request: Request, env: Env) {
  try {
    const month = new URL(request.url).searchParams.get("month")?.trim() || undefined;
    const result = await loadMonthlyKpis(env, month);
    return json({
      ok: true,
      month: result.month,
      currency: result.currency,
      source: result.source,
      fallback: result.fallback,
      gatewayError: result.gatewayError,
      kpis: result.kpis,
    });
  } catch (error) {
    return cmsSalesError(error);
  }
}

// Public fulfillment (sk-b2b-mobile WMS) Apps Script endpoint. Kept as a
// fallback so the proxy works even if the wrangler var is not yet deployed;
// this URL is already public (it shipped in the client bundle before the
// browser was moved behind this proxy), so it is not a secret.
const DEFAULT_FULFILLMENT_GAS_URL =
  "https://script.google.com/macros/s/AKfycbykK9DWjem9ORHxfR_mpdZl5DVh-en0D6JpCdIuel305QmfqxoNU_NqSnjkhFk401hI/exec";

// Same-origin proxy for the live fulfillment feed. The frontend reads it only
// through the Worker (never the browser calling Apps Script directly), keeping
// every operational read same-origin. It is a live passthrough rather than a
// D1-cached projection because fulfillment status (picking/inspection) is
// real-time and a 15-minute snapshot cadence would render it stale; writes are
// forwarded to the same endpoint and rate-limited like other write paths.
async function handleFulfillment(request: Request, env: Env): Promise<Response> {
  const target = env.FULFILLMENT_GAS_URL || DEFAULT_FULFILLMENT_GAS_URL;
  const proxyJson = (body: string, status: number) =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  try {
    if (request.method === "GET") {
      const upstream = new URL(target);
      new URL(request.url).searchParams.forEach((value, key) => upstream.searchParams.set(key, value));
      const res = await fetch(upstream.toString(), { cache: "no-store", signal: AbortSignal.timeout(25_000) });
      return proxyJson(await res.text(), res.ok ? 200 : 502);
    }
    if (request.method === "POST") {
      // Fulfillment writes (setManualPackingMoved / saveDimensions) mutate WMS
      // state, so reject cross-site requests up front — matching the status,
      // review, and tracking write paths — before forwarding or spending rate.
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(request.url).origin) return json({ ok: false, error: "Cross-origin fulfillment writes are not allowed" }, 403);
      if (request.headers.get("sec-fetch-site") === "cross-site") return json({ ok: false, error: "Cross-site fulfillment writes are not allowed" }, 403);
      const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
      const rateLimit = await env.STATUS_WRITE_RATE_LIMITER.limit({ key: `fulfillment-write:${clientIp}` });
      if (!rateLimit.success) return json({ ok: false, error: "Fulfillment write rate limit exceeded" }, 429);
      const res = await fetch(target, {
        method: "POST",
        body: await request.text(),
        headers: { "content-type": request.headers.get("content-type") || "application/x-www-form-urlencoded;charset=UTF-8" },
        signal: AbortSignal.timeout(25_000),
      });
      return proxyJson(await res.text(), res.ok ? 200 : 502);
    }
    return json({ ok: false, error: "Method not allowed" }, 405);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502);
  }
}

function withSecurityHeaders(response: Response) {
  const secured = new Response(response.body, response);
  secured.headers.set("content-security-policy", "base-uri 'self'; frame-ancestors 'none'; object-src 'none'");
  secured.headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  secured.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  secured.headers.set("strict-transport-security", "max-age=31536000");
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("x-frame-options", "DENY");
  return secured;
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === "/api/logistics/snapshot") {
      if (request.method !== "GET") {
        response = json({ ok: false, error: "Method not allowed" }, 405);
      } else {
        const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.has("scheduled_refresh");
        if (forceRefresh) {
          const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
          const rateLimit = await env.STATUS_WRITE_RATE_LIMITER.limit({ key: `snapshot-refresh:${clientIp}` });
          response = rateLimit.success
            ? await handleSnapshot(env, context, true)
            : json({ ok: false, error: "Snapshot refresh rate limit exceeded" }, 429);
        } else {
          response = await handleSnapshot(env, context, false);
        }
      }
    } else if (url.pathname === "/api/logistics/cms-sales-kpis") {
      response = request.method === "GET" ? await handleCmsSalesKpis(request, env) : json({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname === "/api/logistics/monthly-kpis") {
      response = request.method === "GET" ? await handleMonthlyKpis(request, env) : json({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname === "/api/logistics/reconciliation") {
      response = request.method === "GET" ? await handleReconciliation(env) : json({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname === "/api/logistics/status") {
      response = await handleStatusCommand(request, env, context);
    } else if (url.pathname === "/api/logistics/pending-review") {
      response = await handlePendingReviewCommand(request, env, context);
    } else if (url.pathname === "/api/logistics/tracking") {
      response = await handleTrackingCommand(request, env);
    } else if (url.pathname === "/api/logistics/fulfillment") {
      response = await handleFulfillment(request, env);
    } else if (url.pathname === "/api/logistics/health") {
      response = request.method === "GET" ? await handleHealth(env) : json({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname.startsWith("/api/")) {
      response = json({ ok: false, error: "API route not found" }, 404);
    } else {
      response = await env.ASSETS.fetch(request);
    }
    return withSecurityHeaders(response);
  },

  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    if (!hasDatabase(env)) {
      console.error(JSON.stringify({ event: "d1-scheduled-refresh-skipped", reason: "binding-not-configured" }));
      return;
    }
    context.waitUntil(refreshDatabaseSnapshot(env).catch((error) => {
      console.error(JSON.stringify({ event: "d1-scheduled-refresh-failed", error: String(error) }));
      throw error;
    }));
  },
} satisfies ExportedHandler<Env>;
