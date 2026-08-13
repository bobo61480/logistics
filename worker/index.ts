import { computeKpisFromRows } from "../lib/kpis/compute";
import {
  persistSnapshot,
  readCurrentSnapshot,
  readDatabaseHealth,
  type OperationalSnapshot,
} from "./database";
import { fetchOperationalSources } from "./sources";
import { handleStatusCommand } from "./status-command";

const WORKER_VERSION = "2026-08-13-worker-v8-public-guardrails";
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

async function buildSnapshotPayload(): Promise<OperationalSnapshot> {
  const generatedAt = new Date().toISOString();
  const snapshot = await fetchOperationalSources();
  const outboundMeta = snapshot.sources.outboundMeta as { rowCount?: number } | undefined;
  const hasOutboundRows = Number(outboundMeta?.rowCount ?? 0) > 0;
  if (!snapshot.sources.imports || !hasOutboundRows) {
    throw new Error("Core Logistics Master sources are unavailable");
  }

  let kpis = null;
  let kpiError = "";
  try {
    kpis = computeKpisFromRows(snapshot.kpiRows);
  } catch (error) {
    kpiError = error instanceof Error ? error.message : String(error);
  }

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
  const snapshot = await buildSnapshotPayload();
  const persisted = await persistSnapshot(env.DB, snapshot);
  console.log(JSON.stringify({
    event: "d1-snapshot-refreshed",
    generatedAt: snapshot.generatedAt,
    durationMs: Date.now() - startedAt,
    ...persisted,
  }));
  return { ...snapshot, storage: "d1" as const, storedAt: new Date().toISOString() };
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
  response.headers.set("x-stylekorean-cache", "HIT");
  return { cached: response, fresh: true };
}

async function handleSnapshot(env: Env, context: ExecutionContext) {
  const cacheState = await readFreshCache();
  if (cacheState?.fresh) return cacheState.cached;

  if (hasDatabase(env)) {
    try {
      const stored = await readCurrentSnapshot(env.DB);
      if (stored) {
        const ageMs = Date.now() - Date.parse(stored.generatedAt);
        const stale = ageMs > SNAPSHOT_REFRESH_SECONDS * 1000;
        if (stale) {
          context.waitUntil(refreshDatabaseSnapshot(env).catch((error) => {
            console.error(JSON.stringify({ event: "d1-background-refresh-failed", error: String(error) }));
          }));
        }
        const response = snapshotResponse({
          ...stored,
          stale: stale || undefined,
          staleReason: stale ? "The durable snapshot is refreshing in the background" : undefined,
          servedAt: new Date().toISOString(),
        });
        cacheSnapshot(context, response);
        response.headers.set("x-stylekorean-cache", "D1");
        if (stale) response.headers.set("warning", '110 - "Response is stale"');
        return response;
      }

      const initialPayload = await buildSnapshotPayload();
      context.waitUntil(persistSnapshot(env.DB, initialPayload).then((result) => {
        console.log(JSON.stringify({ event: "d1-snapshot-initialized", generatedAt: initialPayload.generatedAt, ...result }));
      }).catch((error) => {
        console.error(JSON.stringify({ event: "d1-initialization-failed", error: String(error) }));
      }));
      const initial = snapshotResponse({ ...initialPayload, storage: "sheets", databaseInitializing: true });
      cacheSnapshot(context, initial);
      initial.headers.set("x-stylekorean-cache", "D1-INITIALIZING");
      return initial;
    } catch (error) {
      console.error(JSON.stringify({ event: "d1-snapshot-read-failed", error: String(error) }));
    }
  }

  try {
    const live = snapshotResponse({ ...(await buildSnapshotPayload()), storage: "sheets" });
    cacheSnapshot(context, live);
    live.headers.set("x-stylekorean-cache", hasDatabase(env) ? "D1-FALLBACK" : "MISS");
    return live;
  } catch (error) {
    const payload = cacheState?.cached
      ? await cacheState.cached.clone().json().catch(() => null) as Record<string, unknown> | null
      : null;
    if (payload?.ok === true) {
      const response = json({
        ...payload,
        stale: true,
        staleReason: error instanceof Error ? error.message : "Live sources are temporarily unavailable",
        servedAt: new Date().toISOString(),
      });
      response.headers.set("warning", '110 - "Response is stale"');
      response.headers.set("x-stylekorean-cache", "STALE");
      return response;
    }
    return json({ ok: false, generatedAt: new Date().toISOString(), error: "Core Logistics Master sources are unavailable" }, 503);
  }
}

function handleHealth(env: Env) {
  return json({
    ok: true,
    service: "stylekorean-logistics-control-tower",
    version: WORKER_VERSION,
    dataStore: hasDatabase(env) ? "Cloudflare D1 + Google Sheets fallback" : "Google Sheets",
    databaseConfigured: hasDatabase(env),
    accessPolicy: "public",
    statusWriteConfigured: Boolean(env.APPS_SCRIPT_WRITE_URL),
    statusWriteMode: "Apps Script source-confirmed proxy",
    statusWriteAuthentication: "none",
    statusWriteRateLimit: "30 requests per 60 seconds per client IP and Cloudflare location",
    checkedAt: new Date().toISOString(),
  });
}

async function handleReconciliation(env: Env) {
  if (!hasDatabase(env)) {
    return json({ ok: true, databaseConfigured: false, ready: false, activationRequired: true });
  }
  try {
    return json({ ok: true, databaseConfigured: true, ...(await readDatabaseHealth(env.DB)) });
  } catch (error) {
    console.error(JSON.stringify({ event: "d1-health-read-failed", error: String(error) }));
    return json({ ok: false, databaseConfigured: true, ready: false, error: "Database health is unavailable" }, 503);
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
      response = request.method === "GET"
        ? await handleSnapshot(env, context)
        : json({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname === "/api/logistics/reconciliation") {
      response = request.method === "GET"
        ? await handleReconciliation(env)
        : json({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname === "/api/logistics/status") {
      response = await handleStatusCommand(request, env, context);
    } else if (url.pathname === "/api/logistics/health") {
      response = request.method === "GET"
        ? handleHealth(env)
        : json({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname.startsWith("/api/")) {
      response = json({ ok: false, error: "API route not found" }, 404);
    } else {
      response = await env.ASSETS.fetch(request);
    }
    return withSecurityHeaders(response);
  },

  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    if (!hasDatabase(env)) {
      console.log(JSON.stringify({ event: "d1-scheduled-refresh-skipped", reason: "binding-not-configured" }));
      return;
    }
    context.waitUntil(refreshDatabaseSnapshot(env).catch((error) => {
      console.error(JSON.stringify({ event: "d1-scheduled-refresh-failed", error: String(error) }));
      throw error;
    }));
  },
} satisfies ExportedHandler<Env>;
