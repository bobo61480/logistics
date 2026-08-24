import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type CustomerRecord = {
  rowNumber: number;
  name: string;
  exactKey: string;
  canonicalKey: string;
  address: string;
  contact: string;
  services: string[];
};

type CustomerLookupHelpers = {
  matchCustomerRecord_: (customerValue: string, records: CustomerRecord[]) => CustomerRecord | null;
  buildCustomerNoteText_: (record: CustomerRecord) => string;
  canonicalWmsCustomer_: (value: unknown) => string;
  normalizeWmsCustomerKey_: (value: unknown) => string;
  stripCustomerLocationSuffix_: (name: string) => string;
  isAmbiguousLocationFamily_: (customerValue: string, records: CustomerRecord[]) => boolean;
  customerAddressConflicts_: (record: CustomerRecord, seedAddress: string) => boolean;
  logPipelineFromBoundSpreadsheet_: (
    spreadsheet: FakeSpreadsheet,
    event: string,
    subject: string,
    detail: string,
  ) => void;
};

type FakeSheet = {
  rows: unknown[][];
  getLastRow: () => number;
  appendRow: (row: unknown[]) => void;
  deleteRows: (start: number, count: number) => void;
};
type FakeSpreadsheet = {
  sheets: Record<string, FakeSheet>;
  getSheetByName: (name: string) => FakeSheet | null;
  insertSheet: (name: string) => FakeSheet;
};

function makeFakeSheet(): FakeSheet {
  const rows: unknown[][] = [];
  return {
    rows,
    getLastRow: () => rows.length,
    appendRow: (row: unknown[]) => rows.push(row),
    deleteRows: (start: number, count: number) => rows.splice(start - 1, count),
  };
}

function makeFakeSpreadsheet(): FakeSpreadsheet {
  const sheets: Record<string, FakeSheet> = {};
  return {
    sheets,
    getSheetByName: (name: string) => sheets[name] || null,
    insertSheet: (name: string) => (sheets[name] = makeFakeSheet()),
  };
}

function loadCustomerLookupHelpers(): CustomerLookupHelpers {
  // canonicalWmsCustomer_/normalizeWmsCustomerKey_ live in Code.gs;
  // matchCustomerRecord_/buildCustomerNoteText_ live in CustomerLookup.gs and
  // call the former directly (same global scope in Apps Script) — concatenate
  // both sources into one vm context, mirroring loadWmsHelpers() in
  // wms-trucking-sync.test.ts.
  const code = readFileSync("google-apps-script/Code.gs", "utf8");
  const customerLookup = readFileSync("google-apps-script/CustomerLookup.gs", "utf8");
  // Logger stub: logPipelineFromBoundSpreadsheet_'s catch path calls
  // Logger.log, same as real Apps Script — without a stub, an intentionally
  // broken spreadsheet handle in a test would throw a ReferenceError from
  // inside the catch block itself instead of being caught.
  const context = vm.createContext({ console, Logger: { log: () => {} } });

  vm.runInContext(
    `${code}\n${customerLookup}\n;globalThis.__cust = {` +
      "matchCustomerRecord_,buildCustomerNoteText_,canonicalWmsCustomer_,normalizeWmsCustomerKey_," +
      "stripCustomerLocationSuffix_,isAmbiguousLocationFamily_,customerAddressConflicts_," +
      "logPipelineFromBoundSpreadsheet_};",
    context,
  );
  return context.__cust as CustomerLookupHelpers;
}

const helpers = loadCustomerLookupHelpers();

function makeRecord(overrides: Partial<CustomerRecord> & { name: string }): CustomerRecord {
  const name = overrides.name;
  const defaults = {
    rowNumber: 1,
    exactKey: name.toUpperCase().replace(/\s+/g, " "),
    canonicalKey: helpers.normalizeWmsCustomerKey_(helpers.canonicalWmsCustomer_(name)),
    address: "",
    contact: "",
    services: [] as string[],
  };
  return { ...defaults, ...overrides };
}

