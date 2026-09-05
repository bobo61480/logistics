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
  const locationSafety = readFileSync("google-apps-script/zzzzzzzzzzz_WmsLocationSafetyV5.gs", "utf8");
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
    `${code}\n${locationSafety}\n${sync}\n;globalThis.__wmsRecovery = { wmsDestinationHint_, wmsExactGroupKey_, shouldWmsOverwriteShipDate_, wmsImportEligible_ };`,
    context,
  );
  return context.__wmsRecovery as {
    wmsDestinationHint_: (row: unknown[], map: Record<string, number>) => string;
    wmsExactGroupKey_: (customer: string, dateInfo: { key: string }, destination?: string) => string;
    shouldWmsOverwriteShipDate_: (row: unknown[], map: Record<string, number>) => boolean;
    wmsImportEligible_: (dateInfo: { key: string }, todayKey?: string) => boolean;
  };
}

function loadGmailContextHelpers() {
  const pipeline = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
  const validation = readFileSync("google-apps-script/Validation.gs", "utf8");
  const context = vm.createContext({ console, Date, Map, Set });
  vm.runInContext(
    `${pipeline}\n${validation}\n;globalThis.__gmailContext = {
      extractEmailContextV2_,
      normalizeEmailDateV2_,
      validateRecord_,
      gmailV2PredatesReplayCutover_: typeof gmailV2PredatesReplayCutover_ === "function"
        ? gmailV2PredatesReplayCutover_
        : function () { return false; },
      gmailV2TrustedScheduleSender_: typeof gmailV2TrustedScheduleSender_ === "function"
        ? gmailV2TrustedScheduleSender_
        : function () { return false; },
      extractPlainBodyScheduleRecordsV2_: typeof extractPlainBodyScheduleRecordsV2_ === "function"
        ? extractPlainBodyScheduleRecordsV2_
        : function () { return []; }
    };`,
    context,
  );
  return context.__gmailContext as {
    extractEmailContextV2_: (subject: string, body: string) => Record<string, string>;
    normalizeEmailDateV2_: (value: string) => string;
    validateRecord_: (record: Record<string, string>, kind: string) => { ok: boolean; issues: string[] };
    gmailV2PredatesReplayCutover_: (date: Date) => boolean;
    gmailV2TrustedScheduleSender_: (sender: string) => boolean;
    extractPlainBodyScheduleRecordsV2_: (subject: string, body: string) => Array<Record<string, string>>;
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
    expect(hintB).toBe("CHINATOWN");
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

  it("extracts parenthesized ETD and ETA labels from the live air-shipment format", () => {
    const helpers = loadGmailContextHelpers();
    const parsed = helpers.extractEmailContextV2_(
      "미주법인 항공 출고서류 전달의 건_0904",
      [
        "[항공 스케줄]",
        "오포창고 출고일자 : 09/04 AM",
        "ETD(ICN): 09/07 22:00 PM",
        "ETA(LAX): 09/08 00:25 AM",
        "운송방법 : DIR",
        "HWAB : JSL260904",
      ].join("\n"),
    );

    expect(parsed.shipmentNo).toBe("JSL260904");
    expect(parsed.etd).toBe("09/07/26");
    expect(parsed.eta).toBe("09/08/26");
  });

  it("normalizes ISO dates and extracts each row from a plain-text vessel schedule", () => {
    const helpers = loadGmailContextHelpers();
    expect(helpers.normalizeEmailDateV2_("2026-09-30")).toBe("09/30/26");

    const records = helpers.extractPlainBodyScheduleRecordsV2_(
      "미주법인 HJ 107-108차 선적서류 전달의 건_0904",
      [
        "VSL / VOY", "ETD", "ETA", "HBL#", "차수",
        "HMM HANBADA 0021E [MP2]", "2026-09-16", "2026-09-30", "HJTCSEL260900018", "107",
        "HMM HANBADA 0021E [MP2]", "2026-09-16", "2026-09-30", "HJTCSEL260900019", "108",
      ].join("\n"),
    ).map((record) => JSON.parse(JSON.stringify(record)) as Record<string, string>);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "inbound",
      shipmentNo: "HJ107 - 2026",
      hbl: "HJTCSEL260900018",
      vessel: "HMM HANBADA 0021E [MP2]",
      etd: "09/16/26",
      eta: "09/30/26",
    });
    expect(records[1]).toMatchObject({ shipmentNo: "HJ108 - 2026", hbl: "HJTCSEL260900019" });
  });

  it("accepts an inbound HBL or shipment number as the required B/L identifier", () => {
    const helpers = loadGmailContextHelpers();
    expect(helpers.validateRecord_({ hbl: "HJTCSEL260900018", eta: "09/30/26" }, "inbound")).toEqual({ ok: true, issues: [] });
    expect(helpers.validateRecord_({ shipmentNo: "JSL260904", eta: "09/08/26" }, "inbound")).toEqual({ ok: true, issues: [] });
  });

  it("limits the one-time replay to messages dated today or later", () => {
    const helpers = loadGmailContextHelpers();
    expect(helpers.gmailV2PredatesReplayCutover_(new Date("2026-09-04T06:59:59Z"))).toBe(true);
    expect(helpers.gmailV2PredatesReplayCutover_(new Date("2026-09-04T07:00:00Z"))).toBe(false);
  });

  it("only enables plain-body schedule insertion for company logistics senders", () => {
    const helpers = loadGmailContextHelpers();
    expect(helpers.gmailV2TrustedScheduleSender_("이지연 <jlee@siliconii.net>")).toBe(true);
    expect(helpers.gmailV2TrustedScheduleSender_("operator@stylekoreanus.com")).toBe(true);
    expect(helpers.gmailV2TrustedScheduleSender_("attacker@example.com")).toBe(false);
  });
});
