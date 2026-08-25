import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Helpers = {
  wmsImportEligible_: (dateInfo: { key: string }) => boolean;
  chooseWmsTargetRow_: (
    groupKey: string,
    invoices: string[],
    rows: Array<{ rowNumber: number; key: string; active: boolean; invoices: string[] }>,
  ) => { rowNumber: number; key: string; active: boolean; invoices: string[] } | null;
  filterWmsInvoicesForGroup_: (
    invoices: string[],
    groupKey: string,
    sourceByInvoice: Map<string, { key: string }>,
  ) => string[];
};

function loadHelpers(): Helpers {
  const source = readFileSync("google-apps-script/WmsTruckingSyncV2.gs", "utf8");
  const context = vm.createContext({ Map, Set, console });
  vm.runInContext(
    `${source}\n;globalThis.__helpers = {wmsImportEligible_,chooseWmsTargetRow_,filterWmsInvoicesForGroup_};`,
    context,
  );
  return context.__helpers as Helpers;
}

const helpers = loadHelpers();

describe("WMS trucking importer v2 safeguards", () => {
  it("never imports ship dates before August 2026", () => {
    expect(helpers.wmsImportEligible_({ key: "2026-07-31" })).toBe(false);
    expect(helpers.wmsImportEligible_({ key: "2026-08-01" })).toBe(true);
    expect(helpers.wmsImportEligible_({ key: "2026-08-11" })).toBe(true);
  });

  it("reuses a row when normalized customer and invoice match across ship dates", () => {
    const rows = [
      {
        rowNumber: 653,
        key: "BEAUTIFYME___2026-08-10",
        active: true,
        invoices: ["IN00463488", "IN00463819"],
      },
    ];

    expect(
      helpers.chooseWmsTargetRow_("BEAUTIFYME___2026-08-11", ["IN00463819"], rows)?.rowNumber,
    ).toBe(653);
    expect(
      helpers.chooseWmsTargetRow_("BEAUTIFYME___2026-08-10", ["IN00463488"], rows)?.rowNumber,
    ).toBe(653);
  });

  it("prefers the matching row with the larger invoice set", () => {
    const rows = [
      {
        rowNumber: 10,
        key: "GLOWISS___2026-08-20",
        active: true,
        invoices: ["IN00470001"],
      },
      {
        rowNumber: 14,
        key: "GLOWISS___2026-08-21",
        active: true,
        invoices: ["IN00470001", "IN00470002", "IN00470003"],
      },
    ];

    expect(
      helpers.chooseWmsTargetRow_("GLOWISS___2026-08-22", ["IN00470001"], rows)?.rowNumber,
    ).toBe(14);
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
