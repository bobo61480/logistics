import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type CustomerRecord = {
  rowNumber: number;
  name: string;
  exactKey: string;
  canonicalKey: string;
  address: string;
};

type Aggregate = {
  name: string;
  occurrenceCount: number;
  addressesBySource: Record<string, string[]>;
  sampleRows: number[];
};

type Header = { rowIndex: number; map: Record<string, number> };
type B2bHeader = { rowIndex: number; nameCol: number; addressCol: number };

type FakeWrite = { row: number; col: number; numRows: number; numCols: number; values?: unknown[][]; value?: unknown };
type FakeSheet = { writes: FakeWrite[]; getRange: (row: number, col: number, numRows?: number, numCols?: number) => unknown };

type BackfillHelpers = {
  findB2bTruckingHeader_: (rows: string[][]) => B2bHeader;
  buildB2bCustomerAggregates_: (
    rows: string[][],
    header: B2bHeader,
  ) => { aggregates: Map<string, Aggregate>; skippedBlankNameRows: number };
  findCustomerEntryHeader_: (rows: string[][]) => Header;
  mergeCustomerEntryAddresses_: (aggregates: Map<string, Aggregate>, rows: string[][], header: Header) => void;
  findBackfillCustomerDbHeader_: (rows: string[][]) => Header;
  buildBackfillCustomerRecords_: (rows: string[][], header: Header) => CustomerRecord[];
  matchBackfillCustomerRecord_: (customerValue: string, records: CustomerRecord[]) => CustomerRecord | null;
  classifyCustomerCandidate_: (
    name: string,
    aggregate: Aggregate,
    truckingRecords: CustomerRecord[],
  ) => {
    classification:
      | "would-create"
      | "would-flag-second-location"
      | "would-fill-missing-address"
      | "would-repair-split-rename"
      | "ambiguous-location-family"
      | "canonical-match-needs-review"
      | "ok-no-action";
    matchedRecord: CustomerRecord | null;
    proposedAddress: string;
    pendingAddresses: string[];
    existingAddress: string | null;
    addressVariants: string[];
    sourcesUsed: string[];
  };
  stripBackfillLocationSuffix_: (name: string) => string;
  nextCustomerLocationSuffix_: (baseName: string, records: CustomerRecord[]) => number;
  isBackfillAmbiguousLocationFamily_: (customerValue: string, records: CustomerRecord[]) => boolean;
  isSuffixLocationFamily_: (customerValue: string, records: CustomerRecord[]) => boolean;
  hasEstablishedSuffixConvention_: (customerValue: string, records: CustomerRecord[]) => boolean;
  appendBackfillCustomer_: (sheet: FakeSheet, header: Header, name: string, address: string, targetRow: number) => void;
  fillBackfillCustomerAddress_: (sheet: FakeSheet, header: Header, matchedRecord: CustomerRecord, address: string) => void;
  flagBackfillSecondLocation_: (
    sheet: FakeSheet,
    header: Header,
    records: CustomerRecord[],
    matchedRecord: CustomerRecord,
    newAddress: string,
    targetRow: number,
  ) => string;
  appendNewFamilyLocation_: (
    sheet: FakeSheet,
    header: Header,
    baseName: string,
    records: CustomerRecord[],
    newAddress: string,
    targetRow: number,
  ) => string;
  renameToFirstLocation_: (sheet: FakeSheet, header: Header, matchedRecord: CustomerRecord) => string;
  createBackfillCustomerWithLocations_: (
    sheet: FakeSheet,
    header: Header,
    records: CustomerRecord[],
    name: string,
    addresses: string[],
    targetRow: number,
  ) => number;
  matchedByExactBackfillName_: (customerValue: string, record: CustomerRecord) => boolean;
  logCustomerBackfillCandidate_: (
    name: string,
    aggregate: Aggregate,
    classification: unknown,
    writeError?: Error,
  ) => void;
};

type LoggedCall = { tag: string; subject: string; detail: unknown };

function loadBackfillHelpers(loggedCalls?: LoggedCall[]): BackfillHelpers {
  const codeSource = readFileSync("google-apps-script/Code.gs", "utf8");
  const backfillSource = readFileSync("google-apps-script/CustomerBackfill.gs", "utf8");
  // logPipeline_ lives in GmailPipeline.gs (not concatenated here) and
  // Logger is a real Apps Script global — stub both so
  // logCustomerBackfillCandidate_'s try/catch body can actually run instead
  // of throwing a ReferenceError before any test can observe its behavior.
  const context = vm.createContext({
    Map,
    Set,
    Object,
    console,
    Logger: { log: () => {} },
    logPipeline_: (tag: string, subject: string, detail: unknown) => {
      loggedCalls?.push({ tag, subject, detail });
    },
  });

  vm.runInContext(
    `${codeSource}\n${backfillSource}\n;globalThis.__backfill = {` +
      "findB2bTruckingHeader_,buildB2bCustomerAggregates_,findCustomerEntryHeader_," +
      "mergeCustomerEntryAddresses_,findBackfillCustomerDbHeader_,buildBackfillCustomerRecords_," +
      "matchBackfillCustomerRecord_,classifyCustomerCandidate_,stripBackfillLocationSuffix_," +
      "nextCustomerLocationSuffix_,appendBackfillCustomer_,fillBackfillCustomerAddress_," +
      "flagBackfillSecondLocation_,isBackfillAmbiguousLocationFamily_,isSuffixLocationFamily_," +
      "hasEstablishedSuffixConvention_,appendNewFamilyLocation_,renameToFirstLocation_," +
      "createBackfillCustomerWithLocations_,matchedByExactBackfillName_,logCustomerBackfillCandidate_};",
    context,
  );
  return context.__backfill as BackfillHelpers;
}

