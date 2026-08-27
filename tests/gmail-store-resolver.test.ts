import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type StoreResolverHelpers = {
  resolveUltaDcFromEmailV2_: (text: string) => { customer: string; method: string } | null;
  resolveTjxDcFromEmailV2_: (text: string) => { customer: string; method: string } | null;
};

function loadStoreResolverHelpers(
  ultaRows: unknown[][],
  tjxRows: unknown[][],
  sourceOverride?: (src: string) => string,
) {
  let source = readFileSync("google-apps-script/GmailStoreResolverV2.gs", "utf8");
  if (sourceOverride) source = sourceOverride(source);

  const ultaSheet = { getDataRange: () => ({ getDisplayValues: () => ultaRows }) };
  const tjxSheet = { getDataRange: () => ({ getDisplayValues: () => tjxRows }) };
  const context = vm.createContext({
    console,
    GMAIL_PIPELINE: { masterId: "test-master" },
    writeLog_: () => {},
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (name: string) => {
          if (name === "ULTA") return ultaSheet;
          if (name === "TJX/ROSS") return tjxSheet;
          return null;
        },
      }),
    },
  });

  vm.runInContext(
    `${source}\n;globalThis.__store = { resolveUltaDcFromEmailV2_, resolveTjxDcFromEmailV2_ };`,
    context,
  );
  return context.__store as StoreResolverHelpers;
}

describe("resolveUltaDcFromEmailV2_", () => {
  const ultaRows = [
    ["DC", "Date", "PO#"],
    ["ULTA (FRESNO)", "", ""],
    ["ULTA (DALLAS)", "", ""],
  ];

  it("resolves an unambiguous city match", () => {
    const helpers = loadStoreResolverHelpers(ultaRows, []);
    const result = helpers.resolveUltaDcFromEmailV2_("Ship-to: 850 East Central Ave, Fresno, CA 93725");
    expect(result).toEqual({ customer: "ULTA (FRESNO)", method: "ulta-dc-city", confidence: "medium" });
  });

  it("never guesses when two DCs share the same city token", () => {
    const rows = [
      ["DC", "Date", "PO#"],
      ["ULTA (FRESNO)", "", ""],
      ["ULTA (FRESNO) ANNEX", "", ""],
    ];
    const helpers = loadStoreResolverHelpers(rows, []);
    const result = helpers.resolveUltaDcFromEmailV2_("Delivery to our Fresno location");
    expect(result).toBeNull();
  });

  it("returns null with no city signal in the text", () => {
    const helpers = loadStoreResolverHelpers(ultaRows, []);
    expect(helpers.resolveUltaDcFromEmailV2_("Generic shipment update, no address")).toBeNull();
  });

  it("is a full kill switch when disabled", () => {
    const helpers = loadStoreResolverHelpers(ultaRows, [], (src) =>
      src.replace("var GMAIL_STORE_RESOLVER_ENABLED_V2 = true;", "var GMAIL_STORE_RESOLVER_ENABLED_V2 = false;"),
    );
    expect(helpers.resolveUltaDcFromEmailV2_("Ship-to: Fresno, CA")).toBeNull();
  });

  // Regression for a Codex round-3 finding on PR #102: a whole-text city
  // search can't tell a directory city mentioned as the PICKUP/origin apart
  // from one mentioned as the actual destination. "Pickup in Fresno; deliver
  // to the new Phoenix DC" must not resolve to ULTA (FRESNO) just because
  // Fresno is the only directory-known city anywhere in the email — Phoenix
  // (the real destination) isn't on file yet, so this must resolve to null.
  it("does not resolve a directory city that only appears on a pickup/origin line", () => {
    const helpers = loadStoreResolverHelpers(ultaRows, []);
    const result = helpers.resolveUltaDcFromEmailV2_("Pickup: Fresno, CA\nDeliver to: Phoenix, AZ");
    expect(result).toBeNull();
  });

  it("still resolves the destination city when a pickup line names a different directory city", () => {
    const helpers = loadStoreResolverHelpers(ultaRows, []);
    const result = helpers.resolveUltaDcFromEmailV2_("Pickup: Fresno, CA\nDeliver to: Dallas, TX");
    expect(result).toEqual({ customer: "ULTA (DALLAS)", method: "ulta-dc-city", confidence: "medium" });
  });

  // Regression for a Codex round-4 finding: when pickup and destination
  // clauses share a single line, the previous line-level bucketing put the
  // WHOLE line (including the origin city) into the destination bucket
  // because "deliver to" matched first. Fresno must not leak into the
  // destination bucket just because it shares a line with "deliver to".
  it("does not leak an origin city into the destination bucket when both labels share one line", () => {
    const helpers = loadStoreResolverHelpers(ultaRows, []);
    const result = helpers.resolveUltaDcFromEmailV2_("Pickup: Fresno, CA; Deliver to: Phoenix, AZ");
    expect(result).toBeNull();
  });

  it("still resolves a same-line destination city when the origin city is different", () => {
    const helpers = loadStoreResolverHelpers(ultaRows, []);
    const result = helpers.resolveUltaDcFromEmailV2_("Pickup: Phoenix, AZ; Deliver to: Dallas, TX");
    expect(result).toEqual({ customer: "ULTA (DALLAS)", method: "ulta-dc-city", confidence: "medium" });
  });

  // Regression for a Codex round-5 finding: the destination-label
  // carry-forward previously had no reset at all, so a footer or
  // quoted-history block below a labeled (but not-yet-on-file) destination
  // silently inherited that label forever. "Ship-to: Phoenix" (unknown)
  // followed by a blank line and an unrelated "Dallas office" footer must
  // not resolve to Dallas just because it's textually below the last label.
  it("stops carrying a destination label forward past a blank line", () => {
    const helpers = loadStoreResolverHelpers(ultaRows, []);
    const result = helpers.resolveUltaDcFromEmailV2_("Ship-to: Phoenix\n\nDallas office");
    expect(result).toBeNull();
  });

  it("still carries a destination label across a real multi-line address with no blank line", () => {
    const helpers = loadStoreResolverHelpers(ultaRows, []);
    const result = helpers.resolveUltaDcFromEmailV2_("Ship To:\n123 Main St, Dallas, TX 75201");
    expect(result).toEqual({ customer: "ULTA (DALLAS)", method: "ulta-dc-city", confidence: "medium" });
  });
});

