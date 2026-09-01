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
};

function loadHelpers(): Helpers {
  const source = readFileSync("google-apps-script/WmsTruckingSyncV2.gs", "utf8");
  const locationSafety = readFileSync("google-apps-script/zzzzzzzzzzz_WmsLocationSafetyV5.gs", "utf8");
  const context = vm.createContext({ Map, Set, console });
  vm.runInContext(
    `${locationSafety}\n${source}\n;globalThis.__helpers = {wmsImportEligible_,wmsInvoiceSignatureFromKey_,chooseWmsTargetRow_,filterWmsInvoicesForGroup_,wmsLocationStoreIndex_};`,
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