function makeFakeSheet(): FakeSheet {
  const writes: FakeWrite[] = [];
  return {
    writes,
    getRange(row: number, col: number, numRows?: number, numCols?: number) {
      return {
        setValues(values: unknown[][]) {
          writes.push({ row, col, numRows: numRows ?? 1, numCols: numCols ?? 1, values });
        },
        setValue(value: unknown) {
          writes.push({ row, col, numRows: 1, numCols: 1, value });
        },
      };
    },
  };
}

const TRUCKING_HEADER: Header = { rowIndex: 0, map: { "CUSTOMER NAME": 0, ADDRESS: 1 } };

const helpers = loadBackfillHelpers();

const B2B_HEADER_ROW = ["NOTE", "NOTE", "FROM", "TO", "PLT", "PU", "TRUCKING", "PRO#", "RATE", "INVOICE"];

function makeTruckingRows(records: Array<{ name: string; address?: string }>): string[][] {
  return [["Customer Name", "Address"], ...records.map((r) => [r.name, r.address || ""])];
}

describe("customer backfill: B2B/E-Com header detection", () => {
  it("locates the header row despite columns A and B sharing the 'NOTE' label", () => {
    const rows = [["irrelevant"], B2B_HEADER_ROW, ["", "Customer A", "LA", "123 Main St"]];
    const header = helpers.findB2bTruckingHeader_(rows);
    expect(header).toEqual({ rowIndex: 1, nameCol: 1, addressCol: 3 });
  });

  it("throws when the structural anchors do not all line up", () => {
    const rows = [["NOTE", "NOTE", "FROM", "SHIP TO", "", "", "", "", "", "INVOICE"]];
    expect(() => helpers.findB2bTruckingHeader_(rows)).toThrow(
      "Could not locate the B2B/E-COM TRUCKING header row.",
    );
  });
});

describe("customer backfill: B2B/E-Com aggregation", () => {
  it("counts occurrences and collects distinct addresses per exact customer name", () => {
    const rows = [
      B2B_HEADER_ROW,
      ["", "Customer A", "LA", "123 Main St"],
      ["", "Customer A", "LA", "123 Main St"],
      ["", "Customer A", "LA", "456 Other Ave"],
      ["", "Customer B", "LA", ""],
    ];
    const header = helpers.findB2bTruckingHeader_(rows);
    const { aggregates } = helpers.buildB2bCustomerAggregates_(rows, header);

    const customerA = aggregates.get("CUSTOMER A")!;
    expect(customerA.occurrenceCount).toBe(3);
    expect(customerA.addressesBySource["B2B/E-COM TRUCKING"]).toEqual(["123 Main St", "456 Other Ave"]);

    const customerB = aggregates.get("CUSTOMER B")!;
    expect(customerB.occurrenceCount).toBe(1);
    expect(customerB.addressesBySource["B2B/E-COM TRUCKING"]).toBeUndefined();
  });

  it("counts a row with data but a blank customer-name cell instead of guessing whose row it is", () => {
    const rows = [
      B2B_HEADER_ROW,
      ["SAMPLE SHIPMENT", "", "LA", "123 Main St"],
      ["", "Customer A", "LA", "123 Main St"],
      ["", "", "", ""],
    ];
    const header = helpers.findB2bTruckingHeader_(rows);
    const { aggregates, skippedBlankNameRows } = helpers.buildB2bCustomerAggregates_(rows, header);

    expect(skippedBlankNameRows).toBe(1);
    expect(aggregates.size).toBe(1);
    expect(aggregates.has("CUSTOMER A")).toBe(true);
  });
});

describe("customer backfill: Customer Entry merge", () => {
  it("adds a Customer Entry address only to names already seen in the B2B log", () => {
    const b2bRows = [B2B_HEADER_ROW, ["", "Customer A", "LA", "123 Main St"]];
    const b2bHeader = helpers.findB2bTruckingHeader_(b2bRows);
    const { aggregates } = helpers.buildB2bCustomerAggregates_(b2bRows, b2bHeader);

    const entryRows = [
      ["Customer Name", "Address"],
      ["Customer A", "999 Entry Rd"],
      ["Customer Z (not in B2B log)", "1 Nowhere Ln"],
    ];
    const entryHeader = helpers.findCustomerEntryHeader_(entryRows);
    helpers.mergeCustomerEntryAddresses_(aggregates, entryRows, entryHeader);

    expect(aggregates.get("CUSTOMER A")!.addressesBySource["Customer Entry"]).toEqual(["999 Entry Rd"]);
    expect(aggregates.has("CUSTOMER Z (NOT IN B2B LOG)")).toBe(false);
  });
});

