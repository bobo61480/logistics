import { describe, expect, it } from "vitest";
import { inboundScheduleDateSource } from "../lib/domain/inbound-schedule";

describe("inbound schedule date source", () => {
  it("uses Delivery Expected when a receiving appointment exists", () => {
    expect(inboundScheduleDateSource("08/28/2026", "08/25/2026")).toBe("08/28/2026");
  });

  it("falls back to ETA while Delivery Expected is blank", () => {
    expect(inboundScheduleDateSource("", "08/25/2026")).toBe("08/25/2026");
    expect(inboundScheduleDateSource("   ", "09/05/2026")).toBe("09/05/2026");
  });
});
