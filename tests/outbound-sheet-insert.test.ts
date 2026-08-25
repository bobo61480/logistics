import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type UpsertResult = { matched: boolean; action?: string; row?: number | null; changes?: string[]; dryRun?: boolean };

type InsertHelpers = {
  chooseOutboundSheetV2_: (record: Record<string, unknown>, sheetNames: string[]) => string | null;
  upsertOutboundEmailAcrossSheetsV2_: (
    record: Record<string, unknown>,
    allowInsert: boolean,
    sheetNames: string[],
    dryRun: boolean,
  ) => UpsertResult;
};

class FakeRange {
  constructor(
    private sheet: FakeSheet,
    private row: number,
    private col: number,
    private numRows: number,
    private numCols: number,
  ) {}
  getDisplayValues() {
    const out: unknown[][] = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowData = this.sheet.rows[this.row - 1 + r] || [];
      const rowOut: unknown[] = [];
      for (let c = 0; c < this.numCols; c++) rowOut.push(rowData[this.col - 1 + c] ?? "");
      out.push(rowOut);
    }
    return out;
  }
  setValue(value: unknown) {
    this.sheet.ensureCell(this.row, this.col);
    this.sheet.rows[this.row - 1][this.col - 1] = value;
    this.sheet.setCalls.push({ row: this.row, col: this.col, value });
    return this;
  }
  setValues(values: unknown[][]) {
    values.forEach((rowVals, r) => {
      rowVals.forEach((v, c) => {
        this.sheet.ensureCell(this.row + r, this.col + c);
        this.sheet.rows[this.row - 1 + r][this.col - 1 + c] = v;
      });
    });
    this.sheet.setValuesCalls.push({ row: this.row, col: this.col, values });
    return this;
  }
  copyTo(_target: unknown, type: unknown) {
    this.sheet.copyToCalls.push({ from: [this.row, this.col], type });
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
  setValuesCalls: { row: number; col: number; values: unknown[][] }[] = [];
  copyToCalls: unknown[] = [];
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
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols);
  }
}

function loadInsertHelpers(sheets: Record<string, unknown[][]>, sourceOverride?: (src: string) => string) {
  const code = readFileSync("google-apps-script/Code.gs", "utf8");
  const customerLookup = readFileSync("google-apps-script/CustomerLookup.gs", "utf8");
  const statusNorm = readFileSync("google-apps-script/StatusNormalization.gs", "utf8");
  const customerResolver = readFileSync("google-apps-script/GmailCustomerResolverV2.gs", "utf8");
  const storeResolver = readFileSync("google-apps-script/GmailStoreResolverV2.gs", "utf8");
  const pipeline = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
  let insert = readFileSync("google-apps-script/OutboundSheetInsertV2.gs", "utf8");
  if (sourceOverride) insert = sourceOverride(insert);

  const fakeSheets: Record<string, FakeSheet> = {};
  Object.keys(sheets).forEach((name) => (fakeSheets[name] = new FakeSheet(sheets[name])));

  const context = vm.createContext({
    console,
    Logger: { log: () => {} },
    GMAIL_PIPELINE: { masterId: "test-master" },
    writeLog_: () => {},
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: (name: string) => fakeSheets[name] || null }),
      CopyPasteType: { PASTE_FORMAT: "FORMAT", PASTE_FORMULA: "FORMULA", PASTE_DATA_VALIDATION: "DATA_VALIDATION" },
    },
  });

  vm.runInContext(
    `${code}\n${statusNorm}\n${customerLookup}\n${customerResolver}\n${storeResolver}\n${pipeline}\n${insert}\n` +
      ";globalThis.__insert = { chooseOutboundSheetV2_, upsertOutboundEmailAcrossSheetsV2_ };",
    context,
  );
  return { helpers: context.__insert as InsertHelpers, fakeSheets };
}

const WH_TRUCKING_HEADER = [
  "CUSTOMER", "INVOICE NO.", "ADDRESS", "SHIP DATE", "VALUE", "LENGTH (IN)", "WIDTH (IN)", "HEIGHT (IN)",
  "WEIGHT (LBS)", "VOLUME (INCHES)", "CFT", "PCF", "DIMENSIONAL WEIGHT", "FREIGHT CLASS", "SUB CLASS",
  "NMFC CODE", "CARRIER", "RATE", "PRO#", "NOTE", "STATUS", "INVOICE", "REMAKRS", "WEBSITE STATUS",
];

function whTruckingRows(dataRows: unknown[][]) {
  return [[], WH_TRUCKING_HEADER, ...dataRows];
}

