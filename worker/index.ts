import { computeKpisFromRows } from "../lib/kpis/compute";
import { fetchOperationalSources } from "./sources";
import { handleStatusCommand } from "./status-command";

const WORKER_VERSION = "2026-08-12-worker-v3-routed-integrity";
const SNAPSHOT_CACHE_URL = "https://stylekorean.internal/api/logistics/snapshot";
const SNAPSHOT_CACHE_SECONDS = 60;

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
    const response = new Response(cached.body, cached);
    response.headers.set("x-stylekorean-cache", "HIT");
    return response;
  }

  const response = await buildSnapshot();
  if (response.ok) {
    const cachedResponse = response.clone();
    cachedResponse.headers.set("cache-control", `public, max-age=${SNAPSHOT_CACHE_SECONDS}`);
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
    databaseConfigured: false,
    statusWriteConfigured: Boolean(env.APPS_SCRIPT_WRITE_URL),
    statusWriteMode: "Apps Script source-confirmed proxy",
    checkedAt: new Date().toISOString(),
  });
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/logistics/snapshot") {
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleSnapshot(context);
    }
    if (url.pathname === "/api/logistics/status") return handleStatusCommand(request, env);
    if (url.pathname === "/api/logistics/health") {
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleHealth(env);
    }
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "API route not found" }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
