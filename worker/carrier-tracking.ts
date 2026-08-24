/**
 * Server-side UPS / FedEx / USPS tracking integrations.
 *
 * Field names and endpoints verified against official docs (Aug 2026):
 * - UPS:   activity[0].location.address.{city,stateProvince,countryCode}
 * - FedEx: scanEvents[0].scanLocation.{city,stateOrProvinceCode,countryCode}
 *          (NOT latestStatusDetail.scanLocation — that's frequently empty)
 * - USPS:  trackingEvents[0].{eventCity,eventState,eventCountry}
 *          (legacy XML Web Tools API was retired Jan 25 2026 — v3 REST only)
 *
 * None of the three return coordinates; geocode(city, state, country) in
 * ./geo converts the returned place name to an approximate lat/lng for the
 * map. Each carrier degrades to `configured:false` when its secrets are
 * unset, rather than throwing — the tracking panel shows "not connected"
 * for that carrier instead of erroring the whole map.
 */

export type Carrier = "ups" | "fedex" | "usps";

export type TrackingResult = {
  carrier: Carrier;
  number: string;
  ok: boolean;
  configured: boolean;
  status?: string;
  statusCategory?: string;
  city?: string;
  state?: string;
  postal?: string;
  country?: string;
  timestamp?: string;
  error?: string;
};

// Per-isolate token cache. Best-effort — Workers isolates recycle
// periodically, at which point a fresh token is fetched. This is fine at
// tracking-lookup volumes (a handful of parcels, refreshed occasionally);
// it avoids provisioning a KV namespace just to cache a token.
const tokenCache = new Map<Carrier, { token: string; expiresAt: number }>();

async function getCachedToken(carrier: Carrier, fetchToken: () => Promise<{ token: string; expiresInSeconds: number }>) {
  const cached = tokenCache.get(carrier);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const { token, expiresInSeconds } = await fetchToken();
  tokenCache.set(carrier, { token, expiresAt: Date.now() + expiresInSeconds * 1000 });
  return token;
}

/**
 * Issues an authenticated request; on a 401/403 the cached token is dropped
 * and the request is retried exactly once with a fresh one.
 *
 * Carriers can revoke a token before its advertised `expires_in` (UPS in
 * particular is known for inconsistent "Access Token Not Approved" errors).
 * Without this, a cached-but-dead token would fail every lookup until it
 * expired naturally — up to an hour of silent breakage.
 */
async function fetchWithTokenRetry(
  carrier: Carrier,
  getToken: () => Promise<string>,
  send: (token: string) => Promise<Response>,
): Promise<Response> {
  const response = await send(await getToken());
  if (response.status !== 401 && response.status !== 403) return response;
  tokenCache.delete(carrier);
  return send(await getToken());
}

/**
 * UPS returns `date` as YYYYMMDD and `time` as HHMMSS. Concatenating them
 * raw yields "20260822T113000", which is NOT valid ISO 8601 — `new Date()`
 * returns Invalid Date, so the map popup rendered "Invalid Date" for every
 * UPS parcel. Normalize to YYYY-MM-DDTHH:MM:SS.
 */