describe("WH Trucking Request customer lookup", () => {
  it("matches an exact (case/whitespace-insensitive) customer name", () => {
    const records = [makeRecord({ name: "KORHEIM (CERRITOS)", address: "150 Los Cerritos Mall" })];
    const match = helpers.matchCustomerRecord_("  korheim (cerritos)  ", records);
    expect(match?.address).toBe("150 Los Cerritos Mall");
  });

  it("falls back to a canonical-key match only when it is unique", () => {
    const records = [makeRecord({ name: "ROYAL IMEX INC", address: "123 Main St" })];
    // "Royal Imex, Inc." doesn't exact-match "ROYAL IMEX INC" (punctuation
    // differs), but canonicalWmsCustomer_'s alias handling resolves both to
    // the same canonical key — exercise the real fallback path, not just
    // the exact-match stage's whitespace/case normalization.
    const match = helpers.matchCustomerRecord_("Royal Imex, Inc.", records);
    expect(match?.address).toBe("123 Main St");
  });

  it("refuses to guess when the canonical key matches more than one distinct record", () => {
    // Real data pattern: distinct per-location entries sharing a canonicalizable
    // brand name (e.g. "OVER N OVER Over Beauty - 1" vs "- 2") must never let an
    // ambiguous canonical match pick one address/contact over the other.
    const records = [
      makeRecord({ name: "MEGA MART (PALO ALTO)", address: "Palo Alto address" }),
      makeRecord({ name: "MEGA MART (FREMONT)", address: "Fremont address" }),
    ];
    expect(helpers.matchCustomerRecord_("MEGA MART", records)).toBeNull();
  });

  it("never collapses an unrelated customer that merely shares a name prefix", () => {
    const records = [makeRecord({ name: "MEGA MART (PALO ALTO)", address: "Palo Alto address" })];
    expect(helpers.matchCustomerRecord_("MEGA MARTINEZ DISTRIBUTION", records)).toBeNull();
  });

  it("returns null when nothing matches at all", () => {
    const records = [makeRecord({ name: "KORHEIM (CERRITOS)" })];
    expect(helpers.matchCustomerRecord_("Some Brand New Customer", records)).toBeNull();
  });

  it("builds a readable note from address, contact, and only the flagged services", () => {
    const record = makeRecord({
      name: "Mira Beauty Inc",
      address: "14246 Manchester Rd., MANCHESTER, MO 63011",
      contact: "Me Ra Yang\nmira1206@gmail.com\nT: 636-288-9515",
      services: ["Liftgate", "Inside delivery", "Notify before delivery"],
    });
    expect(helpers.buildCustomerNoteText_(record)).toBe(
      "Address: 14246 Manchester Rd., MANCHESTER, MO 63011 | Contact: Me Ra Yang · mira1206@gmail.com · T: 636-288-9515 | Services: Liftgate, Inside delivery, Notify before delivery",
    );
  });

  it("omits empty sections instead of leaving stray separators", () => {
    const record = makeRecord({ name: "No Data Customer" });
    expect(helpers.buildCustomerNoteText_(record)).toBe("");
  });
});

// Live-write rollout (2026-08-24, Codex review on PR #92): matchCustomerRecord_
// already refuses to guess for a "- N" family or a canonical-alias family,
// but the live-write caller must distinguish that from a genuinely absent
// customer, or it creates a fresh blank duplicate on top of already-known
// locations every time the bare brand name is typed.
describe("WH Trucking Request customer lookup: ambiguous-family detection for live writes", () => {
  it("flags ambiguity via the '- N' suffix family a prior live write already created", () => {
    const records = [makeRecord({ name: "Acme Co - 1" }), makeRecord({ name: "Acme Co - 2" })];
    expect(helpers.isAmbiguousLocationFamily_("Acme Co", records)).toBe(true);
  });

  it("flags ambiguity via canonical-key aliasing (e.g. MEGA MART)", () => {
    const records = [
      makeRecord({ name: "MEGA MART (PALO ALTO)" }),
      makeRecord({ name: "MEGA MART (FREMONT)" }),
    ];
    expect(helpers.isAmbiguousLocationFamily_("MEGA MART", records)).toBe(true);
  });

  it("is not ambiguous when the name matches nothing at all", () => {
    const records = [makeRecord({ name: "Someone Else Co" })];
    expect(helpers.isAmbiguousLocationFamily_("Brand New Customer", records)).toBe(false);
  });

  it("is not ambiguous for a normal single exact match", () => {
    const records = [makeRecord({ name: "Acme Co" })];
    expect(helpers.isAmbiguousLocationFamily_("Acme Co", records)).toBe(false);
  });

  // Round 2 (2026-08-24): the suffix-family check must canonicalize each
  // sibling's stripped base name, not just simple-normalize it, or a
  // punctuation/legal-suffix variant of an already-split family's base name
  // silently fails to match and reads as "no family at all".
  it("recognizes a suffix family even when the query has different punctuation than the stored records", () => {
    const records = [
      makeRecord({ name: "Acme Co, Inc. - 1" }),
      makeRecord({ name: "Acme Co, Inc. - 2" }),
    ];
    expect(helpers.isAmbiguousLocationFamily_("Acme Co Inc", records)).toBe(true);
  });
});

