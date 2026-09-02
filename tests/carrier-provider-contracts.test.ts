import { afterEach, describe, expect, it, vi } from "vitest";
import { trackParcel } from "../worker/carrier-tracking";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("carrier provider contracts", () => {
  it("normalizes DHL Unified status and secured address fields", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain("https://api-eu.dhl.com/track/shipments");
      expect(url).toContain("trackingNumber=JD014600006281234567");
      expect(new Headers(init?.headers).get("DHL-API-Key")).toBe("dhl-test-key");
      return new Response(JSON.stringify({
        shipments: [{
          status: {
            timestamp: "2026-08-31T18:20:00Z",
            statusCode: "transit",
            statusDetailed: "Processed at DHL facility",
            location: {
              address: {
                addressLocality: "Cincinnati",
                addressRegion: "OH",
                postalCode: "45202",
                countryCode: "US",
              },
            },
          },
          events: [],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await trackParcel(
      { DHL_API_KEY: "dhl-test-key" } as Env,
      "dhl",
      "JD014600006281234567",
    );

    expect(result).toMatchObject({
      ok: true,
      configured: true,
      carrier: "dhl",
      number: "JD014600006281234567",
      status: "Processed at DHL facility",
      statusCategory: "transit",
      city: "Cincinnati",
      state: "OH",
      postal: "45202",
      country: "US",
      timestamp: "2026-08-31T18:20:00Z",
    });
  });

  it("does not turn a UPS HTTP 200 tracking warning into a no-activity state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/security/v1/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "ups-token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        trackResponse: {
          shipment: [{
            warnings: [{ code: "TW0001", message: "Tracking Information Not Found" }],
            package: [{ activity: [] }],
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await trackParcel(
      { UPS_CLIENT_ID: "id", UPS_CLIENT_SECRET: "secret" } as Env,
      "ups",
      "1Z999AA10123456784",
    );

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain("Tracking Information Not Found");
    expect(result.error).not.toBe("No tracking activity yet");
  });
});
