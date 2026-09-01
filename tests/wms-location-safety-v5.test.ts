import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Helpers = {
  whYixiLocationAliasV5_: (value: unknown) => string;
  whLocationIdentityV5_: (customer: unknown, address: unknown, store: unknown, note: unknown) => string;
  whDedupeKeyV5_: (row: unknown[], map: Record<string, number>) => string;
};

function loadHelpers(): Helpers {
  const source = readFileSync("google-apps-script/zzzzzzzzzzz_WmsLocationSafetyV5.gs", "utf8");
  const context = vm.createContext({ console });
  vm.runInContext(
    `${source}\n;globalThis.__helpers = { whYixiLocationAliasV5_, whLocationIdentityV5_, whDedupeKeyV5_ };`,
    context,
  );
  return context.__helpers as Helpers;
}

const helpers = loadHelpers();
const map = {
  CUSTOMER: 0,
  "INVOICE NO": 1,
  ADDRESS: 2,
  "SHIP DATE": 3,
  PRO: 18,
  NOTE: 19,
  "LOCATION STORE": 24,
};

function row(invoice: string, address: string, location: string, pro = "") {
  const values = new Array(25).fill("");
  values[0] = "YIXI TRADING LLC, DBA FANLOLI BEAUTY";
  values[1] = invoice;
  values[2] = address;
  values[3] = "09/04/2026";
  values[18] = pro;
  values[24] = location;
  return values;
}

describe("WH Trucking location safety V5", () => {
  it("recognizes the four Yixi delivery locations as distinct identities", () => {
    const locations = [
      helpers.whLocationIdentityV5_("Yixi Trading", "3251 20th Ave, San Francisco, CA", "", ""),
      helpers.whLocationIdentityV5_("Yixi Trading", "245 S Spruce Ave #800 H3, South San Francisco, CA", "", ""),
      helpers.whLocationIdentityV5_("Yixi Trading", "1737 Post St #323, San Francisco, CA", "", ""),
      helpers.whLocationIdentityV5_("Yixi Trading", "953 Grant Ave, San Francisco, CA", "", ""),
    ];
    expect(new Set(locations).size).toBe(4);
    expect(locations).toEqual([
      "YIXI:STONESTOWN GALLERIA",
      "YIXI:HILLSDALE READYSPACES",
      "YIXI:JAPAN CENTER",
      "YIXI:CHINATOWN",
    ]);
  });

  it("does not collapse the same customer/date across different Yixi locations", () => {
    const sameInvoice = "IN00999999";
    const keys = [
      helpers.whDedupeKeyV5_(row(sameInvoice, "3251 20th Ave, San Francisco, CA", "STONESTOWN GALLERIA"), map),
      helpers.whDedupeKeyV5_(row(sameInvoice, "245 S Spruce Ave #800 H3, South San Francisco, CA", "HILLSDALE / READYSPACES"), map),
      helpers.whDedupeKeyV5_(row(sameInvoice, "1737 Post St #323, San Francisco, CA", "JAPAN CENTER"), map),
      helpers.whDedupeKeyV5_(row(sameInvoice, "953 Grant Ave, San Francisco, CA", "CHINATOWN"), map),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it("treats repeat copies of the same invoice/date/location as duplicates", () => {
    const a = helpers.whDedupeKeyV5_(row("IN00471237", "953 Grant Ave, San Francisco, CA 94108", "CHINATOWN"), map);
    const b = helpers.whDedupeKeyV5_(row("IN00471237", "953 Grant Ave, San Francisco, CA 94108", ""), map);
    expect(a).toBe(b);
  });

  it("preserves true split loads when PRO numbers differ", () => {
    const a = helpers.whDedupeKeyV5_(row("IN00471237", "953 Grant Ave, San Francisco, CA 94108", "CHINATOWN", "PRO-111"), map);
    const b = helpers.whDedupeKeyV5_(row("IN00471237", "953 Grant Ave, San Francisco, CA 94108", "CHINATOWN", "PRO-222"), map);
    expect(a).not.toBe(b);
  });

  it("installs a one-minute recovery sweep and self-heals it from snapshot traffic", () => {
    const source = readFileSync("google-apps-script/zzzzzzzzzzz_WmsLocationSafetyV5.gs", "utf8");
    expect(source).toContain('handler: "dedupeWhTruckingLocationSafeV5", minutes: 1');
    expect(source).toContain('2026-08-31-central-v7-yixi-location-selfheal');
    expect(source).toContain('whBackfillLocationStoreV5_');
    expect(source).toContain('action === "snapshot"');
    expect(source).toContain('ensureCanonicalTriggersForVersion_()');
  });
});
