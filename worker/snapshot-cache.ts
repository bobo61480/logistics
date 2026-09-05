/**
 * worker/snapshot-cache.ts
 * Edge cache in front of the D1 frontend snapshot.
 *
 * D1 remains the authority; this only avoids re-materializing an unchanged
 * snapshot on every request. Kept in its own module so both the read path and
 * the status writeback path can reach it without a circular import.
 */

const SNAPSHOT_CACHE_URL = "https://stylekorean.internal/api/logistics/snapshot";
export const SNAPSHOT_CACHE_SECONDS = 60;
export const SNAPSHOT_REFRESH_SECONDS = 15 * 60;

function edgeCache() {
  return (caches as CacheStorage & { default: Cache }).default;
}

function cacheKey() {
  return new Request(SNAPSHOT_CACHE_URL);
}

export function cacheSnapshot(context: ExecutionContext, response: Response) {
  const cachedResponse = response.clone();
  cachedResponse.headers.set("cache-control", `public, max-age=${SNAPSHOT_REFRESH_SECONDS}`);
  cachedResponse.headers.set("x-stylekorean-cached-at", String(Date.now()));
  context.waitUntil(edgeCache().put(cacheKey(), cachedResponse));
}

export async function readFreshCache() {
  const cached = await edgeCache().match(cacheKey());
  if (!cached) return null;
  const cachedAt = Number(cached.headers.get("x-stylekorean-cached-at") || 0);
  if (!cachedAt || Date.now() - cachedAt > SNAPSHOT_CACHE_SECONDS * 1000) return { cached, fresh: false };
  const response = new Response(cached.body, cached);
  response.headers.set("cache-control", "public, max-age=0, must-revalidate");
  response.headers.set("x-stylekorean-cache", "HIT-D1");
  return { cached: response, fresh: true };
}

/**
 * Drops the cached snapshot so the next read re-materializes it from D1.
 * Called after a confirmed status writeback: the relational row is already
 * updated, and without this the operator would keep seeing the pre-write value
 * for the remainder of the cache window.
 */
export function invalidateSnapshotCache(context: ExecutionContext) {
  context.waitUntil(edgeCache().delete(cacheKey()).catch(() => false));
}