describe("chooseOutboundSheetV2_", () => {
  it("routes an ULTA DC label, a bare TJX/ROSS DC# number, the literal IHERB, and falls back to WH Trucking Request", () => {
    const sheetNames = ["WH Trucking Request", "IHERB", "ULTA", "TJX/ROSS"];
    const { helpers } = loadInsertHelpers({});
    expect(helpers.chooseOutboundSheetV2_({ customer: "ULTA (FRESNO)" }, sheetNames)).toBe("ULTA");
    expect(helpers.chooseOutboundSheetV2_({ customer: "1234" }, sheetNames)).toBe("TJX/ROSS");
    expect(helpers.chooseOutboundSheetV2_({ customer: "IHERB" }, sheetNames)).toBe("IHERB");
    expect(helpers.chooseOutboundSheetV2_({ customer: "MEGA MART" }, sheetNames)).toBe("WH Trucking Request");
    expect(helpers.chooseOutboundSheetV2_({ customer: "" }, sheetNames)).toBeNull();
  });

  it("restricted to a single sheet (the upsertOutboundEmailV2_ shim's shape), routes any truthy customer there", () => {
    // Preserves upsertOutboundEmailV2_'s exact pre-existing reach for its
    // callers (GmailXpoV2.gs) — with only "WH Trucking Request" allowed,
    // even a value that would otherwise read as an ULTA/TJX identity has
    // nowhere else to go and falls through to the one allowed sheet.
    const { helpers } = loadInsertHelpers({});
    expect(helpers.chooseOutboundSheetV2_({ customer: "ULTA (FRESNO)" }, ["WH Trucking Request"])).toBe("WH Trucking Request");
    expect(helpers.chooseOutboundSheetV2_({ customer: "MEGA MART" }, ["WH Trucking Request"])).toBe("WH Trucking Request");
    expect(helpers.chooseOutboundSheetV2_({ customer: "" }, ["WH Trucking Request"])).toBeNull();
  });
});

