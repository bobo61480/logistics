/**
 * Server-side parcel tracking integrations.
 *
 * Field names and endpoints are normalized here so the browser never needs
 * carrier-specific credentials or response parsing. None of these providers
 * supply dependable GPS coordinates for every scan; app/geo geocodes the
 * returned place name to an approximate map position.
 */

export type Carrier = "ups" | "fedex" | "usps" | "dhl";

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

// Per-isolate OAuth token cache. DHL uses an API key and does not participate.
const tokenCache = new Map<Carrier, { token: string; expiresAt: number }>();

async function getCachedToken(
  carrier: Carrier,
  fetchToken: () => Promise<{ token: string; expiresInSeconds: number }>,
) {
  const cached = tokenCache.get(carrier);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const { token, expiresInSeconds } = await fetchToken();
  tokenCache.set(carrier, { token, expiresAt: Date.now() + expiresInSeconds * 1000 });
  return token;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["message", "Message", "description", "detail", "code"]) {
    const text = typeof record[key] === "string" ? String(record[key]).trim() : "";
    if (text) return text;
  }
  return "";
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
    const token = await upsToken(env);
    const response = await fetch(
      `https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(number)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          transId: crypto.randomUUID(),
          transactionSrc: "stylekorean-logistics",
        },
      },
    );
    if (!response.ok) return { ...base, error: `UPS track failed (${response.status})` };

    const data = (await response.json()) as any;
    const shipment = data?.trackResponse?.shipment?.[0];
    const pkg = shipment?.package?.[0];
    const activity = pkg?.activity?.[0];
    const address = activity?.location?.address;

    // UPS can return HTTP 200 while putting lookup failures such as
    // "Tracking Information Not Found" in shipment.warnings. Do not turn
    // that into a successful empty scan and do not infer delivery from POD/
    // photo fields alone.
    const rawWarnings = shipment?.warnings;
    const warningText = (Array.isArray(rawWarnings) ? rawWarnings : rawWarnings ? [rawWarnings] : [])
      .map(textFromUnknown)
      .filter(Boolean)
      .join("; ");
    if (warningText && (/not found|invalid|unable|error|fail/i.test(warningText) || !activity)) {
      return { ...base, error: `UPS tracking warning: ${warningText}` };
    }
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
      timestamp: activity?.date && activity?.time ? `${activity.date}T${activity.time}` : activity?.date,
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
    const token = await fedexToken(env);
    const response = await fetch("https://apis.fedex.com/track/v1/trackingnumbers", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        includeDetailedScans: true,
        trackingInfo: [{ trackingNumberInfo: { trackingNumber: number } }],
      }),
    });
    if (!response.ok) return { ...base, error: `FedEx track failed (${response.status})` };
    const data = (await response.json()) as any;
    const trackResult = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];
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
    const data = (await response.json()) as { access_token: string; expires_in: number };
    return { token: data.access_token, expiresInSeconds: data.expires_in || 3600 };
  });
}

async function trackUsps(env: Env, number: string): Promise<TrackingResult> {
  const base: TrackingResult = { carrier: "usps", number, ok: false, configured: true };
  try {
    const token = await uspsToken(env);
    const response = await fetch(
      `https://apis.usps.com/tracking/v3/tracking/${encodeURIComponent(number)}?expand=DETAIL`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
    );
    if (!response.ok) return { ...base, error: `USPS track failed (${response.status})` };
    const data = (await response.json()) as any;
    const events = Array.isArray(data?.trackingEvents) ? [...data.trackingEvents] : [];
    events.sort(
      (a, b) =>
        new Date(b?.eventTimestamp ?? 0).getTime() -
        new Date(a?.eventTimestamp ?? 0).getTime(),
    );
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

// ---------------------------------------------------------------- DHL ----

async function trackDhl(env: Env, number: string): Promise<TrackingResult> {
  const base: TrackingResult = { carrier: "dhl", number, ok: false, configured: true };
  try {
    const url = new URL("https://api-eu.dhl.com/track/shipments");
    url.searchParams.set("trackingNumber", number);
    const response = await fetch(url, {
      headers: {
        "DHL-API-Key": env.DHL_API_KEY ?? "",
        accept: "application/json",
      },
    });
    if (!response.ok) return { ...base, error: `DHL track failed (${response.status})` };

    const data = (await response.json()) as any;
    const shipment = Array.isArray(data?.shipments) ? data.shipments[0] : undefined;
    const status = shipment?.status;
    const location = status?.location?.address;
    if (!shipment || !status) return { ...base, error: "DHL tracking information not found" };

    return {
      ...base,
      ok: true,
      status: status?.status ?? status?.description ?? status?.statusCode,
      statusCategory: status?.statusCode,
      city: location?.addressLocality,
      state: location?.administrativeArea,
      postal: location?.postalCode,
      country: location?.countryCode,
      timestamp: status?.timestamp,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : "DHL lookup failed" };
  }
}

// ------------------------------------------------------------- shared ----

export function carrierConfigured(env: Env, carrier: Carrier): boolean {
  if (carrier === "ups") return Boolean(env.UPS_CLIENT_ID && env.UPS_CLIENT_SECRET);
  if (carrier === "fedex") return Boolean(env.FEDEX_CLIENT_ID && env.FEDEX_CLIENT_SECRET);
  if (carrier === "usps") return Boolean(env.USPS_CLIENT_ID && env.USPS_CLIENT_SECRET);
  return Boolean(env.DHL_API_KEY);
}

export async function trackParcel(env: Env, carrier: Carrier, number: string): Promise<TrackingResult> {
  if (!carrierConfigured(env, carrier)) {
    return {
      carrier,
      number,
      ok: false,
      configured: false,
      error: `${carrier.toUpperCase()} tracking is not configured`,
    };
  }
  if (carrier === "ups") return trackUps(env, number);
  if (carrier === "fedex") return trackFedex(env, number);
  if (carrier === "usps") return trackUsps(env, number);
  return trackDhl(env, number);
}
