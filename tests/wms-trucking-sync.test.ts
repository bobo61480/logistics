import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type WmsHelpers = {
  canonicalWmsCustomer_: (value: unknown) => string;
  isWmsFreightMethod_: (value: unknown) => boolean;
  isWmsActiveStatus_: (value: unknown) => boolean;
  mergeWmsInvoices_: (existing: string[], additions: string[]) => string[];
  findCloseWmsParentRow_: (
    rows: Array<Record<string, unknown>>,
    customer: string,
    shipDate: string,
  ) => number | null;
  normalizeWmsShipDate_: (value: unknown) => { key: string; display: string };
  earliestWmsSourceDateForInvoices_: (
    invoices: string[],
    sourceByInvoice: Map<string, Record<string, unknown>>,
    fallback: string,
  ) => string;
};

function loadWmsHelpers(): WmsHelpers {
  const source = readFileSync("google-apps-script/Code.gs", "utf8");
  const context = vm.createContext({
    Date,
    Map,
    Set,
    console,
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
    `${source}\n;globalThis.__wms = {` +
      "canonicalWmsCustomer_,isWmsFreightMethod_,isWmsActiveStatus_," +
      "mergeWmsInvoices_,findCloseWmsParentRow_,normalizeWmsShipDate_," +
      "earliestWmsSourceDateForInvoices_};",
    context,
  );
  return context.__wms as WmsHelpers;
}

const helpers = loadWmsHelpers();

describe("WMS trucking synchronization safeguards", () => {
  it("canonicalizes mandatory customer aliases without collapsing unrelated customers", () => {
    expect(helpers.canonicalWmsCustomer_("MEGA MART (PALO ALTO)")).toBe("MEGA MART");
    expect(helpers.canonicalWmsCustomer_("Mega Mart - Fremont")).toBe("MEGA MART");
    expect(helpers.canonicalWmsCustomer_("TOKTOK BEAUTY TEAMZL LC")).toBe("TOKTOK BEAUTY");
    expect(helpers.canonicalWmsCustomer_("Royal Imex, Inc.")).toBe("ROYAL IMEX INC");
    expect(helpers.canonicalWmsCustomer_("PPIH (GUAM)")).toBe("Great Luck Inc. (PPIH - GUAM)");
    expect(helpers.canonicalWmsCustomer_("Yamibuy")).toBe("YAMIBUY");
  });

  it("accepts freight methods and excludes pickup and parcel carriers", () => {
    expect(helpers.isWmsFreightMethod_("TRUCKING")).toBe(true);
    expect(helpers.isWmsFreightMethod_("LTL Freight")).toBe(true);
    expect(helpers.isWmsFreightMethod_("Local Delivery")).toBe(true);
    expect(helpers.isWmsFreightMethod_("UPS Freight")).toBe(false);
    expect(helpers.isWmsFreightMethod_("PICK UP")).toBe(false);
  });

  it("merges newline invoice tokens instead of replacing the destination cell", () => {
    expect(
      helpers.mergeWmsInvoices_(["IN00463065", "IN00463818"], ["IN00463818", "IN00464415"]),
    ).toEqual(["IN00463065", "IN00463818", "IN00464415"]);
  });

  it("selects only an active same-customer parent within three calendar days", () => {
    const rows = [
      {
        rowNumber: 10,
        customerKey: "MEGA MART",
        dateInfo: helpers.normalizeWmsShipDate_("08/10/2026"),
        active: false,
      },
      {
        rowNumber: 11,
        customerKey: "MEGA MART",
        dateInfo: helpers.normalizeWmsShipDate_("08/12/2026"),
        active: true,
      },
      {
        rowNumber: 12,
        customerKey: "MEGA MART",
        dateInfo: helpers.normalizeWmsShipDate_("08/20/2026"),
        active: true,
      },
    ];

    expect(helpers.findCloseWmsParentRow_(rows, "MEGA MART (ATLANTA)", "08/14/2026")).toBe(11);
    expect(helpers.findCloseWmsParentRow_(rows, "MEGA MART", "08/16/2026")).toBeNull();
  });

  it("retains the earliest practical source date for a combined row", () => {
    const sourceByInvoice = new Map([
      ["IN1", { dateInfo: helpers.normalizeWmsShipDate_("08/12/2026") }],
      ["IN2", { dateInfo: helpers.normalizeWmsShipDate_("08/14/2026") }],
    ]);
    expect(
      helpers.earliestWmsSourceDateForInvoices_(["IN1", "IN2"], sourceByInvoice, "08/13/2026"),
    ).toBe("08/12/2026");
  });

  it("treats terminal statuses as unavailable parents", () => {
    ["SHIPPED", "DELIVERED", "RECEIVED", "COMPLETED", "CANCELLED"].forEach((status) => {
      expect(helpers.isWmsActiveStatus_(status)).toBe(false);
    });
    expect(helpers.isWmsActiveStatus_("ROUTED/BOOKED")).toBe(true);
    expect(helpers.isWmsActiveStatus_("WORK IN PROGRESS")).toBe(true);
  });
});
