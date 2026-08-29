import { computeKpisFromRows } from "../lib/kpis/compute";
import { dedupeShipmentRows } from "../lib/domain/dedupe";
import {
  persistSnapshot,
  readCurrentSnapshot,
  readDatabaseHealth,
  type OperationalSnapshot,
} from "./database";
import { fetchOperationalSources } from "./sources";
import { handleStatusCommand } from "./status-command";
import { handlePendingReviewCommand } from "./pending-review-command";
import { handleTrackingCommand } from "./tracking-command";

const WORKER_VERSION = "2026-08-29-worker-v9-d1-canonical-dedupe";
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
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const key = keyFor(items[index]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(items[index]);
  }
  return output.reverse();
}

function dedupeOperationalPayload(snapshot: Awaited<ReturnType<typeof fetchOperationalSources>>) {
  const startedAt = Date.now();
  const sources = { ...snapshot.sources };
  const imports = dedupeShipmentRows(sources.imports as string[][] | null, "inbound");
  const outbound = dedupeShipmentRows(sources.outbound as string[][] | null, "outbound");
  sources.imports = imports.rows;
  sources.outbound = outbound.rows;

  if (Array.isArray(sources.gmailIngestion)) {
    sources.gmailIngestion = dedupeObjects(sources.gmailIngestion as Array<Record<string, unknown>>, (event) => {
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
  const raw = await fetchOperationalSources(env.APPS_SCRIPT_WRITE_URL);
  const snapshot = dedupeOperationalPayload(raw);
  const outboundMeta = snapshot.sources.outboundMeta as { rowCount?: number } | undefined;
  const hasOutboundRows = Number(outboundMeta?.rowCount ?? 0) > 0;
  if (!snapshot.sources.imports || !hasOutboundRows) throw new Error("Core Logistics Master sources are unavailable");

  let kpis = null;
  let kpiError = "";
  try {
    kpis = computeKpisFromRows(snapshot.kpiRows);
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

async function handleSnapshot(env: Env, context: ExecutionContext) {
  if (!hasDatabase(env)) return json({ ok: false, error: "D1 frontend database is not configured", frontendSource: "d1" }, 503);
  const cacheState = await readFreshCache();
  if (cacheState?.fresh) return cacheState.cached;

  try {
    const stored = await readCurrentSnapshot(env.DB);
    if (stored) {
      const stale = Date.now() - Date.parse(stored.generatedAt) > SNAPSHOT_REFRESH_SECONDS * 1000;
      if (stale) {
        try {
          const refreshed = await refreshDatabaseSnapshot(env);
          const response = snapshotResponse({ ...refreshed, servedAt: new Date().toISOString() });
          cacheSnapshot(context, response);
          response.headers.set("x-stylekorean-cache", "D1-REFRESHED");
          return response;
        } catch (error) {
          console.error(JSON.stringify({ event: "d1-foreground-refresh-failed", error: String(error) }));
          const response = snapshotResponse({
            ...stored,
            frontendSource: "d1",
            stale: true,
            staleReason: error instanceof Error ? error.message : "D1 refresh failed",
            servedAt: new Date().toISOString(),
          });
          response.headers.set("x-stylekorean-cache", "D1-STALE");
          response.headers.set("warning", '110 - "Response is stale"');
          return response;
        }
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
    databaseConfigured: hasDatabase(env),
    databaseReady: databaseState === "ready",
    databaseState,
    databaseAgeSeconds,
    deduplication: "enabled-before-d1-publish",
    statusWriteMode: "strict Google Sheets + D1 dual write",
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
      response = request.method === "GET" ? await handleSnapshot(env, context) : json({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname === "/api/logistics/reconciliation") {
      response = request.method === "GET" ? await handleReconciliation(env) : json({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname === "/api/logistics/status") {
      response = await handleStatusCommand(request, env, context);
    } else if (url.pathname === "/api/logistics/pending-review") {
      response = await handlePendingReviewCommand(request, env, context);
    } else if (url.pathname === "/api/logistics/tracking") {
      response = await handleTrackingCommand(request, env);
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
