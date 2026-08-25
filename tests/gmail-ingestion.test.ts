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
  "Sender",
  "Documents",
  "Archive Folder",
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

  it("maps PENDING VERIFICATION rows with their review status, links, and timestamp — newest first", () => {
    // Validation.gs appends rows chronologically, so the sheet is oldest-first.
    const table = gvizTable(PENDING_HEADER, [
      ["2026-08-15 10:00", "outbound", "REJECTED", "Customer is missing.", "", "", "", "", "", "", "", "", "", "", "{}"],
      ["2026-08-16 14:00", "outbound", "APPROVED", "", "ULTA", "IN004", "", "", "8/22/2026", "", "", "", "", "", "{}"],
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

  it("exposes the sender captured in the pending row raw record", () => {
    const row = ["2026-08-17", "inbound", "COMMITTED", "", "", "IN003", "", "", "", "", "", "Changed: status", "", "", JSON.stringify({ _sender: "Karen Yun <karen@broker.example>" })];
    const events = deriveGmailIngestion({
      importsRows: null,
      outboundRows: null,
      pendingVerificationTable: gvizTable(PENDING_HEADER, [row]),
    });
    expect(events[0].sender).toBe("Karen Yun <karen@broker.example>");
  });

  it("exposes received document names and their archive folder path", () => {
    const raw = {
      _documentNames: ["Commercial Invoice.pdf", "Packing List.xlsx"],
      _archiveFolderPath: "Warehouse Documents / Import Shipments / 2026 / JSL12345",
    };
    const row = ["2026-08-25 09:15", "inbound", "COMMITTED", "", "", "IN003", "", "", "", "", "", "Received: JSL12345", "", "https://drive.google.com/drive/folders/folder-id", JSON.stringify(raw)];
    const events = deriveGmailIngestion({
      importsRows: null,
      outboundRows: null,
      pendingVerificationTable: gvizTable(PENDING_HEADER, [row]),
    });
    expect(events[0].documentNames).toEqual(["Commercial Invoice.pdf", "Packing List.xlsx"]);
    expect(events[0].archiveFolderPath).toBe(raw._archiveFolderPath);
  });

  it("reads safe document metadata columns without requiring Raw JSON", () => {
    const row = [
      "2026-08-25 09:15", "inbound", "COMMITTED", "", "", "IN004", "", "", "", "", "",
      "Received: OSL900", "", "https://drive.google.com/drive/folders/folder-id", "",
      "KCC <ops@kcc.example>", '["MBL.pdf","Commercial Invoice.pdf"]',
      "Warehouse Documents / Import Shipments / 2026 / OSL900",
    ];
    const events = deriveGmailIngestion({
      importsRows: null,
      outboundRows: null,
      pendingVerificationTable: gvizTable(PENDING_HEADER, [row]),
    });
    expect(events[0].sender).toBe("KCC <ops@kcc.example>");
    expect(events[0].documentNames).toEqual(["MBL.pdf", "Commercial Invoice.pdf"]);
    expect(events[0].archiveFolderPath).toContain("Import Shipments / 2026 / OSL900");
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

  it("caps the feed at 200 events, keeping the NEWEST rows when the audit trail grows", () => {
    // 260 appended rows, one minute apart — sheet order is oldest-first.
    const base = Date.UTC(2026, 7, 1);
    const table = gvizTable(
      PENDING_HEADER,
      Array.from({ length: 260 }, (_, index) => [
        new Date(base + index * 60_000).toISOString(),
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
    // Newest appended row survives the cap; the oldest 60 fall off instead.
    expect(events[0].invoice).toBe("IN259");
    expect(events[199].invoice).toBe("IN60");
  });

  it("keeps open NEEDS REVIEW items ahead of newer resolved audit rows so the cap never hides them", () => {
    const base = Date.UTC(2026, 7, 1);
    // 5 old open reviews buried under 250 newer resolved (approved) rows.
    const rows = [
      ...Array.from({ length: 5 }, (_, index) => [
        new Date(base + index * 60_000).toISOString(),
        "inbound", "NEEDS REVIEW", "", "", `IN-OPEN-${index}`, "", "", "", "", "", "", "", "", "{}",
      ]),
      ...Array.from({ length: 250 }, (_, index) => [
        new Date(base + (100 + index) * 60_000).toISOString(),
        "inbound", "APPROVED", "", "", `IN-DONE-${index}`, "", "", "", "", "", "", "", "", "{}",
      ]),
    ];
    const events = deriveGmailIngestion({
      importsRows: null,
      outboundRows: null,
      pendingVerificationTable: gvizTable(PENDING_HEADER, rows),
    });
    expect(events).toHaveLength(200);
    expect(events.slice(0, 5).every((event) => event.status === "needsReview")).toBe(true);
    expect(events.slice(0, 5).map((event) => event.invoice)).toEqual(
      ["IN-OPEN-4", "IN-OPEN-3", "IN-OPEN-2", "IN-OPEN-1", "IN-OPEN-0"],
    );
    expect(events[5].status).toBe("approved");
  });

  it("orders untimestamped pending rows newest-appended-first", () => {
    const table = gvizTable(PENDING_HEADER, [
      ["", "inbound", "NEEDS REVIEW", "", "", "IN-OLD", "", "", "", "", "", "", "", "", "{}"],
      ["", "inbound", "NEEDS REVIEW", "", "", "IN-NEW", "", "", "", "", "", "", "", "", "{}"],
    ]);
    const events = deriveGmailIngestion({ importsRows: null, outboundRows: null, pendingVerificationTable: table });
    expect(events.map((event) => event.invoice)).toEqual(["IN-NEW", "IN-OLD"]);
  });
});
