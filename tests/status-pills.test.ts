import { describe, expect, it } from "vitest";
import { statusClass } from "../app/page";
import { LOGISTICS_STATUS_OPTIONS } from "../lib/domain/status";

describe("statusClass: 5-bucket pill classification", () => {
  const EXPECTED: Record<string, string> = {
    Scheduled: "status neutral",
    "Work in Progress": "status neutral",
    Pending: "status warn",
    Shipping: "status neutral",
    Shipped: "status good",
    Delivered: "status good",
    Received: "status good",
    Cancelled: "status stop",
    Completed: "status good",
    "N/A": "status neutral",
    "Customs Clearance": "status hold",
    "FDA Review / Hold": "status hold",
    "FWS Review / Hold": "status hold",
    "FDA Detained": "status hold",
    "AQI Examination": "status hold",
    Delayed: "status warn",
  };

  it("maps every canonical LOGISTICS_STATUS_OPTIONS value to exactly one of the 5 pill buckets, with no gaps", () => {
    expect(LOGISTICS_STATUS_OPTIONS.length).toBe(16);
    for (const status of LOGISTICS_STATUS_OPTIONS) {
      expect(EXPECTED).toHaveProperty(status);
      expect(statusClass(status)).toBe(EXPECTED[status]);
    }
  });

  it("this test's own expectation table covers every canonical status (no drift if the canonical list grows)", () => {
    const expectedKeys = Object.keys(EXPECTED).sort();
    const actualKeys = [...LOGISTICS_STATUS_OPTIONS].sort();
    expect(expectedKeys).toEqual(actualKeys);
  });

  it("classifies each bucket to a distinct, valid CSS class", () => {
    const buckets = new Set(Object.values(EXPECTED));
    expect(buckets).toEqual(new Set(["status neutral", "status warn", "status hold", "status good", "status stop"]));
  });
});
