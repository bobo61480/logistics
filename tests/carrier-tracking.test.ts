import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { upsTimestamp } from "../worker/carrier-tracking";

const source = readFileSync("worker/carrier-tracking.ts", "utf8");

describe("UPS timestamp normalization", () => {
  it("converts UPS YYYYMMDD + HHMMSS into a parseable ISO 8601 string", () => {
    // Regression guard: concatenating raw UPS date+time produced
    // "20260822T113000", which JS parses as Invalid Date — every UPS parcel
    // popup on the live map rendered "Invalid Date".
    const value = upsTimestamp("20260822", "113000");
    expect(value).toBe("2026-08-22T11:30:00");
    expect(Number.isNaN(new Date(value!).getTime())).toBe(false);
  });

  it("falls back to a date-only ISO string when time is absent or malformed", () => {
    expect(upsTimestamp("20260822")).toBe("2026-08-22");
    expect(upsTimestamp("20260822", "bogus")).toBe("2026-08-22");
    expect(Number.isNaN(new Date(upsTimestamp("20260822")!).getTime())).toBe(false);
  });

  it("returns undefined rather than a bad date when UPS sends nothing usable", () => {
    expect(upsTimestamp(undefined, "113000")).toBeUndefined();
    expect(upsTimestamp("8/22/2026", "113000")).toBeUndefined();
  });
});

describe("carrier field paths match the verified API specs", () => {
  it("reads each carrier's documented state field (they all differ)", () => {
    expect(source).toContain("address?.stateProvince"); // UPS
    expect(source).toContain("location?.stateOrProvinceCode"); // FedEx
    expect(source).toContain("latest?.eventState"); // USPS
  });

  it("uses FedEx scanEvents[0] and never the usually-empty latestStatusDetail.scanLocation", () => {
    expect(source).toContain("trackResult?.scanEvents?.[0]");
    expect(source).not.toContain("latestStatusDetail?.scanLocation");
  });

  it("sorts USPS events defensively instead of trusting array order", () => {
    // USPS docs never guarantee most-recent-first ordering.
    expect(source).toContain("events.sort(");
    expect(source).toContain("eventTimestamp");
  });

  it("retries once with a fresh token when a carrier rejects with 401/403", () => {
    expect(source).toContain("function fetchWithTokenRetry");
    expect(source).toContain("tokenCache.delete(carrier)");
    expect(source).toContain('fetchWithTokenRetry("ups"');
    expect(source).toContain('fetchWithTokenRetry("fedex"');
    expect(source).toContain('fetchWithTokenRetry("usps"');
  });
});