export function upsTimestamp(date?: string, time?: string): string | undefined {
  if (!date || !/^\d{8}$/.test(date)) return undefined;
  const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  if (!time || !/^\d{6}$/.test(time)) return isoDate;
  return `${isoDate}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

// ---------------------------------------------------------------- UPS ----

async function upsToken(env: Env): Promise<string> {
  return getCachedToken("ups", async () => {
    const response = await fetch("https://onlinetools.ups.com/security/v1/oauth/token", {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${env.UPS_CLIENT_ID}:${env.UPS_CLIENT_SECRET}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) throw new Error(`UPS OAuth failed (${response.status})`);
    const data = (await response.json()) as { access_token: string; expires_in: string | number };
    return { token: data.access_token, expiresInSeconds: Number(data.expires_in) || 3600 };
  });
}

async function trackUps(env: Env, number: string): Promise<TrackingResult> {
  const base: TrackingResult = { carrier: "ups", number, ok: false, configured: true };
  try {
    const response = await fetchWithTokenRetry("ups", () => upsToken(env), (token) =>
      fetch(`https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(number)}`, {
        headers: {
          authorization: `Bearer ${token}`,
          transId: crypto.randomUUID(),
          transactionSrc: "stylekorean-logistics",
        },
      }),
    );
    if (!response.ok) return { ...base, error: `UPS track failed (${response.status})` };
    const data = (await response.json()) as any;
    const pkg = data?.trackResponse?.shipment?.[0]?.package?.[0];
    const activity = pkg?.activity?.[0];
    const address = activity?.location?.address;
    if (!activity) return { ...base, error: "No tracking activity yet" };
    return {
      ...base,
      ok: true,
      status: pkg?.currentStatus?.description,
      statusCategory: pkg?.currentStatus?.simplifiedTextDescription ?? pkg?.currentStatus?.type,
      city: address?.city,
      state: address?.stateProvince,
      postal: address?.postalCode,
      country: address?.countryCode,
      timestamp: upsTimestamp(activity?.date, activity?.time),
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : "UPS lookup failed" };
  }
}

// -------------------------------------------------------------- FedEx ----

async function fedexToken(env: Env): Promise<string> {
  return getCachedToken("fedex", async () => {
    const response = await fetch("https://apis.fedex.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.FEDEX_CLIENT_ID ?? "",
        client_secret: env.FEDEX_CLIENT_SECRET ?? "",
      }).toString(),
    });
    if (!response.ok) throw new Error(`FedEx OAuth failed (${response.status})`);
    const data = (await response.json()) as { access_token: string; expires_in: number };
    return { token: data.access_token, expiresInSeconds: data.expires_in || 3600 };
  });
}

async function trackFedex(env: Env, number: string): Promise<TrackingResult> {
  const base: TrackingResult = { carrier: "fedex", number, ok: false, configured: true };
  try {
    const response = await fetchWithTokenRetry("fedex", () => fedexToken(env), (token) =>
      fetch("https://apis.fedex.com/track/v1/trackingnumbers", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          includeDetailedScans: true,
          trackingInfo: [{ trackingNumberInfo: { trackingNumber: number } }],
        }),
      }),
    );
    if (!response.ok) return { ...base, error: `FedEx track failed (${response.status})` };
    const data = (await response.json()) as any;
    const trackResult = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];
    // latestStatusDetail.scanLocation is frequently empty; scanEvents[0] is
    // the reliable most-recent-first source for the last known location.
    const scanEvent = trackResult?.scanEvents?.[0];
    const location = scanEvent?.scanLocation;
    if (!scanEvent) return { ...base, error: "No scan events yet" };
    return {
      ...base,
      ok: true,
      status: trackResult?.latestStatusDetail?.statusByLocale ?? trackResult?.latestStatusDetail?.description,
      statusCategory: trackResult?.latestStatusDetail?.derivedCode ?? trackResult?.latestStatusDetail?.code,
      city: location?.city,
      state: location?.stateOrProvinceCode,
      postal: location?.postalCode,
      country: location?.countryCode,
      timestamp: scanEvent?.date,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : "FedEx lookup failed" };
  }
}

// --------------------------------------------------------------- USPS ----

async function uspsToken(env: Env): Promise<string> {
  return getCachedToken("usps", async () => {
    const response = await fetch("https://apis.usps.com/oauth2/v3/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: env.USPS_CLIENT_ID,
        client_secret: env.USPS_CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    });
    if (!response.ok) throw new Error(`USPS OAuth failed (${response.status})`);
    const data = (await response.json()) as { access_token: string; expires_in: number; scope?: string };
    // USPS issues a token even when the app lacks the Tracking product; the
    // failure then surfaces as an opaque 401 on the tracking call itself.
    // Checking the returned scope turns that into an actionable message.
    if (data.scope && !/\btracking\b/i.test(data.scope)) {
      throw new Error("USPS token lacks the 'tracking' scope — add the Tracking product to the USPS app");
    }
    return { token: data.access_token, expiresInSeconds: data.expires_in || 3600 };
  });
}

async function trackUsps(env: Env, number: string): Promise<TrackingResult> {
  const base: TrackingResult = { carrier: "usps", number, ok: false, configured: true };
  try {
    const response = await fetchWithTokenRetry("usps", () => uspsToken(env), (token) =>
      fetch(`https://apis.usps.com/tracking/v3/tracking/${encodeURIComponent(number)}?expand=DETAIL`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      }),
    );
    if (!response.ok) return { ...base, error: `USPS track failed (${response.status})` };
    const data = (await response.json()) as any;
    // USPS doesn't explicitly guarantee event order in the docs; sort
    // defensively by timestamp descending rather than trusting index 0.
    const events = Array.isArray(data?.trackingEvents) ? [...data.trackingEvents] : [];
    events.sort((a, b) => new Date(b?.eventTimestamp ?? 0).getTime() - new Date(a?.eventTimestamp ?? 0).getTime());
    const latest = events[0];
    if (!latest) return { ...base, error: "No tracking events yet" };
    return {
      ...base,
      ok: true,
      status: data?.status,
      statusCategory: data?.statusCategory,
      city: latest?.eventCity,
      state: latest?.eventState,
      postal: latest?.eventZIP,
      country: latest?.eventCountry || "US",
      timestamp: latest?.eventTimestamp,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : "USPS lookup failed" };
  }
}

// ------------------------------------------------------------- shared ----

export function carrierConfigured(env: Env, carrier: Carrier): boolean {
  if (carrier === "ups") return Boolean(env.UPS_CLIENT_ID && env.UPS_CLIENT_SECRET);
  if (carrier === "fedex") return Boolean(env.FEDEX_CLIENT_ID && env.FEDEX_CLIENT_SECRET);
  return Boolean(env.USPS_CLIENT_ID && env.USPS_CLIENT_SECRET);
}

export async function trackParcel(env: Env, carrier: Carrier, number: string): Promise<TrackingResult> {
  if (!carrierConfigured(env, carrier)) {
    return { carrier, number, ok: false, configured: false, error: `${carrier.toUpperCase()} tracking is not configured` };
  }
  if (carrier === "ups") return trackUps(env, number);
  if (carrier === "fedex") return trackFedex(env, number);
  return trackUsps(env, number);
}
