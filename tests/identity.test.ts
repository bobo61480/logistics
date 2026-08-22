import { describe, expect, it } from "vitest";
import { normalizeIdentifier, truckingGroupKey } from "../lib/domain/identity";

describe("logistics identity", () => {
  it("normalizes stable identifiers without fuzzy substring matching", () => {
    expect(normalizeIdentifier("  in-00462238 ")).toBe("IN00462238");
    expect(normalizeIdentifier("1Z R08 J34 9024359054")).toBe("1ZR08J349024359054");
  });

  it("keeps the same customer on different exact ship dates separate", () => {
    expect(truckingGroupKey("Korheim (Cerritos)", "2026-08-07")).not.toBe(
      truckingGroupKey("Korheim (Cerritos)", "2026-08-13"),
    );
  });
});
