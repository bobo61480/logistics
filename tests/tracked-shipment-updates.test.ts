import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRowIndex,
  detail,
  headline,
  identifiers,
  matchItem,
  priorityFor,
} from "../app/tracked-shipment-updates-card";
import type { GmailIngestionEvent } from "../app/gmail-ingestion-card";
import type { ScheduleItem } from "../app/page";

const css = readFileSync("app/globals.css", "utf8");

function event(overrides: Partial<GmailIngestionEvent> = {}): GmailIngestionEvent {
  return {
    status: "committed",
    kind: "inbound",
    shipmentId: "",
    customer: "",
    invoice: "",
    blOrPro: "",
    container: "",
    shipDateOrEta: "",
    carrierOrVessel: "",
    note: "",
    issues: "",
    sourceEmailUrl: "",
    driveFileUrl: "",
    timestamp: "",
    ...overrides,
  };
}

function item(overrides: Partial<ScheduleItem> = {}): ScheduleItem {
  return {
    id: "item-1",
    direction: "inbound",
    date: new Date("2026-08-23T00:00:00.000Z"),
    dateText: "08/23",
    title: "Shipment",
    reference: "",
    secondary: "",
    status: "Scheduled",
    sourceSheet: "IMPORTS",
    sourceRow: 247,
    ...overrides,
  } as ScheduleItem;
}

describe("Tracked Shipment Updates priority", () => {
  it("treats holds and cancellations as urgent regardless of feed status", () => {
    expect(priorityFor(event({ note: "FDA REVIEW/HOLD — do not distribute" }), true)).toBe("urgent");
    expect(priorityFor(event({ note: "CANCELLED 08/21/26" }), true)).toBe("urgent");
    expect(priorityFor(event({ issues: "Customs clearance still open" }), true)).toBe("urgent");
  });

  it("treats an unfileable review item as urgent even when its wording is calm", () => {
    // Nothing in the workbook matches it, so no operator can action it from
    // the schedule — that is the whole reason it needs surfacing.
    expect(priorityFor(event({ status: "needsReview", note: "Booking confirmed" }), false)).toBe("urgent");
    expect(priorityFor(event({ status: "needsReview", note: "Booking confirmed" }), true)).toBe("high");
  });

  it("treats state changes that still need a workbook edit as high", () => {
    expect(priorityFor(event({ note: "FDA RELEASED 08/21/26; customs clear" }), true)).toBe("high");
    expect(priorityFor(event({ note: "DELIVERED 08/21/26 — close as completed" }), true)).toBe("high");
    expect(priorityFor(event({ note: "Delivery rescheduled to 08/25/26" }), true)).toBe("high");
  });

  it("leaves routine committed traffic on monitor", () => {
    expect(priorityFor(event({ note: "Received: packing list filed" }), true)).toBe("monitor");
  });
});

describe("Tracked Shipment Updates source-row resolution", () => {
  it("matches an event to its live sheet row by container, BL/PRO, or invoice", () => {
    const rows = [
      item({ id: "a", container: "SMCU1040159", sourceSheet: "IMPORTS", sourceRow: 247 }),
      item({ id: "b", pro: "755-384346", sourceSheet: "WH Trucking Request", sourceRow: 647 }),
      item({ id: "c", invoice: "HJ87", sourceSheet: "IMPORTS", sourceRow: 257 }),
    ];
    const index = buildRowIndex(rows);

    expect(matchItem(index, event({ container: "SMCU1040159" }))?.sourceRow).toBe(247);
    // Separators and case differ between email text and the sheet cell.
    expect(matchItem(index, event({ blOrPro: "755384346" }))?.sourceRow).toBe(647);
    expect(matchItem(index, event({ shipmentId: "hj87" }))?.sourceRow).toBe(257);
  });

  it("reports no match rather than guessing when an identifier is ambiguous", () => {
    const index = buildRowIndex([
      item({ id: "a", container: "SMCU1040159", sourceRow: 247 }),
      item({ id: "b", container: "SMCU1040159", sourceRow: 248 }),
    ]);
    expect(matchItem(index, event({ container: "SMCU1040159" }))).toBeNull();
  });

  it("ignores identifiers too short to be distinctive", () => {
    const index = buildRowIndex([item({ id: "a", invoice: "HJ8", sourceRow: 12 })]);
    expect(matchItem(index, event({ invoice: "HJ8" }))).toBeNull();
  });

  it("returns null for an event with nothing to match on", () => {
    const index = buildRowIndex([item({ container: "SMCU1040159" })]);
    expect(matchItem(index, event({ customer: "YAMIBUY NJ" }))).toBeNull();
  });
});

describe("Tracked Shipment Updates row presentation", () => {
  it("labels a row with its two most distinctive identifiers", () => {
    expect(identifiers(event({ shipmentId: "HJ80", container: "SMCU1040159" })))
      .toEqual(["HJ80", "SMCU1040159"]);
    // shipmentId is derived from invoice/BL/container upstream, so the same
    // value must not be printed twice.
    expect(identifiers(event({ shipmentId: "SMCU1040159", container: "SMCU1040159", customer: "YAMIBUY NJ" })))
      .toEqual(["SMCU1040159", "YAMIBUY NJ"]);
    expect(identifiers(event())).toEqual(["Unidentified shipment"]);
  });

  it("strips the pipeline note prefix and keeps one sentence", () => {
    expect(headline(event({ note: "Changed: FDA released 08/21. Ready for delivery scheduling." })))
      .toBe("FDA released 08/21.");
    expect(headline(event({ note: "", issues: "No matching invoice in IMPORTS" })))
      .toBe("No matching invoice in IMPORTS");
    expect(headline(event({ status: "needsReview" }))).toBe("Routed for review");
  });

  it("never repeats the headline in the supporting line", () => {
    // When there is no pipeline note the headline falls back to the issue text,
    // so the issue must not print again underneath it.
    const noNote = event({ issues: "No ETA or ship date found.", carrierOrVessel: "EVER GIVEN" });
    expect(detail(noNote, headline(noNote))).toBe("Carrier EVER GIVEN");

    // With a real note the issue is genuinely extra information and stays.
    const withNote = event({ note: "Changed: FDA released 08/21.", issues: "Entry summary missing" });
    expect(detail(withNote, headline(withNote))).toContain("Entry summary missing");
  });
});

describe("Tracked Shipment Updates styling", () => {
  it("styles the panel and its priority tiers in both themes", () => {
    for (const selector of [
      ".tracked-updates-panel",
      ".tracked-update-headline",
      ".tracked-priority.urgent",
      ".tracked-update-state.missing",
      '[data-theme="dark"] .tracked-updates-panel',
      '[data-theme="dark"] .tracked-priority.urgent',
      '[data-theme="dark"] .tracked-update-detail',
    ]) {
      expect(css).toContain(selector);
    }
  });

  it("collapses the two-column grid on narrow viewports", () => {
    expect(css).toContain(".tracked-updates-grid { grid-template-columns: minmax(0, 1fr); }");
  });
});
