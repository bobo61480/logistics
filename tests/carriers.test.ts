import { describe, expect, it } from "vitest";
import { detectStrongCarrier, resolveCarrier, trackingCandidate } from "../lib/domain/carriers";

describe("parcel carrier resolution", () => {
  it("lets strong tracking evidence override an incorrect source carrier", () => {
    expect(resolveCarrier("FedEx", "1ZR08J349024359054")).toEqual({
      sourceCarrier: "FedEx",
      detectedCarrier: "UPS",
      effectiveCarrier: "UPS",
      confidence: "strong",
    });
  });

  it("preserves the source carrier for ambiguous generic numeric tracking", () => {
    expect(resolveCarrier("FedEx", "4035336068715417909").effectiveCarrier).toBe("FedEx");
    expect(detectStrongCarrier("4035336068715417909")).toBe("");
  });

  it("recognizes strong Amazon, DHL and USPS patterns", () => {
    expect(detectStrongCarrier("TBA123456789012")).toBe("AMAZON");
    expect(detectStrongCarrier("JJD1234567890")).toBe("DHL");
    expect(detectStrongCarrier("9400111899223856928499")).toBe("USPS");
    expect(detectStrongCarrier("EA123456789US")).toBe("USPS");
  });

  it("prefers a strong candidate over an earlier ambiguous numeric value", () => {
    expect(trackingCandidate("4035336068715417909", "1ZR08J349024359054", "")).toBe(
      "1ZR08J349024359054",
    );
  });
});
