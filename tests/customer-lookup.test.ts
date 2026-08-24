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
  accessories: string;
  references: string;
  storeCount: string;
  salesRep: string;
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
  customerAddressFillable_: (record: CustomerRecord, seedAddress: string) => boolean;
  matchedByExactName_: (customerValue: string, record: CustomerRecord) => boolean;
  fillCustomerAddress_: (sheet: FakeDbSheet, header: DbHeader, record: CustomerRecord, address: string) => void;
  appendCustomerNote_: (sheet: FakeNoteSheet, rowNumber: number, noteCol: number, record: CustomerRecord) => void;
  shouldProcessCustomerLookupEdit_: (
    customerCol: number,
    addressCol: number | null,
    editedColStart: number,
    editedColEnd: number,
  ) => boolean;
  logPipelineFromBoundSpreadsheet_: (
    spreadsheet: FakeSpreadsheet,
    event: string,
    subject: string,
    detail: string,
  ) => void;
  logCanonicalMatchNeedsReview_: (
    spreadsheet: FakeSpreadsheet,
    customerValue: string,
    whTruckingRow: number,
    record: CustomerRecord,
  ) => void;
  findCustomerDbHeader_: (rows: string[][]) => DbHeader;
  buildCustomerRecords_: (rows: string[][], header: DbHeader) => CustomerRecord[];
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

type DbHeader = { rowIndex: number; map: Record<string, number> };
type DbWrite = { row: number; col: number; value: unknown };
type FakeDbSheet = { writes: DbWrite[]; getRange: (row: number, col: number) => { setValue: (value: unknown) => void } };

function makeFakeDbSheet(): FakeDbSheet {
  const writes: DbWrite[] = [];
  return {
    writes,
    getRange: (row: number, col: number) => ({
      setValue: (value: unknown) => writes.push({ row, col, value }),
    }),
  };
}

type NoteWrite = { row: number; col: number; value: unknown };
type FakeNoteSheet = {
  writes: NoteWrite[];
  getRange: (row: number, col: number) => { getDisplayValue: () => string; setValue: (value: unknown) => void };
};

function makeFakeNoteSheet(existingValue = ""): FakeNoteSheet {
  const writes: NoteWrite[] = [];
  let current = existingValue;
  return {
    writes,
    getRange: (row: number, col: number) => ({
      getDisplayValue: () => current,
      setValue: (value: unknown) => {
        current = String(value);
        writes.push({ row, col, value });
      },
    }),
  };
}

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
      "customerAddressFillable_,matchedByExactName_,fillCustomerAddress_," +
      "shouldProcessCustomerLookupEdit_,logPipelineFromBoundSpreadsheet_," +
      "logCanonicalMatchNeedsReview_,appendCustomerNote_," +
      "findCustomerDbHeader_,buildCustomerRecords_};",
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
    accessories: "",
    references: "",
    storeCount: "",
    salesRep: "",
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

  // Round 11 (2026-08-24, live verification): TRUCKING has 14 real columns,
  // but the note only ever surfaced Address/Contact/service flags —
  // Accessories, References, No. of Stores, and Sales Rep were silently
  // dropped even though they're real, staff-maintained data on the row.
  it("includes accessories, references, store count, and sales rep when present", () => {
    const record = makeRecord({
      name: "Fanloli Beauty",
      address: "depends on the order location",
      contact: "Fanny Deng\n4153350541",
      accessories: "LIFT GATE - FOR NON WAREHOUSE ORDERS\nAPPOINTMENT REQUIRED",
      references: "Customer Name: Yixi Trading",
      storeCount: "12",
      salesRep: "Christine",
      services: ["Liftgate"],
    });
    expect(helpers.buildCustomerNoteText_(record)).toBe(
      "Address: depends on the order location | Contact: Fanny Deng · 4153350541 | " +
        "Accessories: LIFT GATE - FOR NON WAREHOUSE ORDERS · APPOINTMENT REQUIRED | " +
        "References: Customer Name: Yixi Trading | No. of Stores: 12 | Sales Rep: Christine | Services: Liftgate",
    );
  });

  // Round 11: prove the header-to-record read actually works end-to-end
  // against TRUCKING's real column layout, not just that buildCustomerNoteText_
  // formats these fields correctly once they're on a record object.
  it("buildCustomerRecords_ reads accessories/references/store count/sales rep from the real TRUCKING header layout", () => {
    const rows = [
      ["Customer Name", "Accessories", "Address", "Contact", "References", "No. of Stores", "Sales Rep", "LIFTGATE"],
      [
        "Fanloli Beauty",
        "LIFT GATE - FOR NON WAREHOUSE ORDERS",
        "depends on the order location",
        "Fanny Deng",
        "Customer Name: Yixi Trading",
        "12",
        "Christine",
        "YES",
      ],
    ];
    const header = helpers.findCustomerDbHeader_(rows);
    const records = helpers.buildCustomerRecords_(rows, header);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: "Fanloli Beauty",
      accessories: "LIFT GATE - FOR NON WAREHOUSE ORDERS",
      references: "Customer Name: Yixi Trading",
      storeCount: "12",
      salesRep: "Christine",
    });
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