describe("upsertOutboundEmailAcrossSheetsV2_", () => {
  it("makes zero sheet writes in dry-run, reports a non-committed noop, and logs the would-be insert", () => {
    const rows = whTruckingRows([
      ["MEGA MART", "IN00100000", "", "08/10/2026", "", "", "", "", "", "", "", "", "", "", "", "", "XPO", "", "PRO100", "", "Work in Progress"],
    ]);
    const { helpers, fakeSheets } = loadInsertHelpers({ "WH Trucking Request": rows });
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "MEGA MART", shipDate: "08/25/2026", invoice: "IN00999999", carrier: "XPO" },
      true,
      ["WH Trucking Request"],
      true,
    );
    // matched:false, not true — a dry-run "would insert" must never be
    // reported as a commit (Codex review on PR #103: the caller marks the
    // Gmail message seen and writes a false "Received:" notice for
    // anything matched:true, regardless of the action label).
    expect(result).toEqual({ matched: false, action: "noop", dryRun: true });
    expect(fakeSheets["WH Trucking Request"].setValuesCalls).toHaveLength(0);
    expect(fakeSheets["WH Trucking Request"].setCalls).toHaveLength(0);
  });

  it("makes zero sheet writes in dry-run for a MATCHED row too, not just new inserts", () => {
    const rows = whTruckingRows([
      ["MEGA MART", "IN00100000", "", "08/10/2026", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "PRO100", "", "Work in Progress"],
    ]);
    const { helpers, fakeSheets } = loadInsertHelpers({ "WH Trucking Request": rows });
    // Same record that would update Carrier in the live test below — here
    // dryRun:true must prevent that write entirely (Codex review on PR
    // #103: only the insert path was ever dry-run-gated, so a matched
    // update landed live immediately once resolvers were wired in).
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "MEGA MART", pro: "PRO100", carrier: "NEW CARRIER" },
      true,
      ["WH Trucking Request"],
      true,
    );
    expect(result).toEqual({ matched: false, action: "noop" });
    expect(fakeSheets["WH Trucking Request"].setCalls).toHaveLength(0);
  });

  it("inserts the correct columns and copies exemplar-row format/formula/data-validation once dry-run is disabled", () => {
    const rows = whTruckingRows([
      ["MEGA MART", "IN00100000", "", "08/10/2026", "", "", "", "", "", "", "", "", "", "", "", "", "XPO", "", "PRO100", "", "Work in Progress"],
    ]);
    const { helpers, fakeSheets } = loadInsertHelpers({ "WH Trucking Request": rows });
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "TOKTOK BEAUTY", shipDate: "08/25/2026", invoice: "IN00999999", carrier: "XPO" },
      true,
      ["WH Trucking Request"],
      false,
    );
    expect(result.action).toBe("inserted");
    const sheet = fakeSheets["WH Trucking Request"];
    expect(sheet.setValuesCalls).toHaveLength(1);
    const written = sheet.setValuesCalls[0].values[0];
    expect(written[0]).toBe("TOKTOK BEAUTY"); // CUSTOMER
    expect(written[1]).toBe("IN00999999"); // INVOICE NO.
    expect(written[3]).toBe("08/25/2026"); // SHIP DATE
    expect(written[16]).toBe("XPO"); // CARRIER
    expect(written[20]).toBe("Work in Progress"); // STATUS default
    // All three exemplar-row paste types, matching WmsTruckingSyncV2.gs's
    // pattern (Codex review on PR #103: PASTE_FORMULA was missing, leaving
    // formula-backed columns like VOLUME/CFT/PCF permanently blank).
    const copiedTypes = sheet.copyToCalls.map((c) => (c as { type: string }).type);
    expect(copiedTypes).toContain("FORMAT");
    expect(copiedTypes).toContain("FORMULA");
    expect(copiedTypes).toContain("DATA_VALIDATION");
  });

  it("updates an existing row matched by PRO# rather than inserting a duplicate, once dry-run is disabled", () => {
    const rows = whTruckingRows([
      ["MEGA MART", "IN00100000", "", "08/10/2026", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "PRO100", "", "Work in Progress"],
    ]);
    const { helpers, fakeSheets } = loadInsertHelpers({ "WH Trucking Request": rows });
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "MEGA MART", pro: "PRO100", carrier: "NEW CARRIER" },
      true,
      ["WH Trucking Request"],
      false,
    );
    expect(result).toMatchObject({ matched: true, action: "updated", row: 3 });
    expect(fakeSheets["WH Trucking Request"].setValuesCalls).toHaveLength(0); // no insert happened
    expect(fakeSheets["WH Trucking Request"].setCalls.some((c) => c.value === "NEW CARRIER")).toBe(true);
  });

  it("matches an existing WH Trucking Request row by PRO# even with no resolved customer at all", () => {
    // Restores upsertOutboundEmailV2_'s original behavior: matching never
    // required a customer, only inserting did. GmailXpoV2.gs's fallback
    // always calls with an unresolved customer — without this, it could
    // never match anything again (Codex review on PR #103).
    const rows = whTruckingRows([
      ["MEGA MART", "IN00100000", "", "08/10/2026", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "PRO100", "", "Work in Progress"],
    ]);
    const { helpers, fakeSheets } = loadInsertHelpers({ "WH Trucking Request": rows });
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { pro: "PRO100", carrier: "NEW CARRIER" },
      false,
      ["WH Trucking Request"],
      false,
    );
    expect(result).toMatchObject({ matched: true, action: "updated", row: 3 });
    expect(fakeSheets["WH Trucking Request"].setCalls.some((c) => c.value === "NEW CARRIER")).toBe(true);
  });

  it("never guesses between a tied match, and never inserts a duplicate on top of it even when otherwise insert-eligible", () => {
    const rows = whTruckingRows([
      ["MEGA MART", "IN00100000", "", "08/10/2026", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Work in Progress"],
      ["MEGA MART", "IN00100000", "", "08/12/2026", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Work in Progress"],
    ]);
    const { helpers, fakeSheets } = loadInsertHelpers({ "WH Trucking Request": rows });
    // Fully insert-eligible (customer + shipDate + invoice all present) —
    // proves the tie itself blocks the insert fallthrough, not merely a
    // missing field (Codex review on PR #103).
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "MEGA MART", invoice: "IN00100000", shipDate: "08/25/2026" },
      true,
      ["WH Trucking Request"],
      false,
    );
    expect(result).toEqual({ matched: false, action: "noop" });
    expect(fakeSheets["WH Trucking Request"].setValuesCalls).toHaveLength(0);
    expect(fakeSheets["WH Trucking Request"].setCalls).toHaveLength(0);
  });

  it("never writes when allowInsert is false, even for an eligible new record", () => {
    const rows = whTruckingRows([]);
    const { helpers, fakeSheets } = loadInsertHelpers({ "WH Trucking Request": rows });
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "MEGA MART", shipDate: "08/25/2026", invoice: "IN00999999" },
      false,
      ["WH Trucking Request"],
      false,
    );
    expect(result).toEqual({ matched: false, action: "noop" });
    expect(fakeSheets["WH Trucking Request"].setValuesCalls).toHaveLength(0);
  });

  it("routes an IHERB-context record with no customer column data required beyond invoice/pro and a ship date", () => {
    const iherbRows = [
      ["PO#", "BOL", "QTY", "FROM", "TO", "APPT #", "DELIVERY APPT", "VALUE", "TRUCKING", "RATE", "INVOICE", "STATUS"],
    ];
    const { helpers, fakeSheets } = loadInsertHelpers({ IHERB: iherbRows });
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "IHERB", invoice: "4500999999", shipDate: "08/25/2026" },
      true,
      ["IHERB"],
      false,
    );
    expect(result.action).toBe("inserted");
    const written = fakeSheets["IHERB"].setValuesCalls[0].values[0];
    expect(written[0]).toBe("4500999999"); // PO#
  });

  it("routes IHERB case-insensitively", () => {
    const iherbRows = [
      ["PO#", "BOL", "QTY", "FROM", "TO", "APPT #", "DELIVERY APPT", "VALUE", "TRUCKING", "RATE", "INVOICE", "STATUS"],
    ];
    const { helpers, fakeSheets } = loadInsertHelpers({ IHERB: iherbRows });
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "iHerb", invoice: "4500999999", shipDate: "08/25/2026" },
      true,
      ["IHERB"],
      false,
    );
    expect(result.action).toBe("inserted");
    expect(fakeSheets["IHERB"].setValuesCalls).toHaveLength(1);
  });

  it("never inserts a date-less IHERB/TJX-ROSS record — eligibility matches validateRecord_'s universal outbound shipDate requirement", () => {
    const iherbRows = [
      ["PO#", "BOL", "QTY", "FROM", "TO", "APPT #", "DELIVERY APPT", "VALUE", "TRUCKING", "RATE", "INVOICE", "STATUS"],
    ];
    const { helpers, fakeSheets } = loadInsertHelpers({ IHERB: iherbRows });
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "IHERB", invoice: "4500999999" }, // no shipDate
      true,
      ["IHERB"],
      false,
    );
    expect(result).toEqual({ matched: false, action: "noop" });
    expect(fakeSheets["IHERB"].setValuesCalls).toHaveLength(0);
  });

  it("populates IHERB's PU (scheduling date) and QTY (pallet count) on insert", () => {
    // Real IHERB header, including the two columns the original insertFields
    // omitted (Codex review on PR #103): PU is IHERB's scheduling date and
    // QTY its pallet count per scripts/all-outbound-pallets.mjs's aggregation.
    const iherbRows = [
      ["PO#", "BOL", "QTY", "FROM", "TO", "APPT #", "PU", "DELIVERY APPT", "VALUE", "TRUCKING", "RATE", "INVOICE", "STATUS"],
    ];
    const { helpers, fakeSheets } = loadInsertHelpers({ IHERB: iherbRows });
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "IHERB", invoice: "4500999999", shipDate: "08/25/2026", qty: "18" },
      true,
      ["IHERB"],
      false,
    );
    expect(result.action).toBe("inserted");
    const written = fakeSheets["IHERB"].setValuesCalls[0].values[0];
    expect(written[0]).toBe("4500999999"); // PO#
    expect(written[2]).toBe("18"); // QTY
    expect(written[6]).toBe("08/25/2026"); // PU
  });

  it("persists a PO# learned from an ULTA row matched by PRO# alone", () => {
    const ultaRows = [
      ["DC", "Date", "PO#", "Ship To", "TRUCKING", "Height", "Weight", "Total Cartons", "ship date", "PRO#", "RATE", "Invoice", "NOTE", "STATUS"],
      ["ULTA (FRESNO)", "", "", "", "", "", "", "", "", "PRO999", "", "", "", "Work in Progress"],
    ];
    const { helpers, fakeSheets } = loadInsertHelpers({ ULTA: ultaRows });
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "ULTA (FRESNO)", pro: "PRO999", invoice: "180146682" },
      true,
      ["ULTA"],
      false,
    );
    expect(result).toMatchObject({ matched: true, action: "updated" });
    expect(fakeSheets["ULTA"].setCalls.some((c) => c.value === "180146682")).toBe(true);
  });

  it("persists a PO# learned from a TJX/ROSS row matched by BOL alone", () => {
    const tjxRows = [
      ["Order Received", "Order Name", "DC#", "PO#", "SHIPMENT #", "BOL", "CARRIER", "STATUS", "WEBSITE STATUS"],
      ["", "Ross 92k", "1234", "", "", "CS02307203", "", "shipped", ""],
    ];
    const { helpers, fakeSheets } = loadInsertHelpers({ "TJX/ROSS": tjxRows });
    const result = helpers.upsertOutboundEmailAcrossSheetsV2_(
      { customer: "1234", pro: "CS02307203", invoice: "11573404" },
      true,
      ["TJX/ROSS"],
      false,
    );
    expect(result).toMatchObject({ matched: true, action: "updated" });
    expect(fakeSheets["TJX/ROSS"].setCalls.some((c) => c.value === "11573404")).toBe(true);
  });
});
