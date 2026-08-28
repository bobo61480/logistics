import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type CommitResult = { committed: boolean };
type ValidationHelpers = {
  commitApprovedPendingRow_: (
    sheet: FakeSheet,
    rowIndex1based: number,
    data: string[],
    col: Record<string, number>,
  ) => CommitResult;
};

class FakeRange {
  constructor(private sheet: FakeSheet, private row: number, private col: number) {}
  setValue(value: unknown) {
    this.sheet.setCalls.push({ row: this.row, col: this.col, value });
    return this;
  }
  setBackground() {
    return this;
  }
  setFontColor() {
    return this;
  }
}

class FakeSheet {
  rows: unknown[][];
  setCalls: { row: number; col: number; value: unknown }[] = [];
  constructor(initialRows: unknown[][]) {
    this.rows = initialRows.map((r) => [...r]);
  }
  ensureCell(row: number, col: number) {
    while (this.rows.length < row) this.rows.push([]);
    while (this.rows[row - 1].length < col) this.rows[row - 1].push("");
  }
  getLastRow() {
    return this.rows.length;
  }
  getLastColumn() {
    return this.rows.reduce((max, r) => Math.max(max, r.length), 0);
  }
  getRange(row: number, col: number, numRows?: number, numCols?: number) {
    if (numRows === undefined) return new FakeRange(this, row, col);
    const out: unknown[][] = [];
    for (let r = 0; r < numRows; r++) {
      const rowData = this.rows[row - 1 + r] || [];
      const rowOut: unknown[] = [];
      for (let c = 0; c < (numCols || 1); c++) rowOut.push(rowData[col - 1 + c] ?? "");
      out.push(rowOut);
    }
    return { getDisplayValues: () => out, setValues: () => {}, setBackground: () => ({ setFontColor: () => {} }), setFontColor: () => {} };
  }
}

const WH_TRUCKING_HEADER = [
  "CUSTOMER", "INVOICE NO.", "ADDRESS", "SHIP DATE", "VALUE", "LENGTH (IN)", "WIDTH (IN)", "HEIGHT (IN)",
  "WEIGHT (LBS)", "VOLUME (INCHES)", "CFT", "PCF", "DIMENSIONAL WEIGHT", "FREIGHT CLASS", "SUB CLASS",
  "NMFC CODE", "CARRIER", "RATE", "PRO#", "NOTE", "STATUS", "INVOICE", "REMAKRS", "WEBSITE STATUS",
];

function loadHelpers(whTruckingRows: unknown[][]) {
  const code = readFileSync("google-apps-script/Code.gs", "utf8");
  const statusNorm = readFileSync("google-apps-script/StatusNormalization.gs", "utf8");
  const customerLookup = readFileSync("google-apps-script/CustomerLookup.gs", "utf8");
  const customerResolver = readFileSync("google-apps-script/GmailCustomerResolverV2.gs", "utf8");
  const storeResolver = readFileSync("google-apps-script/GmailStoreResolverV2.gs", "utf8");
  const pipeline = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
  const insert = readFileSync("google-apps-script/OutboundSheetInsertV2.gs", "utf8");
  const validation = readFileSync("google-apps-script/Validation.gs", "utf8");

  const whSheet = new FakeSheet(whTruckingRows);
  const loggedEvents: unknown[] = [];
  const context = vm.createContext({
    console,
    Logger: { log: () => {} },
    GMAIL_PIPELINE: { masterId: "test-master" },
    writeLog_: () => {},
    logPipeline_: (...args: unknown[]) => loggedEvents.push(args),
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: (name: string) => (name === "WH Trucking Request" ? whSheet : null) }),
      CopyPasteType: { PASTE_FORMAT: "FORMAT", PASTE_FORMULA: "FORMULA", PASTE_DATA_VALIDATION: "DATA_VALIDATION" },
    },
  });

  vm.runInContext(
    `${code}\n${statusNorm}\n${customerLookup}\n${customerResolver}\n${storeResolver}\n${pipeline}\n${insert}\n${validation}\n` +
      ";globalThis.__validation = { commitApprovedPendingRow_ };",
    context,
  );
  return { helpers: context.__validation as ValidationHelpers, whSheet, loggedEvents };
}

function whTruckingRows(dataRows: unknown[][]) {
  return [[], WH_TRUCKING_HEADER, ...dataRows];
}

const PENDING_COLS: Record<string, number> = {
  Timestamp: 0, Kind: 1, Status: 2, Issues: 3, Customer: 4, "Invoice / PI": 5, "BL / PRO": 6,
  Container: 7, "Ship Date / ETA": 8, Qty: 9, "Carrier / Vessel": 10, Note: 11,
  "Source Email": 12, "Drive File": 13, "Raw JSON": 14,
};

function pendingRow(fields: Partial<Record<string, string>>, record: Record<string, unknown>) {
  const row = new Array(15).fill("");
  Object.keys(fields).forEach((key) => (row[PENDING_COLS[key]] = fields[key]));
  row[PENDING_COLS["Raw JSON"]] = JSON.stringify(record);
  return row;
}

describe("commitApprovedPendingRow_", () => {
  it("marks COMMITTED when the outbound upsert actually matches an existing row", () => {
    const rows = whTruckingRows([
      ["MEGA MART", "IN00100000", "", "08/10/2026", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "PRO100", "", "Work in Progress"],
    ]);
    const { helpers } = loadHelpers(rows);
    const pendingSheet = new FakeSheet([]);
    const data = pendingRow({ Kind: "outbound", Customer: "MEGA MART", "BL / PRO": "PRO100" }, { customer: "MEGA MART", pro: "PRO100" });
    const result = helpers.commitApprovedPendingRow_(pendingSheet, 5, data, PENDING_COLS);
    expect(result).toEqual({ committed: true });
    expect(pendingSheet.setCalls.some((c) => c.value === "COMMITTED")).toBe(true);
  });

  // Regression for a Codex review finding: a tie among candidate rows
  // makes upsertOutboundEmailAcrossSheetsV2_ return matched:false — the
  // approval must not be marked COMMITTED for a shipment that was neither
  // updated nor inserted, or it becomes permanently unretryable.
  it("does NOT mark COMMITTED when the upsert can't safely match or insert (a tied identifier)", () => {
    const rows = whTruckingRows([
      ["MEGA MART", "IN00100000", "", "08/10/2026", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Work in Progress"],
      ["MEGA MART", "IN00100000", "", "08/12/2026", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Work in Progress"],
    ]);
    const { helpers, loggedEvents } = loadHelpers(rows);
    const pendingSheet = new FakeSheet([]);
    const data = pendingRow(
      { Kind: "outbound", Customer: "MEGA MART", "Invoice / PI": "IN00100000" },
      { customer: "MEGA MART", invoice: "IN00100000" }, // no shipDate — not independently insert-eligible either
    );
    const result = helpers.commitApprovedPendingRow_(pendingSheet, 5, data, PENDING_COLS);
    expect(result).toEqual({ committed: false });
    expect(pendingSheet.setCalls.some((c) => c.value === "COMMITTED")).toBe(false);
    expect(loggedEvents.length).toBeGreaterThan(0);
  });
});
