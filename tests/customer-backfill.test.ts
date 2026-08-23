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
    classification: "would-create" | "would-flag-second-location" | "would-fill-missing-address" | "ok-no-action";
    matchedRecord: CustomerRecord | null;
    proposedAddress: string;
    existingAddress: string | null;
    addressVariants: string[];
    sourcesUsed: string[];
  };
};

function loadBackfillHelpers(): BackfillHelpers {
  const codeSource = readFileSync("google-apps-script/Code.gs", "utf8");
  const backfillSource = readFileSync("google-apps-script/CustomerBackfill.gs", "utf8");
  const context = vm.createContext({ Map, Set, Object, console });

  vm.runInContext(
    `${codeSource}\n${backfillSource}\n;globalThis.__backfill = {` +
      "findB2bTruckingHeader_,buildB2bCustomerAggregates_,findCustomerEntryHeader_," +
      "mergeCustomerEntryAddresses_,findBackfillCustomerDbHeader_,buildBackfillCustomerRecords_," +
      "matchBackfillCustomerRecord_,classifyCustomerCandidate_};",
    context,
  );
  return context.__backfill as BackfillHelpers;
}

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
  // matched to either location.
  it("never guesses between two TRUCKING records sharing a canonical key — treats it as a new candidate", () => {
    const rows = makeTruckingRows([
      { name: "Mega Mart (Palo Alto)", address: "1 First Loc" },
      { name: "Mega Mart - Fremont", address: "2 Second Loc" },
    ]);
    const header = helpers.findBackfillCustomerDbHeader_(rows);
    const records = helpers.buildBackfillCustomerRecords_(rows, header);
    const aggregate = makeAggregate("Mega Mart", { "B2B/E-COM TRUCKING": ["3 Third Loc"] });

    const result = helpers.classifyCustomerCandidate_("Mega Mart", aggregate, records);
    expect(result.classification).toBe("would-create");
    expect(result.matchedRecord).toBeNull();
  });
});