describe("customer backfill: candidate classification", () => {
  function makeAggregate(name: string, addresses: Record<string, string[]> = {}): Aggregate {
    return { name, occurrenceCount: 1, addressesBySource: addresses, sampleRows: [10] };
  }

  it("proposes a new customer when no TRUCKING record matches at all", () => {
    const records = helpers.buildBackfillCustomerRecords_(
      makeTruckingRows([{ name: "Existing Co", address: "1 First St" }]),
      helpers.findBackfillCustomerDbHeader_(makeTruckingRows([{ name: "Existing Co", address: "1 First St" }])),
    );
    const aggregate = makeAggregate("Brand New Customer", { "B2B/E-COM TRUCKING": ["55 New Ave"] });

    const result = helpers.classifyCustomerCandidate_("Brand New Customer", aggregate, records);
    expect(result.classification).toBe("would-create");
    expect(result.proposedAddress).toBe("55 New Ave");
  });

  it("takes no action when the observed address matches the existing TRUCKING record exactly", () => {
    const rows = makeTruckingRows([{ name: "Matched Co", address: "100 Same St" }]);
    const header = helpers.findBackfillCustomerDbHeader_(rows);
    const records = helpers.buildBackfillCustomerRecords_(rows, header);
    const aggregate = makeAggregate("Matched Co", { "B2B/E-COM TRUCKING": ["100 Same St"] });

    const result = helpers.classifyCustomerCandidate_("Matched Co", aggregate, records);
    expect(result.classification).toBe("ok-no-action");
  });

  it("flags a second location for even a whitespace/punctuation-only address difference (no normalization)", () => {
    const rows = makeTruckingRows([{ name: "Picky Co", address: "100 Same St" }]);
    const header = helpers.findBackfillCustomerDbHeader_(rows);
    const records = helpers.buildBackfillCustomerRecords_(rows, header);
    const aggregate = makeAggregate("Picky Co", { "B2B/E-COM TRUCKING": ["100 Same St."] });

    const result = helpers.classifyCustomerCandidate_("Picky Co", aggregate, records);
    expect(result.classification).toBe("would-flag-second-location");
    expect(result.existingAddress).toBe("100 Same St");
    expect(result.proposedAddress).toBe("100 Same St.");
  });

  it("fills in a missing address when the TRUCKING record has none on file yet", () => {
    const rows = makeTruckingRows([{ name: "Blank Address Co" }]);
    const header = helpers.findBackfillCustomerDbHeader_(rows);
    const records = helpers.buildBackfillCustomerRecords_(rows, header);
    const aggregate = makeAggregate("Blank Address Co", { "Customer Entry": ["77 Fill Me In Dr"] });

    const result = helpers.classifyCustomerCandidate_("Blank Address Co", aggregate, records);
    expect(result.classification).toBe("would-fill-missing-address");
    expect(result.proposedAddress).toBe("77 Fill Me In Dr");
  });

  // Highest-value case: mirrors the exact discipline that fixed the
  // 2026-08-12 KORHEIM incident. canonicalWmsCustomer_'s aliasing collapses
  // any "MEGA MART..." variant to the single canonical key "MEGA MART"
  // regardless of a location suffix — so two distinct per-location TRUCKING
  // records (e.g. "Mega Mart (Palo Alto)" and "Mega Mart - Fremont") share
  // one canonical key. A log entry for that brand must never be silently
  // matched to either location — and, since 2026-08-24's live-write rollout
  // (Codex review on PR #92), must also never be treated as "no match at
  // all" and created as a fresh blank duplicate; it's classified as its own
  // "ambiguous-location-family" outcome instead, logged for a human, never
  // written.
  it("never guesses between two TRUCKING records sharing a canonical key — flags it as ambiguous, never creates", () => {
    const rows = makeTruckingRows([
      { name: "Mega Mart (Palo Alto)", address: "1 First Loc" },
      { name: "Mega Mart - Fremont", address: "2 Second Loc" },
    ]);
    const header = helpers.findBackfillCustomerDbHeader_(rows);
    const records = helpers.buildBackfillCustomerRecords_(rows, header);
    const aggregate = makeAggregate("Mega Mart", { "B2B/E-COM TRUCKING": ["3 Third Loc"] });

    const result = helpers.classifyCustomerCandidate_("Mega Mart", aggregate, records);
    expect(result.classification).toBe("ambiguous-location-family");
    expect(result.matchedRecord).toBeNull();
  });

  it("flags a base name already split into numbered locations as ambiguous rather than creating another duplicate", () => {
    // The exact scenario the fix addresses: after flagBackfillSecondLocation_
    // renames "Acme Co" to "Acme Co - 1" and appends "Acme Co - 2", the bare
    // "Acme Co" name (which will keep appearing in the B2B log every day)
    // must never again read as "no match at all".
    const rows = makeTruckingRows([
      { name: "Acme Co - 1", address: "1 First Loc" },
      { name: "Acme Co - 2", address: "2 Second Loc" },
    ]);
    const header = helpers.findBackfillCustomerDbHeader_(rows);
    const records = helpers.buildBackfillCustomerRecords_(rows, header);
    const aggregate = makeAggregate("Acme Co", { "B2B/E-COM TRUCKING": ["1 First Loc"] });

    const result = helpers.classifyCustomerCandidate_("Acme Co", aggregate, records);
    expect(result.classification).toBe("ambiguous-location-family");
  });

  it("processes every distinct address not yet on file anywhere in the family, not just the first", () => {
    const rows = makeTruckingRows([{ name: "Multi Co", address: "1 Known St" }]);
    const header = helpers.findBackfillCustomerDbHeader_(rows);
    const records = helpers.buildBackfillCustomerRecords_(rows, header);
    const aggregate = makeAggregate("Multi Co", {
      "B2B/E-COM TRUCKING": ["1 Known St", "2 New St"],
      "Customer Entry": ["3 Also New St"],
    });

    const result = helpers.classifyCustomerCandidate_("Multi Co", aggregate, records);
    expect(result.classification).toBe("would-flag-second-location");
    expect(result.pendingAddresses).toEqual(["2 New St", "3 Also New St"]);
  });

  it("does not re-flag an address that's already on file for a sibling location in the same family", () => {
    const rows = makeTruckingRows([
      { name: "Sibling Co - 1", address: "1 First Loc" },
      { name: "Sibling Co - 2", address: "2 Second Loc" },
    ]);
    const header = helpers.findBackfillCustomerDbHeader_(rows);
    const records = helpers.buildBackfillCustomerRecords_(rows, header);
    // Matches "Sibling Co - 1" exactly; the observed address is already on
    // file for the sibling "- 2" location, not a genuinely new one.
    const aggregate = makeAggregate("Sibling Co - 1", { "B2B/E-COM TRUCKING": ["2 Second Loc"] });

    const result = helpers.classifyCustomerCandidate_("Sibling Co - 1", aggregate, records);
    expect(result.classification).toBe("ok-no-action");
  });
});