// Round 2 (2026-08-24, Codex review on PR #92): a record matched in
// handleWhTruckingCustomerEdit_ can be one this very batch already created —
// if the current row's own typed address disagrees with that record's
// address, applying the note blindly would silently attach the wrong
// address to a different shipment.
describe("WH Trucking Request customer lookup: same-batch address conflict detection", () => {
  it("flags a conflict when the row's own address disagrees with the matched record's address", () => {
    const record = makeRecord({ name: "Acme Co", address: "123 Main St" });
    expect(helpers.customerAddressConflicts_(record, "456 Oak St")).toBe(true);
  });

  it("is not a conflict when the addresses agree", () => {
    const record = makeRecord({ name: "Acme Co", address: "123 Main St" });
    expect(helpers.customerAddressConflicts_(record, "123 Main St")).toBe(false);
  });

  it("is not a conflict when either side is blank", () => {
    const withAddress = makeRecord({ name: "Acme Co", address: "123 Main St" });
    const withoutAddress = makeRecord({ name: "Acme Co", address: "" });
    expect(helpers.customerAddressConflicts_(withAddress, "")).toBe(false);
    expect(helpers.customerAddressConflicts_(withoutAddress, "456 Oak St")).toBe(false);
  });
});

// Round 4 (2026-08-24, Codex review on PR #92): onEdit(e) reverted to a bare,
// zero-config simple trigger — deploy-apps-script.yml never runs
// setupAllTriggers(), so an earlier revision that required it as an
// installable trigger would have silently disabled this whole feature after
// every deploy. Every PIPELINE LOG write now goes through
// logPipelineFromBoundSpreadsheet_, which writes directly to an already-open
// spreadsheet handle (e.source) instead of SpreadsheetApp.openById — the
// specific call that's restricted under a simple trigger's authorization.
describe("WH Trucking Request customer lookup: bound-spreadsheet PIPELINE LOG writes", () => {
  it("creates the PIPELINE LOG sheet with a header row on first write", () => {
    const spreadsheet = makeFakeSpreadsheet();
    helpers.logPipelineFromBoundSpreadsheet_(spreadsheet, "CUSTOMER LOOKUP AMBIGUOUS", "Acme Co", "{}");

    const log = spreadsheet.getSheetByName("PIPELINE LOG");
    expect(log?.rows[0]).toEqual(["Timestamp", "Event", "Subject", "Detail"]);
    expect(log?.rows[1]?.slice(1)).toEqual(["CUSTOMER LOOKUP AMBIGUOUS", "Acme Co", "{}"]);
  });

  it("appends to an existing PIPELINE LOG sheet without re-adding the header", () => {
    const spreadsheet = makeFakeSpreadsheet();
    const existing = spreadsheet.insertSheet("PIPELINE LOG");
    existing.appendRow(["Timestamp", "Event", "Subject", "Detail"]);
    existing.appendRow([new Date(), "SOME OTHER EVENT", "x", "y"]);

    helpers.logPipelineFromBoundSpreadsheet_(spreadsheet, "CUSTOMER LOOKUP LOCK TIMEOUT", "", "{}");

    expect(existing.rows).toHaveLength(3);
    expect(existing.rows[2][1]).toBe("CUSTOMER LOOKUP LOCK TIMEOUT");
  });

  it("never throws even if the spreadsheet handle is broken", () => {
    const broken = { getSheetByName: () => { throw new Error("boom"); } } as unknown as FakeSpreadsheet;
    expect(() => helpers.logPipelineFromBoundSpreadsheet_(broken, "X", "y", "z")).not.toThrow();
  });
});
