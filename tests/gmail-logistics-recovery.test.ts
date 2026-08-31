import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function loadInboundInsertHelper() {
  const source = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
  const context = vm.createContext({ console, Date, Map, Set });
  vm.runInContext(`${source}\n;globalThis.__helper = chooseInboundInsertRowV2_;`, context);
  return context.__helper as (rows: unknown[][], schedulingIndex: number) => {
    row: number;
    insertBeforeMarker: boolean;
  };
}

function loadWmsHelpers() {
  const code = readFileSync("google-apps-script/Code.gs", "utf8");
  const sync = readFileSync("google-apps-script/WmsTruckingSyncV2.gs", "utf8");
  const context = vm.createContext({
    console,
    Date,
    Map,
    Set,
    Session: { getScriptTimeZone: () => "America/Los_Angeles" },
    Utilities: {
      formatDate: (value: Date, _zone: string, pattern: string) => {
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return pattern === "yyyy-MM-dd" ? `${year}-${month}-${day}` : `${month}/${day}/${year}`;
      },
    },
  });
  vm.runInContext(
    `${code}\n${sync}\n;globalThis.__wmsRecovery = { wmsDestinationHint_, wmsExactGroupKey_, shouldWmsOverwriteShipDate_, wmsImportEligible_ };`,
    context,
  );
  return context.__wmsRecovery as {
    wmsDestinationHint_: (row: unknown[], map: Record<string, number>) => string;
    wmsExactGroupKey_: (customer: string, dateInfo: { key: string }, destination?: string) => string;
    shouldWmsOverwriteShipDate_: (row: unknown[], map: Record<string, number>) => boolean;
    wmsImportEligible_: (dateInfo: { key: string }, todayKey?: string) => boolean;
  };
}

describe("Gmail logistics recovery safeguards", () => {
  it("uses empty import rows before the SCHEDULING boundary before inserting more rows", () => {
    const choose = loadInboundInsertHelper();
    const rows = Array.from({ length: 340 }, () => [""]);
    rows[301] = ["HJ101 - 2026"]; // sheet row 302
    rows[307] = ["SCHEDULING"]; // sheet row 308
    rows[336] = ["PARCELS"]; // sheet row 337

    expect(choose(rows, 307)).toEqual({ row: 303, insertBeforeMarker: false });

    for (let index = 302; index < 307; index += 1) rows[index] = [`IMPORT-${index}`];
    expect(choose(rows, 307)).toEqual({ row: 308, insertBeforeMarker: true });
  });

  it("keeps same-customer same-date WMS freight separate when a destination hint differs", () => {
    const helpers = loadWmsHelpers();
    const map = { "SKU 1": 8, "SKU 2": 9, "REMARKS (SALES)": 11, "REMARKS (WAREHOUSE)": 12 };
    const stonestown = ["", "", "", "", "", "", "", "", "A-SKU 있습니다", "Stonestown Galleria"];
    const chinatown = ["", "", "", "", "", "", "", "", "A-SKU 있습니다", "Fanloli Chinatown"];

    const hintA = helpers.wmsDestinationHint_(stonestown, map);
    const hintB = helpers.wmsDestinationHint_(chinatown, map);
    expect(hintA).toBe("STONESTOWN GALLERIA");
    expect(hintB).toBe("FANLOLI CHINATOWN");
    expect(helpers.wmsExactGroupKey_("Yixi Trading llc, DBA Fanloli Beauty", { key: "2026-09-04" }, hintA))
      .not.toBe(helpers.wmsExactGroupKey_("Yixi Trading llc, DBA Fanloli Beauty", { key: "2026-09-04" }, hintB));
  });

  it("does not let WMS overwrite a carrier-confirmed/routed ship date", () => {
    const helpers = loadWmsHelpers();
    const map = { STATUS: 20, "PRO#": 18, CARRIER: 16 };
    const routed = Array(21).fill("");
    routed[20] = "ROUTED/BOOKED";
    expect(helpers.shouldWmsOverwriteShipDate_(routed, map)).toBe(false);

    const tracked = Array(21).fill("");
    tracked[18] = "STY-2247";
    expect(helpers.shouldWmsOverwriteShipDate_(tracked, map)).toBe(false);

    const unbooked = Array(21).fill("");
    unbooked[20] = "WORK IN PROGRESS";
    expect(helpers.shouldWmsOverwriteShipDate_(unbooked, map)).toBe(true);
  });

  it("limits WMS schedule creation to today and future dates", () => {
    const helpers = loadWmsHelpers();
    expect(helpers.wmsImportEligible_({ key: "2026-08-30" }, "2026-08-31")).toBe(false);
    expect(helpers.wmsImportEligible_({ key: "2026-08-31" }, "2026-08-31")).toBe(true);
    expect(helpers.wmsImportEligible_({ key: "2026-09-04" }, "2026-08-31")).toBe(true);
  });

  it("requires the deployed trigger plan to self-heal after a version change", () => {
    const triggers = readFileSync("google-apps-script/Triggers.gs", "utf8");
    const xpo = readFileSync("google-apps-script/GmailXpoV2.gs", "utf8");
    expect(triggers).toContain("ensureCanonicalTriggersForVersion_");
    expect(xpo).toContain("ensureCanonicalTriggersForVersion_");
  });
});
