import { afterEach, describe, expect, it, vi } from "vitest";
import { trackParcel } from "../worker/carrier-tracking";

afterEach(() => vi.unstubAllGlobals());

describe("official carrier tracking", () => {
  it("maps the latest DHL checkpoint into the shared live-map result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      shipments: [{
        status: { description: "In transit", statusCode: "transit" },
        events: [
          { timestamp: "2026-08-25T10:00:00-07:00", description: "Processed", location: { address: { addressLocality: "Phoenix", addressRegion: "AZ", postalCode: "85001", countryCode: "US" } } },
        ],
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await trackParcel({ DHL_API_KEY: "test-key" } as Env, "dhl", "JJD1234567890");

    expect(result).toMatchObject({ ok: true, carrier: "dhl", status: "In transit", city: "Phoenix", state: "AZ", country: "US" });
    expect(result.trackingUrl).toContain("dhl.com");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ href: expect.stringContaining("api-eu.dhl.com/track/shipments") }),
      expect.objectContaining({ headers: expect.objectContaining({ "DHL-API-Key": "test-key" }) }),
    );
  });

  it("does not invent DHL tracking when the API key is absent", async () => {
    await expect(trackParcel({} as Env, "dhl", "JJD1234567890")).resolves.toMatchObject({
      ok: false,
      configured: false,
    });
  });
});
