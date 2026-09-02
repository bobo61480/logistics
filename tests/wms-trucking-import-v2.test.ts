import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Helpers = {
  wmsImportEligible_: (dateInfo: { key: string }, todayKey?: string) => boolean;
  wmsInvoiceSignatureFromKey_: (groupKey: string, invoice: string) => string;
  chooseWmsTargetRow_: (
    groupKey: string,
    invoices: string[],
    rows: Array<{
      rowNumber: number;
      key: string;
      active: boolean;
      invoices: string[];
      operationallyLocked?: boolean;
    }>,
  ) => {
    rowNumber: number;
    key: string;
    active: boolean;
    invoices: string[];
    operationallyLocked?: boolean;
  } | null;
  filterWmsInvoicesForGroup_: (
    invoices: string[],
    groupKey: string,
    sourceByInvoice: Map<string, { key: string }>,
  ) => string[];
  wmsLocationStoreIndex_: (map: Record<string, number>) => number | undefined;
  whExactDuplicateRowNumbersV5_: (data: string[][], headerIndex: number) => number[];
};

function loadHelpers(): Helpers {
  const source = readFileSync("google-apps-script/WmsTruckingSyncV2.gs", "utf8");
  const locationSafety = readFileSync("google-apps-script/zzzzzzzzzzz_WmsLocationSafetyV5.gs", "utf8");
  const context = vm.createContext({ Map, Set, console });
  vm.runInContext(
    `${locationSafety}\n${source}\n;globalThis.__helpers = {wmsImportEligible_,wmsInvoiceSignatureFromKey_,chooseWmsTargetRow_,filterWmsInvoicesForGroup_,wmsLocationStoreIndex_,whExactDuplicateRowNumbersV5_};`,
    context,
  );
  return context.__helpers as Helpers;
}

const helpers = loadHelpers();

describe("WMS trucking importer v2 safeguards", () => {
  it("keeps the historical floor while limiting creation to the supplied operational day", () => {
    expect(helpers.wmsImportEligible_({ key: "2026-07-31" }, "2026-08-01")).toBe(false);
    expect(helpers.wmsImportEligible_({ key: "2026-08-01" }, "2026-08-01")).toBe(true);
    expect(helpers.wmsImportEligible_({ key: "2026-08-11" }, "2026-08-01")).toBe(true);
    expect(helpers.wmsImportEligible_({ key: "2026-08-10" }, "2026-08-11")).toBe(false);
  });

  it("keeps destination-specific invoice signatures separate", () => {
    const sourceSignature = helpers.wmsInvoiceSignatureFromKey_(
      "YIXI TRADING LLC DBA FANLOLI BEAUTY___2026-09-04___DEST_CHINATOWN",
      "in00471237",
    );
    const targetSignature = helpers.wmsInvoiceSignatureFromKey_(
      "YIXI TRADING LLC DBA FANLOLI BEAUTY___2026-09-04",
      "IN00471237",
    );

    expect(sourceSignature).toBe(
      "YIXI TRADING LLC DBA FANLOLI BEAUTY___2026-09-04___DEST_CHINATOWN___INV_IN00471237",
    );
    expect(targetSignature).not.toBe(sourceSignature);
    expect(
      helpers.wmsInvoiceSignatureFromKey_(
        "YIXI TRADING LLC DBA FANLOLI BEAUTY___2026-09-04___DEST_JAPAN CENTER",
        "IN00471235",
      ),
    ).not.toBe(sourceSignature);
  });

  it("persists the destination in the target location column", () => {
    expect(helpers.wmsLocationStoreIndex_({ "LOCATION STORE": 8 })).toBe(8);
    expect(helpers.wmsLocationStoreIndex_({ "LOCATION/STORE": 9 })).toBe(9);
    const source = readFileSync("google-apps-script/WmsTruckingSyncV2.gs", "utf8");
    expect(source).toContain("newRow[targetLocationIndex] = group.destinationHint");
  });

  it("does not reuse a row just because an invoice was previously merged into a nearby date", () => {
    const rows = [
      {
        rowNumber: 653,
        key: "BEAUTIFYME___2026-08-10",
        active: true,
        invoices: ["IN00463488", "IN00463819"],
      },
    ];

    expect(
      helpers.chooseWmsTargetRow_("BEAUTIFYME___2026-08-11", ["IN00463819"], rows),
    ).toBeNull();
    expect(
      helpers.chooseWmsTargetRow_("BEAUTIFYME___2026-08-10", ["IN00463488"], rows)?.rowNumber,
    ).toBe(653);
  });

  it("can follow a clean single-shipment reschedule without absorbing conflicting invoices", () => {
    const clean = [
      {
        rowNumber: 720,
        key: "WOOAMI___2026-09-01",
        active: true,
        invoices: ["IN00471193"],
      },
    ];
    expect(
      helpers.chooseWmsTargetRow_("WOOAMI___2026-09-02", ["IN00471193"], clean)?.rowNumber,
    ).toBe(720);
  });

  it("returns a routed cross-date identity as locked so the caller can preserve carrier truth", () => {
    const routed = [
      {
        rowNumber: 720,
        key: "WOOAMI___2026-09-01",
        active: true,
        invoices: ["IN00469933", "IN00471193"],
        operationallyLocked: true,
      },
    ];
    const match = helpers.chooseWmsTargetRow_("WOOAMI___2026-09-02", ["IN00471193"], routed);
    expect(match?.rowNumber).toBe(720);
    expect(match?.operationallyLocked).toBe(true);
  });

  it("removes byte-identical duplicate rows even when the ship date is blank", () => {
    // Reproduces the production WH Trucking corruption: a block of identical
    // rows carrying an invoice but no ship date. whDedupeKeyV5_ returns "" for
    // a blank ship date, so the key-based pass never removed them — the exact
    // fingerprint pass must.
    const header = ["CUSTOMER", "INVOICE NO.", "ADDRESS", "SHIP DATE"];
    const vine = ["VINE COSMETICS", "IN00471703", "7031 Little River Turnpike, 19D", ""];
    const data = [
      [], // leading blank spacer
      header,
      vine.slice(),
      vine.slice(),
      vine.slice(),
      ["OTHER CO", "IN00500000", "123 Main St", "09/01/2026"],
      vine.slice(),
    ];
    // header at index 1; rows 3,4,7 (1-based) are repeats of the first vine row (row 3).
    expect(helpers.whExactDuplicateRowNumbersV5_(data, 1)).toEqual([4, 5, 7]);
  });

  it("keeps rows that share an invoice but differ in any real field, and never collapses blank spacer rows", () => {
    const header = ["CUSTOMER", "INVOICE NO.", "PRO#", "SHIP DATE"];
    const data = [
      header,
      ["NEXTRADE", "IN00463676", "23965334", "08/27/2026"],
      ["NEXTRADE", "IN00463676", "23965391", "08/27/2026"], // same invoice/date, different PRO → NOT a duplicate
      [],
      [],
    ];
    expect(helpers.whExactDuplicateRowNumbersV5_(data, 0)).toEqual([]);
  });

  it("removes source-known invoices that belong to another exact ship-date group", () => {
    const sourceByInvoice = new Map([
      ["IN00463488", { key: "BEAUTIFYME___2026-08-10" }],
      ["IN00463819", { key: "BEAUTIFYME___2026-08-11" }],
    ]);

    expect(
      helpers.filterWmsInvoicesForGroup_(
        ["IN00463488", "IN00463819", "MANUAL-REF"],
        "BEAUTIFYME___2026-08-10",
        sourceByInvoice,
      ),
    ).toEqual(["IN00463488", "MANUAL-REF"]);
  });
});