// Round 5 (2026-08-24, Codex review on PR #92): a same-batch stub created
// with no address (the first occurrence of a brand-new customer in a
// multi-row paste, before any address is known) must have its address
// filled in once a later occurrence in the same paste supplies one — not
// stay permanently addressless just because customerAddressConflicts_'s
// blank-side bypass means there's no "conflict" to flag.
describe("WH Trucking Request customer lookup: filling a blank address supplied later in the same batch", () => {
  it("is fillable when the row supplies an address and the record has none on file", () => {
    const record = makeRecord({ name: "Acme Co", address: "" });
    expect(helpers.customerAddressFillable_(record, "123 Main St")).toBe(true);
  });

  it("is not fillable when there is no address to fill with", () => {
    const record = makeRecord({ name: "Acme Co", address: "" });
    expect(helpers.customerAddressFillable_(record, "")).toBe(false);
  });

  it("is not fillable when the record already has an address (that's a potential conflict, not a fill)", () => {
    const record = makeRecord({ name: "Acme Co", address: "123 Main St" });
    expect(helpers.customerAddressFillable_(record, "456 Oak St")).toBe(false);
  });

  it("fillCustomerAddress_ writes only the address cell on the matched row", () => {
    const sheet = makeFakeDbSheet();
    const header: DbHeader = { rowIndex: 0, map: { "CUSTOMER NAME": 0, ADDRESS: 1 } };
    const record = makeRecord({ name: "Acme Co", rowNumber: 42 });

    helpers.fillCustomerAddress_(sheet, header, record, "9 Fill St");

    expect(sheet.writes).toEqual([{ row: 42, col: 2, value: "9 Fill St" }]);
  });
});

// Round 5: the same cross-location risk CustomerBackfill.gs's
// matchedByExactName_ guards against — a canonical-only match (e.g. "MEGA
// MART (FREMONT)" resolving to the lone existing "MEGA MART (PALO ALTO)"
// row because Fremont has no row of its own yet) must never be trusted
// enough to fill an existing row's address, or it corrupts a different
// physical location's data.
describe("WH Trucking Request customer lookup: exact-vs-canonical match distinction", () => {
  it("is an exact match when the typed name equals the record's name (case/whitespace-insensitive)", () => {
    const record = makeRecord({ name: "Acme Co" });
    expect(helpers.matchedByExactName_("  acme co  ", record)).toBe(true);
  });

  it("is not an exact match when only the canonical/brand-alias key agrees", () => {
    const record = makeRecord({ name: "MEGA MART (PALO ALTO)" });
    expect(helpers.matchedByExactName_("MEGA MART (FREMONT)", record)).toBe(false);
  });
});

