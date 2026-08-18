import { describe, expect, it } from "vitest";
import { deriveGmailIngestion } from "../worker/sources";

// GvizTable shaped like parseGviz output: header labels in cols, data in rows.
function gvizTable(header: string[], rows: string[][]) {
  return {
    cols: header.map((label) => ({ label })),
    rows: rows.map((row) => ({ c: row.map((value) => ({ v: value })) })),
  };
}

const PENDING_HEADER = [
  "Timestamp",
  "Kind",
  "Status",
  "Issues",
  "Customer",
  "Invoice / PI",
  "BL / PRO",
  "Container",
  "Ship Date / ETA",
  "Qty",
  "Carrier / Vessel",
  "Note",
  "Source Email",
  "Drive File",
  "Raw JSON",
];

describe("deriveGmailIngestion", () => {
  it("returns committed events for rows carrying the GmailPipeline [auto: …] tag", () => {
    const importsRows = [
      ["SHIPMENT", "CUSTOMER", "INVOICE", "B/L", "CONTAINER", "ETA", "VESSEL", "NOTE"],
      ["HJ90", "ACME", "IN001", "MBL1", "MSKU0000001", "8/20/2026", "EVER ACE", "[auto: https://mail.google.com/mail/u/0/#all/abc123] arrived early"],
      ["HJ91", "OTHER", "IN002", "", "", "8/21/2026", "", "manually entered"],
    ];
    const events = deriveGmailIngestion({
      importsRows,
      outboundRows: null,
      pendingVerificationTable: null,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "committed",
      kind: "inbound",
      shipmentId: "IN001",
      customer: "ACME",
      container: "MSKU0000001",
      sourceEmailUrl: "https://mail.google.com/mail/u/0/#all/abc123",
      note: "arrived early",
    });
  });

  it("tags outbound rows with the outbound kind and falls back through invoice → BL → container for the shipment id", () => {
    const outboundRows = [
      ["CUSTOMER", "PRO", "NOTE"],
      ["ULTA", "PRO777", "[auto: https://mail.google.com/mail/u/0/#all/xyz]"],
    ];
    const events = deriveGmailIngestion({
      importsRows: null,
      outboundRows,
      pendingVerificationTable: null,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "outbound", shipmentId: "PRO777", blOrPro: "PRO777" });
  });

  it("returns nothing when the sheet has no recognizable note column", () => {
    const rows = [
      ["CUSTOMER", "INVOICE"],
      ["ACME", "IN001 [auto: https://mail.google.com/mail/u/0/#all/abc]"],
    ];
    expect(
      deriveGmailIngestion({ importsRows: rows, outboundRows: null, pendingVerificationTable: null }),
    ).toEqual([]);
  });

  it("maps PENDING VERIFICATION rows with their review status, links, and timestamp", () => {
    const table = gvizTable(PENDING_HEADER, [
      [
        "2026-08-17 09:15",
        "inbound",
        "NEEDS REVIEW",
        "No ETA or ship date found.",
        "ACME",
        "IN003",
        "MBL3",
        "TEMU1234567",
        "",
        "1,200",
        "EVER GIVEN",
        "from PDF",
        "https://mail.google.com/mail/u/0/#all/pending1",
        "https://drive.google.com/file/d/xyz",
        "{}",
      ],
      ["2026-08-16 14:00", "outbound", "APPROVED", "", "ULTA", "IN004", "", "", "8/22/2026", "", "", "", "", "", "{}"],
      ["2026-08-15 10:00", "outbound", "REJECTED", "Customer is missing.", "", "", "", "", "", "", "", "", "", "", "{}"],
    ]);

    const events = deriveGmailIngestion({
      importsRows: null,
      outboundRows: null,
      pendingVerificationTable: table,
    });

    expect(events.map((event) => event.status)).toEqual(["needsReview", "approved", "rejected"]);
    expect(events[0]).toMatchObject({
      kind: "inbound",
      shipmentId: "IN003",
      issues: "No ETA or ship date found.",
      sourceEmailUrl: "https://mail.google.com/mail/u/0/#all/pending1",
      driveFileUrl: "https://drive.google.com/file/d/xyz",
      timestamp: "2026-08-17 09:15",
    });
  });

  it("lists pending events before committed ones and degrades gracefully with no pending table", () => {
    const importsRows = [
      ["NOTE", "INVOICE"],
      ["[auto: https://mail.google.com/mail/u/0/#all/c1]", "IN010"],
    ];
    const table = gvizTable(PENDING_HEADER, [
      ["2026-08-17", "inbound", "NEEDS REVIEW", "x", "", "IN011", "", "", "", "", "", "", "", "", "{}"],
    ]);

    const both = deriveGmailIngestion({ importsRows, outboundRows: null, pendingVerificationTable: table });
    expect(both.map((event) => event.status)).toEqual(["needsReview", "committed"]);

    const committedOnly = deriveGmailIngestion({ importsRows, outboundRows: null, pendingVerificationTable: null });
    expect(committedOnly.map((event) => event.status)).toEqual(["committed"]);
  });

  it("caps the feed at 200 events", () => {
    const table = gvizTable(
      PENDING_HEADER,
      Array.from({ length: 260 }, (_, index) => [
        `2026-08-${(index % 28) + 1}`,
        "inbound",
        "NEEDS REVIEW",
        "",
        `Customer ${index}`,
        `IN${index}`,
        "", "", "", "", "", "", "", "", "{}",
      ]),
    );
    const events = deriveGmailIngestion({ importsRows: null, outboundRows: null, pendingVerificationTable: table });
    expect(events).toHaveLength(200);
  });
});
