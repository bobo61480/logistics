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
});