describe("resolveTjxDcFromEmailV2_", () => {
  const tjxRows = [
    ["Order Received", "Order Name", "DC#"],
    ["", "Ross 92k", "1234"],
    ["", "TJX Load", "5678"],
  ];

  it("resolves an exact DC# match", () => {
    const helpers = loadStoreResolverHelpers([], tjxRows);
    const result = helpers.resolveTjxDcFromEmailV2_("Please route to DC# 1234 for this load.");
    expect(result).toEqual({ customer: "1234", method: "tjx-dc-number", confidence: "medium" });
  });

  it("returns null when the DC# is not a known directory entry", () => {
    const helpers = loadStoreResolverHelpers([], tjxRows);
    expect(helpers.resolveTjxDcFromEmailV2_("Route to DC# 9999")).toBeNull();
  });

  it("returns null when no DC# pattern is present at all", () => {
    const helpers = loadStoreResolverHelpers([], tjxRows);
    expect(helpers.resolveTjxDcFromEmailV2_("Generic shipment update, no store info")).toBeNull();
  });

  it("never guesses when two distinct DC# mentions both resolve", () => {
    const helpers = loadStoreResolverHelpers([], tjxRows);
    expect(helpers.resolveTjxDcFromEmailV2_("Split load: DC# 1234 and DC# 5678")).toBeNull();
  });

  // Regression for a Codex review finding: an unknown DC# mentioned
  // alongside a known one must still reject as ambiguous, not silently
  // narrow down to the one that happens to already be on file.
  it("never guesses when one mentioned DC# is known and the other is not", () => {
    const helpers = loadStoreResolverHelpers([], tjxRows);
    expect(helpers.resolveTjxDcFromEmailV2_("Split load: DC# 1234 and DC# 9999")).toBeNull();
  });

  it("does not treat ordinary postal text (Washington DC + ZIP) as a DC-number mention", () => {
    // Regression for a Codex review finding: the previous regex made both
    // "#" and ":" optional, so "Washington DC 20001" matched as a bare
    // DC-number mention — if that ZIP also happened to be a real directory
    // entry, it would confidently (and wrongly) resolve there.
    const zipRows = [
      ["Order Received", "Order Name", "DC#"],
      ["", "Ross Load", "20001"],
    ];
    const helpers = loadStoreResolverHelpers([], zipRows);
    expect(helpers.resolveTjxDcFromEmailV2_("Deliver to our Washington DC 20001 store.")).toBeNull();
  });
});
