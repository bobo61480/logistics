import { describe, expect, it } from "vitest";
import {
  canAutoTransitionStatus,
  isTerminalLogisticsStatus,
  normalizeLogisticsStatus,
} from "../lib/domain/status";

describe("logistics status normalization", () => {
  it("normalizes FDA/FWS aliases to the strict spreadsheet vocabulary", () => {
    expect(normalizeLogisticsStatus("FDA Review/Hold")).toBe("FDA Review / Hold");
    expect(normalizeLogisticsStatus("FDA HOLD")).toBe("FDA Review / Hold");
    expect(normalizeLogisticsStatus("FWS review")).toBe("FWS Review / Hold");
  });

  it("keeps terminal states from regressing automatically", () => {
    expect(isTerminalLogisticsStatus("received")).toBe(true);
    expect(canAutoTransitionStatus("Received", "Shipping")).toBe(false);
    expect(canAutoTransitionStatus("Shipping", "Delivered")).toBe(true);
  });

  it("rejects unknown free text", () => {
    expect(normalizeLogisticsStatus("maybe delivered soon")).toBe("");
  });
});
