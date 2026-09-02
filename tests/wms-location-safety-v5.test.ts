import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Helpers = {
  whYixiLocationAliasV5_: (value: unknown) => string;
  whYixiLocationFromEvidenceV6_: (address: unknown, store: unknown, note: unknown) => string;
  whLocationIdentityV5_: (customer: unknown, address: unknown, store: unknown, note: unknown) => string;
  whCanonicalYixiCustomerNameV6_: (customer: unknown, address: unknown, store: unknown, note: unknown) => string;
  whDedupeKeyV5_: (row: unknown[], map: Record<string, number>) => string;
};

function loadHelpers(): Helpers {
  const source = readFileSync("google-apps-script/zzzzzzzzzzz_WmsLocationSafetyV5.gs", "utf8");
  const context = vm.createContext({ console });
  vm.runInContext(
    `${source}\n;globalThis.__helpers = { whYixiLocationAliasV5_, whYixiLocationFromEvidenceV6_, whLocationIdentityV5_, whCanonicalYixiCustomerNameV6_, whDedupeKeyV5_ };`,
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

function row(invoice: string, address: string, location: string, pro = "", customer = "YIXI TRADING LLC, DBA FANLOLI BEAUTY", note = "") {
  const values = new Array(25).fill("");
  values[0] = customer;
  values[1] = invoice;
  values[2] = address;
  values[3] = "09/04/2026";
  values[18] = pro;
  values[19] = note;
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

  it("maps proven Yixi addresses to the exact WH Trucking customer names", () => {
    expect(helpers.whCanonicalYixiCustomerNameV6_("Yixi Trading LLC, DBA Fanloli Beauty", "Stonestown Galleria 3251 20th Ave, STE214, San Francisco, CA 94132", "", ""))
      .toBe("YIXI TRADING (FANLOLI) - GALLERIA (SF)");
    expect(helpers.whCanonicalYixiCustomerNameV6_("YIXI TRADING LLC, DBA FANLOLI BEAUTY", "245 S Spruce Ave #800 H3, South San Francisco, CA 94080", "", ""))
      .toBe("YIXI Trading LLC (dba Fanloli) (HILLSDALE READYSPACE)");
    expect(helpers.whCanonicalYixiCustomerNameV6_("Fanloli Beauty", "953 Grant Ave, San Francisco, CA 94108", "", ""))
      .toBe("YIXI Trading LLC (dba Fanloli) (CHINATOWN)");
    expect(helpers.whCanonicalYixiCustomerNameV6_("Yixi Trading", "1737 Post St #323, San Francisco, CA 94115", "", ""))
      .toBe("YIXI Trading LLC (dba Fanloli) (JAPAN CENTER)");
  });

  it("gives a proven street address precedence over a conflicting store label", () => {
    expect(helpers.whYixiLocationFromEvidenceV6_("1737 Post St #323, San Francisco, CA 94115", "CHINATOWN", ""))
      .toBe("JAPAN CENTER");
    expect(helpers.whCanonicalYixiCustomerNameV6_("Yixi Trading", "1737 Post St #323, San Francisco, CA 94115", "CHINATOWN", ""))
      .toBe("YIXI Trading LLC (dba Fanloli) (JAPAN CENTER)");
  });

  it("uses an explicit Address: note before a conflicting store label when the address cell is blank", () => {
    const note = "WMS destination: Japan Center.\nAddress: 953 Grant Ave\nSan Francisco CA 94108";
    expect(helpers.whYixiLocationFromEvidenceV6_("", "JAPAN CENTER", note)).toBe("CHINATOWN");
    expect(helpers.whCanonicalYixiCustomerNameV6_("Yixi Trading", "", "JAPAN CENTER", note))
      .toBe("YIXI Trading LLC (dba Fanloli) (CHINATOWN)");
  });

  it("does not guess a Yixi customer location when the address is unknown", () => {
    expect(helpers.whCanonicalYixiCustomerNameV6_("YIXI TRADING LLC, DBA FANLOLI BEAUTY", "999 Unknown Ave, San Francisco, CA", "", ""))
      .toBe("YIXI TRADING LLC, DBA FANLOLI BEAUTY");
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

  it("treats generic and canonical Yixi names at the same address as the same shipment identity", () => {
    const generic = helpers.whDedupeKeyV5_(row("IN00471237", "953 Grant Ave, San Francisco, CA 94108", "CHINATOWN"), map);
    const canonical = helpers.whDedupeKeyV5_(row(
      "IN00471237",
      "953 Grant Ave, San Francisco, CA 94108",
      "CHINATOWN",
      "",
      "YIXI Trading LLC (dba Fanloli) (CHINATOWN)",
    ), map);
    expect(generic).toBe(canonical);
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

  it("runs location cleanup through the canonical importer without a competing trigger", () => {
    const source = readFileSync("google-apps-script/zzzzzzzzzzz_WmsLocationSafetyV5.gs", "utf8");
    const importer = readFileSync("google-apps-script/WmsTruckingSyncV2.gs", "utf8");
    const triggers = readFileSync("google-apps-script/Triggers.gs", "utf8");
    const code = readFileSync("google-apps-script/Code.gs", "utf8");
    expect(triggers).not.toContain('handler: "dedupeWhTruckingLocationSafeV5"');
    expect(source).toContain('whBackfillLocationStoreV5_');
    expect(importer).toContain('dedupeWhTruckingLocationSafeV5_()');
    expect(code).toContain('ensureCanonicalTriggersForVersion_()');
  });
});