describe("customer backfill: live writes (2026-08-24 rollout)", () => {
  it("flags ambiguity via the '- N' suffix family, independent of canonical aliasing", () => {
    const records = [
      { name: "Acme Co - 1" } as CustomerRecord,
      { name: "Acme Co - 2" } as CustomerRecord,
    ];
    expect(helpers.isBackfillAmbiguousLocationFamily_("Acme Co", records)).toBe(true);
  });

  it("flags ambiguity via canonical-key aliasing (e.g. MEGA MART), independent of suffix stripping", () => {
    const records = [
      { name: "Mega Mart (Palo Alto)", canonicalKey: "MEGA MART" } as CustomerRecord,
      { name: "Mega Mart - Fremont", canonicalKey: "MEGA MART" } as CustomerRecord,
    ];
    expect(helpers.isBackfillAmbiguousLocationFamily_("Mega Mart", records)).toBe(true);
  });

  it("is not ambiguous for a single, unrelated record", () => {
    const records = [{ name: "Someone Else Co", canonicalKey: "SOMEONE ELSE CO" } as CustomerRecord];
    expect(helpers.isBackfillAmbiguousLocationFamily_("Acme Co", records)).toBe(false);
  });

  it("strips a trailing numeric location suffix, leaving unsuffixed names untouched", () => {
    expect(helpers.stripBackfillLocationSuffix_("OVER N OVER Over Beauty - 2")).toBe("OVER N OVER Over Beauty");
    expect(helpers.stripBackfillLocationSuffix_("Plain Customer Co")).toBe("Plain Customer Co");
  });

  it("treats an unsuffixed record as implicit location 1, so the first real duplicate becomes 2", () => {
    const records = [{ name: "Acme Co" } as CustomerRecord];
    expect(helpers.nextCustomerLocationSuffix_("Acme Co", records)).toBe(2);
  });

  it("appends after the highest existing suffix rather than filling a gap", () => {
    const records = [
      { name: "Acme Co - 1" } as CustomerRecord,
      { name: "Acme Co - 2" } as CustomerRecord,
    ];
    expect(helpers.nextCustomerLocationSuffix_("Acme Co", records)).toBe(3);
  });

  it("ignores records for a different base name entirely", () => {
    const records = [{ name: "Unrelated Co - 1" } as CustomerRecord];
    expect(helpers.nextCustomerLocationSuffix_("Acme Co", records)).toBe(1);
  });

  it("appends a brand-new customer row with name and address at the target row", () => {
    const sheet = makeFakeSheet();
    helpers.appendBackfillCustomer_(sheet, TRUCKING_HEADER, "Brand New Co", "1 New Ave", 42);
    expect(sheet.writes).toEqual([{ row: 42, col: 1, numRows: 1, numCols: 2, values: [["Brand New Co", "1 New Ave"]] }]);
  });

  it("fills only the address cell on the matched row, leaving the name column untouched", () => {
    const sheet = makeFakeSheet();
    const matched = { rowNumber: 7 } as CustomerRecord;
    helpers.fillBackfillCustomerAddress_(sheet, TRUCKING_HEADER, matched, "9 Fill St");
    expect(sheet.writes).toEqual([{ row: 7, col: 2, numRows: 1, numCols: 1, value: "9 Fill St" }]);
  });

  // Round 2 (2026-08-24, Codex review on PR #92): the new row is appended
  // BEFORE the rename, not after — so a partial-write failure leaves the
  // original row's name untouched (still exact-matchable on a later run)
  // instead of orphaning a renamed "- 1" row that nothing can find again.
  it("appends the new location before renaming an unsuffixed matched row to '- 1'", () => {
    const sheet = makeFakeSheet();
    const matched = { rowNumber: 5, name: "Acme Co", exactKey: "ACME CO" } as CustomerRecord;
    const otherRecords = [matched];

    const newName = helpers.flagBackfillSecondLocation_(sheet, TRUCKING_HEADER, otherRecords, matched, "2 Second Loc", 99);

    expect(newName).toBe("Acme Co - 2");
    expect(matched.name).toBe("Acme Co - 1");
    expect(sheet.writes).toEqual([
      { row: 99, col: 1, numRows: 1, numCols: 2, values: [["Acme Co - 2", "2 Second Loc"]] },
      { row: 5, col: 1, numRows: 1, numCols: 1, value: "Acme Co - 1" },
    ]);
  });

  it("does not rename an already-suffixed matched row, and numbers the new one after it", () => {
    const sheet = makeFakeSheet();
    const matched = { rowNumber: 5, name: "Acme Co - 1", exactKey: "ACME CO - 1" } as CustomerRecord;
    const otherRecords = [matched];

    const newName = helpers.flagBackfillSecondLocation_(sheet, TRUCKING_HEADER, otherRecords, matched, "3 Third Loc", 100);

    expect(newName).toBe("Acme Co - 2");
    expect(matched.name).toBe("Acme Co - 1");
    // Only the new-row append happens — no rename write for an already-suffixed row.
    expect(sheet.writes).toEqual([{ row: 100, col: 1, numRows: 1, numCols: 2, values: [["Acme Co - 2", "3 Third Loc"]] }]);
  });

  it("appends a new numbered location for an already-suffixed family without any rename", () => {
    const sheet = makeFakeSheet();
    const records = [
      { name: "Acme Co - 1" } as CustomerRecord,
      { name: "Acme Co - 2" } as CustomerRecord,
    ];

    const newName = helpers.appendNewFamilyLocation_(sheet, TRUCKING_HEADER, "Acme Co", records, "3 Third Loc", 101);

    expect(newName).toBe("Acme Co - 3");
    expect(sheet.writes).toEqual([{ row: 101, col: 1, numRows: 1, numCols: 2, values: [["Acme Co - 3", "3 Third Loc"]] }]);
  });

  it("recognizes a suffix family even when the query has different punctuation than the stored records", () => {
    const records = [
      { name: "Acme Co, Inc. - 1", canonicalKey: "" } as CustomerRecord,
      { name: "Acme Co, Inc. - 2", canonicalKey: "" } as CustomerRecord,
    ];
    expect(helpers.isSuffixLocationFamily_("Acme Co Inc", records)).toBe(true);
  });

  it("hasEstablishedSuffixConvention_ is true only when a sibling literally carries a '- N' suffix", () => {
    const suffixed = [
      { name: "Acme Co - 1" } as CustomerRecord,
      { name: "Acme Co - 2" } as CustomerRecord,
    ];
    expect(helpers.hasEstablishedSuffixConvention_("Acme Co", suffixed)).toBe(true);

    // Same canonical brand, but neither sibling has ever used "- N" naming —
    // isSuffixLocationFamily_/isBackfillAmbiguousLocationFamily_ still flag this as
    // ambiguous (never guess which location), but it's not safe to invent a
    // "- N" convention the sheet has never used for this family.
    const aliasOnly = [
      { name: "Mega Mart (Palo Alto)", canonicalKey: "MEGA MART" } as CustomerRecord,
      { name: "Mega Mart - Fremont", canonicalKey: "MEGA MART" } as CustomerRecord,
    ];
    expect(helpers.hasEstablishedSuffixConvention_("Mega Mart", aliasOnly)).toBe(false);
  });

  // Round 2 (2026-08-24): an ambiguous "- N" suffix family must still surface
  // (and, live, append) an address that's genuinely new to the whole family —
  // not hardcode pendingAddresses to empty and never write.
  it("surfaces a genuinely new address for an already-ambiguous suffix family instead of dropping it", () => {
    const rows = makeTruckingRows([
      { name: "Acme Co - 1", address: "1 First Loc" },
      { name: "Acme Co - 2", address: "2 Second Loc" },
    ]);
    const header = helpers.findBackfillCustomerDbHeader_(rows);
    const records = helpers.buildBackfillCustomerRecords_(rows, header);
    const aggregate = makeFamilyAggregate_("Acme Co", { "B2B/E-COM TRUCKING": ["3 Third Loc"] });

    const result = helpers.classifyCustomerCandidate_("Acme Co", aggregate, records);
    expect(result.classification).toBe("ambiguous-location-family");
    expect(result.pendingAddresses).toEqual(["3 Third Loc"]);
  });

  it("does not surface a pending address for an alias-only ambiguous family with no suffix convention", () => {
    const rows = makeTruckingRows([
      { name: "Mega Mart (Palo Alto)", address: "1 First Loc" },
      { name: "Mega Mart - Fremont", address: "2 Second Loc" },
    ]);
    const header = helpers.findBackfillCustomerDbHeader_(rows);
    const records = helpers.buildBackfillCustomerRecords_(rows, header);
    const aggregate = makeFamilyAggregate_("Mega Mart", { "B2B/E-COM TRUCKING": ["3 Third Loc"] });

    const result = helpers.classifyCustomerCandidate_("Mega Mart", aggregate, records);
    expect(result.classification).toBe("ambiguous-location-family");
    expect(result.pendingAddresses).toEqual([]);
  });

  // Round 3 (2026-08-24, Codex review on PR #92 commit f2cb740): the
  // ambiguity checks were canonicalized, but familyAddressesFor_ and
  // nextCustomerLocationSuffix_ still compared raw/simple-normalized base
  // names — a punctuation-variant candidate could pass the ambiguity check
  // yet still see no addresses on file for its family and get misnumbered.
  it("recognizes an address already on file for a punctuation-variant suffix family (not just spelled identically)", () => {
    const rows = makeTruckingRows([
      { name: "Acme Co, Inc. - 1", address: "1 First Loc" },
      { name: "Acme Co, Inc. - 2", address: "2 Second Loc" },
    ]);
    const header = helpers.findBackfillCustomerDbHeader_(rows);
    const records = helpers.buildBackfillCustomerRecords_(rows, header);
    // B2B log spells it without punctuation, and reports an address already
    // on file for "- 1" plus one genuinely new address.
    const aggregate = makeFamilyAggregate_("Acme Co Inc", {
      "B2B/E-COM TRUCKING": ["1 First Loc", "3 Third Loc"],
    });

    const result = helpers.classifyCustomerCandidate_("Acme Co Inc", aggregate, records);
    expect(result.classification).toBe("ambiguous-location-family");
    // Only the genuinely new address is pending — "1 First Loc" is already
    // on file for "- 1" and must not be re-flagged.
    expect(result.pendingAddresses).toEqual(["3 Third Loc"]);
  });

  it("numbers a new location after the highest existing suffix even when the query has different punctuation", () => {
    const records = [
      { name: "Acme Co, Inc. - 1" } as CustomerRecord,
      { name: "Acme Co, Inc. - 2" } as CustomerRecord,
    ];
    // Without canonicalizing the base key, this would wrongly return 1
    // (reading "Acme Co Inc" as an unrelated, un-suffixed base) instead of 3.
    expect(helpers.nextCustomerLocationSuffix_("Acme Co Inc", records)).toBe(3);
  });

  // Round 3, second finding: recovering from a flagBackfillSecondLocation_
  // call whose append succeeded but whose follow-up rename failed.
  describe("recovering a partial split (append succeeded, rename didn't)", () => {
    it("classifies an unsuffixed matched record with an already-suffixed sibling as needing a repair rename", () => {
      const rows = makeTruckingRows([
        { name: "Acme Co", address: "1 First Loc" },
        { name: "Acme Co - 2", address: "2 Second Loc" },
      ]);
      const header = helpers.findBackfillCustomerDbHeader_(rows);
      const records = helpers.buildBackfillCustomerRecords_(rows, header);
      // The B2B log's own address is already on file (for "- 2") — proving
      // this isn't reachable via the normal would-flag-second-location path.
      const aggregate = makeFamilyAggregate_("Acme Co", { "B2B/E-COM TRUCKING": ["2 Second Loc"] });

      const result = helpers.classifyCustomerCandidate_("Acme Co", aggregate, records);
      expect(result.classification).toBe("would-repair-split-rename");
      expect(result.matchedRecord?.name).toBe("Acme Co");
    });

    it("renameToFirstLocation_ writes only the rename, matching flagBackfillSecondLocation_'s own rename write", () => {
      const sheet = makeFakeSheet();
      const matched = { rowNumber: 5, name: "Acme Co", exactKey: "ACME CO" } as CustomerRecord;

      const renamed = helpers.renameToFirstLocation_(sheet, TRUCKING_HEADER, matched);

      expect(renamed).toBe("Acme Co - 1");
      expect(matched.name).toBe("Acme Co - 1");
      expect(sheet.writes).toEqual([{ row: 5, col: 1, numRows: 1, numCols: 1, value: "Acme Co - 1" }]);
    });

    it("does not misclassify a normal single-location match with no suffixed sibling as needing repair", () => {
      const rows = makeTruckingRows([{ name: "Solo Co", address: "1 Solo Loc" }]);
      const header = helpers.findBackfillCustomerDbHeader_(rows);
      const records = helpers.buildBackfillCustomerRecords_(rows, header);
      const aggregate = makeFamilyAggregate_("Solo Co", { "B2B/E-COM TRUCKING": ["1 Solo Loc"] });

      const result = helpers.classifyCustomerCandidate_("Solo Co", aggregate, records);
      expect(result.classification).toBe("ok-no-action");
    });
  });

  // Round 5 (2026-08-24, Codex review on PR #92): a canonical-only match
  // (e.g. "MEGA MART (FREMONT)" resolving to the lone existing "MEGA MART
  // (PALO ALTO)" row because Fremont doesn't have its own row yet) must
  // never be trusted enough to fill/rename/flag an existing row — it could
  // be a genuinely different physical location under the same multi-
  // location brand, and mutating it would corrupt that other location's
  // data. Only a literal exact-name match is trusted to write.
  describe("exact-vs-canonical match distinction (write safety)", () => {
    it("matchedByExactBackfillName_ is true only for a literal name match, not a canonical/brand-alias match", () => {
      const record = { name: "MEGA MART (PALO ALTO)", exactKey: "MEGA MART (PALO ALTO)" } as CustomerRecord;
      expect(helpers.matchedByExactBackfillName_("  mega mart (palo alto)  ", record)).toBe(true);
      expect(helpers.matchedByExactBackfillName_("MEGA MART (FREMONT)", record)).toBe(false);
    });

    it("routes a canonical-only match to review instead of filling the wrong location's address", () => {
      const rows = makeTruckingRows([{ name: "MEGA MART (PALO ALTO)", address: "" }]);
      const header = helpers.findBackfillCustomerDbHeader_(rows);
      const records = helpers.buildBackfillCustomerRecords_(rows, header);
      const aggregate = makeFamilyAggregate_("MEGA MART (FREMONT)", { "B2B/E-COM TRUCKING": ["1 Fremont Way"] });

      const result = helpers.classifyCustomerCandidate_("MEGA MART (FREMONT)", aggregate, records);
      expect(result.classification).toBe("canonical-match-needs-review");
      expect(result.matchedRecord?.name).toBe("MEGA MART (PALO ALTO)");
    });

    it("still fills a missing address for a genuine exact-name match", () => {
      const rows = makeTruckingRows([{ name: "Blank Address Co", address: "" }]);
      const header = helpers.findBackfillCustomerDbHeader_(rows);
      const records = helpers.buildBackfillCustomerRecords_(rows, header);
      const aggregate = makeFamilyAggregate_("Blank Address Co", { "B2B/E-COM TRUCKING": ["77 Fill Me In Dr"] });

      const result = helpers.classifyCustomerCandidate_("Blank Address Co", aggregate, records);
      expect(result.classification).toBe("would-fill-missing-address");
    });

    it("still fills a missing address for a punctuation-variant canonical match of the SAME single location", () => {
      // "Royal Imex, Inc." vs "ROYAL IMEX INC" is genuinely the same brand
      // with no known second location — matchedByExactBackfillName_ would say false
      // here too, so this documents the accepted tradeoff: a legitimate
      // spelling-variant match now also routes to review rather than
      // auto-filling, in exchange for never risking a cross-location write.
      const rows = makeTruckingRows([{ name: "ROYAL IMEX INC", address: "" }]);
      const header = helpers.findBackfillCustomerDbHeader_(rows);
      const records = helpers.buildBackfillCustomerRecords_(rows, header);
      const aggregate = makeFamilyAggregate_("Royal Imex, Inc.", { "B2B/E-COM TRUCKING": ["1 Depot Rd"] });

      const result = helpers.classifyCustomerCandidate_("Royal Imex, Inc.", aggregate, records);
      expect(result.classification).toBe("canonical-match-needs-review");
    });
  });

  // Round 5: a brand-new customer whose very first reconciliation pass
  // already shows 2+ distinct addresses must have every location created
  // now, not just the first — the rest were previously left to "whenever
  // the job happens to run again".
  describe("creating every known location for a brand-new customer in one pass", () => {
    it("surfaces every address beyond the first as pending on the would-create classification", () => {
      const aggregate = makeFamilyAggregate_("Brand New Multi Co", {
        "B2B/E-COM TRUCKING": ["1 First Loc", "2 Second Loc"],
        "Customer Entry": ["3 Third Loc"],
      });

      const result = helpers.classifyCustomerCandidate_("Brand New Multi Co", aggregate, []);
      expect(result.classification).toBe("would-create");
      expect(result.proposedAddress).toBe("1 First Loc");
      expect(result.pendingAddresses).toEqual(["2 Second Loc", "3 Third Loc"]);
    });

    it("leaves pendingAddresses empty when the brand-new customer only has one observed address", () => {
      const aggregate = makeFamilyAggregate_("Brand New Single Co", { "B2B/E-COM TRUCKING": ["1 Only Loc"] });
      const result = helpers.classifyCustomerCandidate_("Brand New Single Co", aggregate, []);
      expect(result.classification).toBe("would-create");
      expect(result.pendingAddresses).toEqual([]);
    });
  });

  // Round 6 (2026-08-24, Codex review on PR #92): the round-5 multi-location
  // would-create fix created "<name>" plus "<name> - 2/-3..." but never
  // renamed the primary row to "- 1" — until a later run's repair path
  // caught it, a live bare-name lookup would exact-match the still-
  // unsuffixed primary as the sole location and misapply its info to a
  // request meant for a different known location.
  describe("createBackfillCustomerWithLocations_", () => {
    it("creates a single-address customer unsuffixed, with no rename", () => {
      const sheet = makeFakeSheet();
      const records: CustomerRecord[] = [];

      const nextRow = helpers.createBackfillCustomerWithLocations_(
        sheet, TRUCKING_HEADER, records, "Solo Co", ["1 Solo Loc"], 50,
      );

      expect(nextRow).toBe(51);
      expect(sheet.writes).toEqual([{ row: 50, col: 1, numRows: 1, numCols: 2, values: [["Solo Co", "1 Solo Loc"]] }]);
      expect(records).toHaveLength(1);
      expect(records[0].name).toBe("Solo Co");
    });

    // Round 7 (2026-08-24, Codex review on PR #92): the FIRST sibling must
    // be appended BEFORE the primary is renamed to "- 1", not after — a
    // prior revision of this helper renamed first, so a transient failure
    // appending the very first sibling left an orphaned "- 1" row with no
    // sibling at all, neither an exact match nor an ambiguous family on the
    // next run. Reusing flagBackfillSecondLocation_ (already fixed for this
    // exact ordering in an earlier round) makes this correct by construction.
    it("appends the first sibling before renaming the primary row to '- 1'", () => {
      const sheet = makeFakeSheet();
      const records: CustomerRecord[] = [];

      const nextRow = helpers.createBackfillCustomerWithLocations_(
        sheet, TRUCKING_HEADER, records, "Multi Co", ["1 First Loc", "2 Second Loc", "3 Third Loc"], 50,
      );

      expect(nextRow).toBe(53);
      expect(sheet.writes).toEqual([
        { row: 50, col: 1, numRows: 1, numCols: 2, values: [["Multi Co", "1 First Loc"]] },
        { row: 51, col: 1, numRows: 1, numCols: 2, values: [["Multi Co - 2", "2 Second Loc"]] },
        { row: 50, col: 1, numRows: 1, numCols: 1, value: "Multi Co - 1" },
        { row: 52, col: 1, numRows: 1, numCols: 2, values: [["Multi Co - 3", "3 Third Loc"]] },
      ]);
      // No unsuffixed record left behind — a bare-name lookup can no longer
      // exact-match a single "obviously the only location" record.
      expect(records.map((r) => r.name)).toEqual(["Multi Co - 1", "Multi Co - 2", "Multi Co - 3"]);
    });
  });

  // Round 7: the would-fill-missing-address branch previously discarded
  // every observed address beyond the first outright (not even deferred to
  // a later run) when an exact-matched record's address was blank.
  describe("filling a missing address when 2+ distinct addresses are already known", () => {
    it("surfaces every address beyond the first as pending on the would-fill-missing-address classification", () => {
      const rows = makeTruckingRows([{ name: "Blank Address Co" }]);
      const header = helpers.findBackfillCustomerDbHeader_(rows);
      const records = helpers.buildBackfillCustomerRecords_(rows, header);
      const aggregate = makeFamilyAggregate_("Blank Address Co", {
        "B2B/E-COM TRUCKING": ["1 First Loc", "2 Second Loc"],
      });

      const result = helpers.classifyCustomerCandidate_("Blank Address Co", aggregate, records);
      expect(result.classification).toBe("would-fill-missing-address");
      expect(result.proposedAddress).toBe("1 First Loc");
      expect(result.pendingAddresses).toEqual(["2 Second Loc"]);
    });

    it("leaves pendingAddresses empty when only one address is observed", () => {
      const rows = makeTruckingRows([{ name: "Blank Address Co" }]);
      const header = helpers.findBackfillCustomerDbHeader_(rows);
      const records = helpers.buildBackfillCustomerRecords_(rows, header);
      const aggregate = makeFamilyAggregate_("Blank Address Co", { "B2B/E-COM TRUCKING": ["1 Only Loc"] });

      const result = helpers.classifyCustomerCandidate_("Blank Address Co", aggregate, records);
      expect(result.classification).toBe("would-fill-missing-address");
      expect(result.pendingAddresses).toEqual([]);
    });
  });
});