// Round 6 (2026-08-24, Codex review on PR #92): staff commonly type the
// customer name and its address as two SEPARATE edits (type name, tab/click
// to the address cell, type address) — each its own onEdit event. Gating on
// the customer column alone meant the second, address-only edit never
// reached customerAddressFillable_ at all, so a customer created with a
// blank address by the first edit stayed permanently addressless.
describe("WH Trucking Request customer lookup: processing address-only edits", () => {
  const CUSTOMER_COL = 1;
  const ADDRESS_COL = 3;
  const UNRELATED_COL = 10;

  it("processes an edit that touches only the customer column", () => {
    expect(helpers.shouldProcessCustomerLookupEdit_(CUSTOMER_COL, ADDRESS_COL, CUSTOMER_COL, CUSTOMER_COL)).toBe(true);
  });

  it("processes an edit that touches only the address column", () => {
    expect(helpers.shouldProcessCustomerLookupEdit_(CUSTOMER_COL, ADDRESS_COL, ADDRESS_COL, ADDRESS_COL)).toBe(true);
  });

  it("processes a multi-column edit spanning both", () => {
    expect(helpers.shouldProcessCustomerLookupEdit_(CUSTOMER_COL, ADDRESS_COL, CUSTOMER_COL, ADDRESS_COL)).toBe(true);
  });

  it("ignores an edit that touches neither column", () => {
    expect(helpers.shouldProcessCustomerLookupEdit_(CUSTOMER_COL, ADDRESS_COL, UNRELATED_COL, UNRELATED_COL)).toBe(false);
  });

  it("ignores an edit to an unrelated column even when there is no ADDRESS column at all", () => {
    expect(helpers.shouldProcessCustomerLookupEdit_(CUSTOMER_COL, null, UNRELATED_COL, UNRELATED_COL)).toBe(false);
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

// Round 8 (2026-08-24, Codex review on PR #92): a canonical-only match (e.g.
// "MEGA MART (FREMONT)" resolving to the lone existing "MEGA MART (PALO
// ALTO)" row) is gated off address-fill writes by matchedByExactName_ already,
// but the note-append itself was never gated the same way — so it still
// attached the WRONG location's contact/services into the row's NOTE column.
// logCanonicalMatchNeedsReview_ is the review-only path that replaces any
// write in that case, mirroring CustomerBackfill.gs's
// canonical-match-needs-review classification.
describe("WH Trucking Request customer lookup: canonical-only matches route to review, never a write", () => {
  it("logs a CANONICAL MATCH NEEDS REVIEW row identifying both the typed name and the matched record", () => {
    const spreadsheet = makeFakeSpreadsheet();
    const record = makeRecord({ name: "MEGA MART (PALO ALTO)", rowNumber: 17 });

    helpers.logCanonicalMatchNeedsReview_(spreadsheet, "MEGA MART (FREMONT)", 203, record);

    const log = spreadsheet.getSheetByName("PIPELINE LOG");
    expect(log?.rows[0]).toEqual(["Timestamp", "Event", "Subject", "Detail"]);
    expect(log?.rows[1]?.slice(1, 3)).toEqual(["CUSTOMER LOOKUP CANONICAL MATCH NEEDS REVIEW", "MEGA MART (FREMONT)"]);

    const detail = JSON.parse(log?.rows[1]?.[3] as string);
    expect(detail).toEqual({
      action: "canonical-match-needs-review",
      customer: "MEGA MART (FREMONT)",
      whTruckingRow: 203,
      matchedTruckingRow: 17,
      matchedTruckingName: "MEGA MART (PALO ALTO)",
    });
  });

  it("distinguishes the case where a write is actually safe (exact match) from one where it is not (canonical-only)", () => {
    // This is the exact routing decision handleWhTruckingCustomerEdit_ makes:
    // matchedByExactName_ true -> safe to write; false -> logCanonicalMatchNeedsReview_
    // only, never appendCustomerNote_/fillCustomerAddress_. Assert both sides
    // of that gate hold for the same fixture pair used above.
    const exactRecord = makeRecord({ name: "MEGA MART (PALO ALTO)" });
    expect(helpers.matchedByExactName_("MEGA MART (PALO ALTO)", exactRecord)).toBe(true);
    expect(helpers.matchedByExactName_("MEGA MART (FREMONT)", exactRecord)).toBe(false);
  });
});

// Round 9 (2026-08-24, Codex review on PR #92): staff typing the customer
// name and address as two separate edits (round 6) matches the same record
// twice — the first edit (address still blank on file) appends Contact/
// Services alone; the second, after fillCustomerAddress_ fills the address,
// re-runs appendCustomerNote_ with the now-complete record. Comparing the
// full combined note string against the existing cell missed that the
// Contact/Services portion was already there, duplicating it on every fill.
describe("WH Trucking Request customer lookup: appending a note never duplicates already-written sections", () => {
  it("appends the full note on a bare cell", () => {
    const sheet = makeFakeNoteSheet("");
    const record = makeRecord({ name: "Acme Co", address: "123 Main St", contact: "Jane Doe" });

    helpers.appendCustomerNote_(sheet, 5, 20, record);

    expect(sheet.writes).toEqual([{ row: 5, col: 20, value: "Address: 123 Main St | Contact: Jane Doe" }]);
  });

  it("writes nothing when the exact same note is already present", () => {
    const sheet = makeFakeNoteSheet("Address: 123 Main St | Contact: Jane Doe");
    const record = makeRecord({ name: "Acme Co", address: "123 Main St", contact: "Jane Doe" });

    helpers.appendCustomerNote_(sheet, 5, 20, record);

    expect(sheet.writes).toEqual([]);
  });

  it("appends only the newly-available address section instead of re-adding contact/services (the round-9 bug)", () => {
    // The first, customer-only edit already wrote Contact/Services while the
    // address was still blank on file.
    const sheet = makeFakeNoteSheet("Contact: Jane Doe | Services: Liftgate");
    // The second, address-only edit fills the address and calls this with
    // the now-complete record.
    const record = makeRecord({ name: "Acme Co", address: "123 Main St", contact: "Jane Doe", services: ["Liftgate"] });

    helpers.appendCustomerNote_(sheet, 5, 20, record);

    expect(sheet.writes).toEqual([
      { row: 5, col: 20, value: "Contact: Jane Doe | Services: Liftgate\nAddress: 123 Main St" },
    ]);
  });

  // Round 10 (2026-08-24, Codex review on PR #92): the per-section
  // duplicate check used plain string indexOf, a raw substring search — a
  // staff-typed manual note containing a generated section as a substring
  // of a longer line (not the section itself) was wrongly treated as
  // "already present" and silently dropped, instead of appending the real
  // current value.
  it("still appends a section that only appears as a substring of a longer manual line", () => {
    const sheet = makeFakeNoteSheet("Previous Address: 999 Old St");
    const record = makeRecord({ name: "Acme Co", address: "123 Main St" });

    helpers.appendCustomerNote_(sheet, 5, 20, record);

    expect(sheet.writes).toEqual([
      { row: 5, col: 20, value: "Previous Address: 999 Old St\nAddress: 123 Main St" },
    ]);
  });

  it("still appends a section whose text is a substring of an unrelated existing section", () => {
    const sheet = makeFakeNoteSheet("Contact: Jane Doe (old, no longer active)");
    const record = makeRecord({ name: "Acme Co", contact: "Jane Doe" });

    helpers.appendCustomerNote_(sheet, 5, 20, record);

    expect(sheet.writes).toEqual([
      { row: 5, col: 20, value: "Contact: Jane Doe (old, no longer active)\nContact: Jane Doe" },
    ]);
  });
});
