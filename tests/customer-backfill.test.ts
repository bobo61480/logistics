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
      | "ambiguous-location-family"
      | "ok-no-action";
    matchedRecord: CustomerRecord | null;
    proposedAddress: string;
    pendingAddresses: string[];
    existingAddress: string | null;
    addressVariants: string[];
    sourcesUsed: string[];
  };
  stripCustomerLocationSuffix_: (name: string) => string;
  nextCustomerLocationSuffix_: (baseName: string, records: CustomerRecord[]) => number;
  isAmbiguousLocationFamily_: (customerValue: string, records: CustomerRecord[]) => boolean;
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
};

function loadBackfillHelpers(): BackfillHelpers {
  const codeSource = readFileSync("google-apps-script/Code.gs", "utf8");
  const backfillSource = readFileSync("google-apps-script/CustomerBackfill.gs", "utf8");
  const context = vm.createContext({ Map, Set, Object, console });

  vm.runInContext(
    `${codeSource}\n${backfillSource}\n;globalThis.__backfill = {` +
      "findB2bTruckingHeader_,buildB2bCustomerAggregates_,findCustomerEntryHeader_," +
      "mergeCustomerEntryAddresses_,findBackfillCustomerDbHeader_,buildBackfillCustomerRecords_," +
      "matchBackfillCustomerRecord_,classifyCustomerCandidate_,stripCustomerLocationSuffix_," +
      "nextCustomerLocationSuffix_,appendBackfillCustomer_,fillBackfillCustomerAddress_," +
      "flagBackfillSecondLocation_,isAmbiguousLocationFamily_,isSuffixLocationFamily_," +
      "hasEstablishedSuffixConvention_,appendNewFamilyLocation_};",
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
    expect(helpers.isAmbiguousLocationFamily_("Acme Co", records)).toBe(true);
  });

  it("flags ambiguity via canonical-key aliasing (e.g. MEGA MART), independent of suffix stripping", () => {
    const records = [
      { name: "Mega Mart (Palo Alto)", canonicalKey: "MEGA MART" } as CustomerRecord,
      { name: "Mega Mart - Fremont", canonicalKey: "MEGA MART" } as CustomerRecord,
    ];
    expect(helpers.isAmbiguousLocationFamily_("Mega Mart", records)).toBe(true);
  });

  it("is not ambiguous for a single, unrelated record", () => {
    const records = [{ name: "Someone Else Co", canonicalKey: "SOMEONE ELSE CO" } as CustomerRecord];
    expect(helpers.isAmbiguousLocationFamily_("Acme Co", records)).toBe(false);
  });

  it("strips a trailing numeric location suffix, leaving unsuffixed names untouched", () => {
    expect(helpers.stripCustomerLocationSuffix_("OVER N OVER Over Beauty - 2")).toBe("OVER N OVER Over Beauty");
    expect(helpers.stripCustomerLocationSuffix_("Plain Customer Co")).toBe("Plain Customer Co");
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
    // isSuffixLocationFamily_/isAmbiguousLocationFamily_ still flag this as
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
});

function makeFamilyAggregate_(name: string, addresses: Record<string, string[]> = {}): Aggregate {
  return { name, occurrenceCount: 1, addressesBySource: addresses, sampleRows: [10] };
}