// Round 5: logging must happen AFTER a live write succeeds, not before —
// and record an explicit failure outcome (not silence, not a false
// success) when the write throws.
describe("customer backfill: log-after-write ordering and failure reporting", () => {
  it("tags a normal live log with CUSTOMER BACKFILL LIVE", () => {
    const calls: LoggedCall[] = [];
    const h = loadBackfillHelpers(calls);
    const aggregate = makeFamilyAggregate_("Acme Co", { "B2B/E-COM TRUCKING": ["1 Main St"] });
    const classification = h.classifyCustomerCandidate_("Acme Co", aggregate, []);

    h.logCustomerBackfillCandidate_("Acme Co", aggregate, classification);

    expect(calls).toHaveLength(1);
    expect(calls[0].tag).toBe("CUSTOMER BACKFILL LIVE");
  });

  it("tags a failed write with CUSTOMER BACKFILL WRITE FAILED and includes the error", () => {
    const calls: LoggedCall[] = [];
    const h = loadBackfillHelpers(calls);
    const aggregate = makeFamilyAggregate_("Acme Co", { "B2B/E-COM TRUCKING": ["1 Main St"] });
    const classification = h.classifyCustomerCandidate_("Acme Co", aggregate, []);

    h.logCustomerBackfillCandidate_("Acme Co", aggregate, classification, new Error("Sheets quota exceeded"));

    expect(calls).toHaveLength(1);
    expect(calls[0].tag).toBe("CUSTOMER BACKFILL WRITE FAILED");
    expect(JSON.parse(calls[0].detail as string).error).toBe("Sheets quota exceeded");
  });
});

function makeFamilyAggregate_(name: string, addresses: Record<string, string[]> = {}): Aggregate {
  return { name, occurrenceCount: 1, addressesBySource: addresses, sampleRows: [10] };
}
