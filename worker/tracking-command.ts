import { carrierConfigured, trackParcel, type Carrier, type TrackingResult } from "./carrier-tracking";

const MAX_REQUESTS = 25;
const MAX_BODY_BYTES = 4_096;
const CACHE_TTL_SECONDS = 15 * 60; // last-known location doesn't need to be fetched every pageview
const CARRIERS: Carrier[] = ["ups", "fedex", "usps"];
// UPS documents inquiryNumber as 7–34 characters and rejects anything else.
// FedEx/USPS don't publish an explicit bound, so those keep a permissive
// range that still filters out obvious junk before burning an API call.
const NUMBER_LENGTH: Record<Carrier, { min: number; max: number }> = {
  ups: { min: 7, max: 34 },
  fedex: { min: 8, max: 40 },
  usps: { min: 8, max: 40 },
};

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
  const rateLimit = await env.STATUS_WRITE_RATE_LIMITER.limit({ key: `tracking:${clientIp}` });
  if (!rateLimit.success) {
    return json({ ok: false, error: "Tracking rate limit exceeded. Try again in a minute." }, 429, { "retry-after": "60" });
  }

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
  const valid = requested.filter((entry): entry is { carrier: Carrier; number: string } => {
    if (typeof entry?.carrier !== "string" || !CARRIERS.includes(entry.carrier as Carrier)) return false;
    if (typeof entry?.number !== "string") return false;
    const trimmed = entry.number.trim();
    const bounds = NUMBER_LENGTH[entry.carrier as Carrier];
    return trimmed.length >= bounds.min && trimmed.length <= bounds.max;
  });

  const cache = (caches as unknown as { default: Cache }).default;
  const results: TrackingResult[] = await Promise.all(
    valid.map(async ({ carrier, number }) => {
      const cacheKey = cacheKeyFor(request, carrier, number);
      const cached = await cache.match(cacheKey);
      if (cached) return (await cached.json()) as TrackingResult;

      const result = await trackParcel(env, carrier, number);
      if (result.ok) {
        const response = Response.json(result, { headers: { "cache-control": `public, max-age=${CACHE_TTL_SECONDS}` } });
        await cache.put(cacheKey, response.clone());
      }
      return result;
    }),
  );

  return json({
    ok: true,
    results,
    configured: Object.fromEntries(CARRIERS.map((carrier) => [carrier, carrierConfigured(env, carrier)])),
  });
}
