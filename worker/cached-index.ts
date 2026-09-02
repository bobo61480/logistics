import baseHandler from "./index";

const FULFILLMENT_CACHE_KEY = "sales-overview";
const DEFAULT_FULFILLMENT_GAS_URL =
  "https://script.google.com/macros/s/AKfycbykK9DWjem9ORHxfR_mpdZl5DVh-en0D6JpCdIuel305QmfqxoNU_NqSnjkhFk401hI/exec";
const BACKGROUND_REFRESH_AFTER_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 20 * 60 * 1000;
const MAX_LIVE_CACHE_AGE_MS = 2 * 60 * 60 * 1000;

type DatabaseEnv = Env & { DB: D1Database };

type FulfillmentPayload = {
  ok: true;
  jobs: unknown[];
  [key: string]: unknown;
};

type FulfillmentCacheRow = {
  payload_json: string;
  job_count: number;
  source_url: string;
  updated_at: string;
};

type LiveCache = {
  payload: FulfillmentPayload;
  updatedAt: string;
  sourceUrl: string;
};

function hasDatabase(env: Env): env is DatabaseEnv {
  return "DB" in env;
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

function json(value: unknown, status = 200) {
  return withSecurityHeaders(Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  }));
}

function validatePayload(value: unknown): FulfillmentPayload {
  if (!value || typeof value !== "object") throw new Error("Fulfillment source returned a non-object payload");
  const payload = value as { ok?: unknown; jobs?: unknown };
  if (payload.ok !== true) throw new Error("Fulfillment source rejected the overview request");
  if (!Array.isArray(payload.jobs)) throw new Error("Fulfillment source returned no jobs array");
  if (payload.jobs.length === 0) throw new Error("Fulfillment source returned an empty jobs array");
  return value as FulfillmentPayload;
}

async function readLiveCache(env: Env): Promise<LiveCache | null> {
  if (!hasDatabase(env)) return null;
  try {
    const row = await env.DB.prepare(`SELECT payload_json, job_count, source_url, updated_at
      FROM fulfillment_live_cache WHERE cache_key = ?`)
      .bind(FULFILLMENT_CACHE_KEY)
      .first<FulfillmentCacheRow>();
    if (!row) return null;
    const payload = validatePayload(JSON.parse(row.payload_json));
    if (payload.jobs.length !== row.job_count) throw new Error("Fulfillment cache job count failed integrity validation");
    return { payload, updatedAt: row.updated_at, sourceUrl: row.source_url };
  } catch (error) {
    console.error(JSON.stringify({ event: "fulfillment-live-cache-read-failed", error: String(error) }));
    return null;
  }
}

async function writeLiveCache(env: Env, payload: FulfillmentPayload, sourceUrl: string) {
  if (!hasDatabase(env)) throw new Error("Fulfillment live cache D1 binding is not configured");
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO fulfillment_live_cache
    (cache_key, payload_json, job_count, source_url, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      job_count = excluded.job_count,
      source_url = excluded.source_url,
      updated_at = excluded.updated_at`)
    .bind(FULFILLMENT_CACHE_KEY, JSON.stringify(payload), payload.jobs.length, sourceUrl, updatedAt)
    .run();
  return { payload, updatedAt, sourceUrl } satisfies LiveCache;
}

async function fetchLiveOverview(env: Env, timeoutMs = 55_000): Promise<LiveCache> {
  const target = env.FULFILLMENT_GAS_URL || DEFAULT_FULFILLMENT_GAS_URL;
  const url = new URL(target);
  url.searchParams.set("op", "getSalesOverview");
  url.searchParams.set("t", String(Date.now()));
  const startedAt = Date.now();
  const response = await fetch(url.toString(), {
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Fulfillment live source HTTP ${response.status}`);
  const payload = validatePayload(await response.json());
  const cached = await writeLiveCache(env, payload, target);
  console.log(JSON.stringify({
    event: "fulfillment-live-cache-refreshed",
    jobs: payload.jobs.length,
    durationMs: Date.now() - startedAt,
    updatedAt: cached.updatedAt,
  }));
  return cached;
}

function liveCacheResponse(cache: LiveCache, options: { stale?: boolean; warning?: string } = {}) {
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(cache.updatedAt)) / 1000));
  return json({
    ...cache.payload,
    source: "fulfillment-live-cache",
    liveSource: true,
    cached: true,
    stale: options.stale === true,
    cacheUpdatedAt: cache.updatedAt,
    cacheAgeSeconds: ageSeconds,
    warning: options.warning,
  });
}

async function handleCachedFulfillment(request: Request, env: Env, context: ExecutionContext) {
  const url = new URL(request.url);
  const op = url.searchParams.get("op")?.trim() || "getSalesOverview";
  if (request.method !== "GET" || op !== "getSalesOverview") return null;

  const forceRefresh = url.searchParams.get("refresh") === "1";
  if (forceRefresh) {
    const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
    const rateLimit = await env.STATUS_WRITE_RATE_LIMITER.limit({ key: `fulfillment-cache-refresh:${clientIp}` });
    if (!rateLimit.success) return json({ ok: false, error: "Fulfillment cache refresh rate limit exceeded" }, 429);
    try {
      const live = await fetchLiveOverview(env, 55_000);
      return json({
        ...live.payload,
        source: "fulfillment-live",
        liveSource: true,
        cached: false,
        cacheUpdatedAt: live.updatedAt,
        cacheAgeSeconds: 0,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const cached = await readLiveCache(env);
      if (cached) return liveCacheResponse(cached, { stale: true, warning: `Live refresh failed: ${reason}` });
      return json({ ok: false, error: reason }, 502);
    }
  }

  const cached = await readLiveCache(env);
  if (!cached) {
    // Do not make the browser wait for Google's cold start. The base Worker will
    // return its WMS/D1 safety feed while a real fulfillment refresh continues
    // independently and seeds the durable cache for the next request.
    context.waitUntil(fetchLiveOverview(env).catch((error) => {
      console.error(JSON.stringify({ event: "fulfillment-live-cache-initial-refresh-failed", error: String(error) }));
    }));
    return null;
  }

  const ageMs = Math.max(0, Date.now() - Date.parse(cached.updatedAt));
  if (ageMs >= BACKGROUND_REFRESH_AFTER_MS) {
    context.waitUntil(fetchLiveOverview(env).catch((error) => {
      console.error(JSON.stringify({ event: "fulfillment-live-cache-background-refresh-failed", error: String(error) }));
    }));
  }

  if (ageMs <= MAX_LIVE_CACHE_AGE_MS) {
    return liveCacheResponse(cached, {
      stale: ageMs > STALE_AFTER_MS,
      warning: ageMs > STALE_AFTER_MS
        ? "The last authoritative fulfillment snapshot is older than 20 minutes and is refreshing in the background."
        : undefined,
    });
  }

  // A very old live cache should not masquerade as current. Let the base Worker
  // provide its clearly degraded WMS fallback while the refresh continues.
  return null;
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/logistics/fulfillment") {
      const cached = await handleCachedFulfillment(request, env, context);
      if (cached) return cached;
    }
    return baseHandler.fetch(request, env, context);
  },

  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext) {
    if (baseHandler.scheduled) await baseHandler.scheduled(controller, env, context);
    context.waitUntil(fetchLiveOverview(env).catch((error) => {
      console.error(JSON.stringify({ event: "fulfillment-live-cache-scheduled-refresh-failed", error: String(error) }));
    }));
  },
} satisfies ExportedHandler<Env>;
