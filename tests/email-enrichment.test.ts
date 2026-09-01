import { describe, expect, it } from "vitest";
import { enrichScheduleItemsFromEmail, type ScheduleItem } from "../app/page";

describe("email audit enrichment", () => {
  it("fills blanks only and preserves authoritative sheet values", () => {
    const item = { id: "1", direction: "outbound", date: new Date("2026-08-31"), dateText: "8/31/2026", title: "", reference: "IN123", secondary: "", status: "Scheduled", sourceSheet: "WH Trucking Request", sourceRow: 3, invoice: "IN123", customer: "Sheet Customer" } as ScheduleItem;
    const event = { status: "committed", kind: "outbound", shipmentId: "SHIP9", customer: "Email Customer", invoice: "IN123", blOrPro: "PRO8", container: "", shipDateOrEta: "", carrierOrVessel: "Carrier", note: "Email note", issues: "", sourceEmailUrl: "", driveFileUrl: "", timestamp: "" } as const;
    expect(enrichScheduleItemsFromEmail([item], [event])[0]).toMatchObject({ customer: "Sheet Customer", shipmentNo: "SHIP9", pro: "PRO8", carrier: "Carrier" });
  });
});
