import { computeKpisFromRows } from "../lib/kpis/compute";
import { fetchOperationalSources } from "./sources";
import { handleStatusCommand } from "./status-command";

const WORKER_VERSION = "2026-08-12-worker-v4-resilient-snapshot";
const SNAPSHOT_CACHE_URL = "https://stylekorean.internal/api/logistics/snapshot";
const SNAPSHOT_CACHE_SECONDS = 60;
const SNAPSHOT_STALE_SECONDS = 15 * 60;

function json(value: unknown, status = 200, cacheControl = "no-store") {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function buildSnapshot() {
  const generatedAt = new Date().toISOString();
  const snapshot = await fetchOperationalSources();
  const coreOk = Boolean(snapshot.sources.imports && snapshot.sources.outbound);
  if (!coreOk) {
    return json({ ok: false, generatedAt, error: "Core Logistics Master sources are unavailable", sourceHealth: snapshot.sourceHealth }, 503);
  }

  let kpis = null;
  let kpiError = "";
  try {
    kpis = computeKpisFromRows(snapshot.kpiRows);
  } catch (error) {
    kpiError = error instanceof Error ? error.message : String(error);
  }

  return json({
    ok: true,
    generatedAt,
    version: WORKER_VERSION,
    sourceHealth: snapshot.sourceHealth,
    sources: snapshot.sources,
    kpis,
    kpiError: kpiError || undefined,
  }, 200, `public, max-age=0, s-maxage=${SNAPSHOT_CACHE_SECONDS}`);
}

async function handleSnapshot(context: ExecutionContext) {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cacheKey = new Request(SNAPSHOT_CACHE_URL);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedAt = Number(cached.headers.get("x-stylekorean-cached-at") || 0);
    if (cachedAt && Date.now() - cachedAt <= SNAPSHOT_CACHE_SECONDS * 1000) {
      const response = new Response(cached.body, cached);
      response.headers.set("cache-control", "public, max-age=0, must-revalidate");
      response.headers.set("x-stylekorean-cache", "HIT");
      return response;
    }

    const refreshed = await buildSnapshot();
    if (refreshed.ok) {
      const cachedResponse = refreshed.clone();
      cachedResponse.headers.set("cache-control", `public, max-age=${SNAPSHOT_STALE_SECONDS}`);
      cachedResponse.headers.set("x-stylekorean-cached-at", String(Date.now()));
      context.waitUntil(cache.put(cacheKey, cachedResponse));
      refreshed.headers.set("x-stylekorean-cache", "REFRESH");
      return refreshed;
    }

    const failed = await refreshed.clone().json().catch(() => null) as { error?: string } | null;
    const payload = await cached.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (payload?.ok === true) {
      const response = json({
        ...payload,
        stale: true,
        staleReason: failed?.error || "Live sources are temporarily unavailable",
        servedAt: new Date().toISOString(),
      });
      response.headers.set("warning", '110 - "Response is stale"');
      response.headers.set("x-stylekorean-cache", "STALE");
      return response;
    }
  }

  const response = await buildSnapshot();
  if (response.ok) {
    const cachedResponse = response.clone();
    cachedResponse.headers.set("cache-control", `public, max-age=${SNAPSHOT_STALE_SECONDS}`);
    cachedResponse.headers.set("x-stylekorean-cached-at", String(Date.now()));
    context.waitUntil(cache.put(cacheKey, cachedResponse));
  }
  response.headers.set("x-stylekorean-cache", "MISS");
  return response;
}

function handleHealth(env: Env) {
  return json({
    ok: true,
    service: "stylekorean-logistics-control-tower",
    version: WORKER_VERSION,
    dataStore: "Google Sheets",
    statusWriteConfigured: Boolean(env.APPS_SCRIPT_WRITE_URL),
    statusWriteMode: "Apps Script source-confirmed proxy",
    checkedAt: new Date().toISOString(),
  });
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
        ? await handleSnapshot(context)
        : json({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname === "/api/logistics/status") {
      response = await handleStatusCommand(request, env);
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
} satisfies ExportedHandler<Env>;
