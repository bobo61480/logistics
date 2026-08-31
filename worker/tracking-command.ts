import { carrierConfigured, trackParcel, type Carrier, type TrackingResult } from "./carrier-tracking";

const MAX_REQUESTS = 25;
const MAX_BODY_BYTES = 4_096;
const CACHE_TTL_SECONDS = 15 * 60;
const CARRIERS: Carrier[] = ["ups", "fedex", "usps", "dhl"];

function json(value: unknown, status = 200, extraHeaders?: HeadersInit) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...extraHeaders } });
}

function cacheKeyFor(request: Request, carrier: Carrier, number: string) {
  const url = new URL(request.url);
  return new Request(`${url.origin}/__cache/tracking/${carrier}/${encodeURIComponent(number)}`);
}

export async function handleTrackingCommand(request: Request, env: Env) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ ok: false, error: "Cross-origin tracking requests are not allowed" }, 403);
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ ok: false, error: "Cross-site tracking requests are not allowed" }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ ok: false, error: "Content-Type must be application/json" }, 415);
  }
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown";

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "Request is too large" }, 413);
  }
  let parsed: { requests?: Array<{ carrier?: string; number?: string }> };
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const requested = Array.isArray(parsed.requests) ? parsed.requests.slice(0, MAX_REQUESTS) : [];
  const valid = requested.filter(
    (entry): entry is { carrier: Carrier; number: string } =>
      typeof entry?.number === "string" &&
      entry.number.trim().length > 0 &&
      entry.number.length <= 40 &&
      typeof entry?.carrier === "string" &&
      CARRIERS.includes(entry.carrier as Carrier),
  );

  const cache = (caches as unknown as { default: Cache }).default;
  const results: TrackingResult[] = await Promise.all(
    valid.map(async ({ carrier, number }) => {
      const normalizedNumber = number.trim();
      const cacheKey = cacheKeyFor(request, carrier, normalizedNumber);
      const cached = await cache.match(cacheKey);
      if (cached) return (await cached.json()) as TrackingResult;

      const rateLimit = await env.STATUS_WRITE_RATE_LIMITER.limit({ key: `tracking:${clientIp}` });
      if (!rateLimit.success) {
        return {
          carrier,
          number: normalizedNumber,
          ok: false,
          configured: true,
          error: "Tracking rate limit exceeded. Try again in a minute.",
        };
      }

      const result = await trackParcel(env, carrier, normalizedNumber);
      if (result.ok) {
        const response = Response.json(result, {
          headers: { "cache-control": `public, max-age=${CACHE_TTL_SECONDS}` },
        });
        await cache.put(cacheKey, response.clone());
      }
      return result;
    }),
  );

  return json({
    ok: true,
    results,
    configured: Object.fromEntries(
      CARRIERS.map((carrier) => [carrier, carrierConfigured(env, carrier)]),
    ),
  });
}
