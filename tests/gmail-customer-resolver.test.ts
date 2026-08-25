import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type LoggedEvent = { event: string; subject: string; detail: string };

type ResolverHelpers = {
  resolveCustomerFromEmailV2_: (
    meta: { from: string; subject: string; body: string; messageId: string },
    context: Record<string, unknown>,
    record: Record<string, unknown>,
  ) => { customer: string; method: string; confidence: string } | null;
  matchCustomerByTextV2_: (
    haystack: string,
    records: { rowNumber: number; name: string }[],
  ) => { record: { name: string }; method: string } | null;
};

function loadResolverHelpers(dbRows: unknown[][], sourceOverride?: (src: string) => string) {
  const code = readFileSync("google-apps-script/Code.gs", "utf8");
  const customerLookup = readFileSync("google-apps-script/CustomerLookup.gs", "utf8");
  let resolver = readFileSync("google-apps-script/GmailCustomerResolverV2.gs", "utf8");
  if (sourceOverride) resolver = sourceOverride(resolver);

  const loggedEvents: LoggedEvent[] = [];
  const fakeSheet = { getDataRange: () => ({ getDisplayValues: () => dbRows }) };
  const context = vm.createContext({
    console,
    Logger: { log: () => {} },
    GMAIL_PIPELINE: { masterId: "test-master" },
    writeLog_: (event: string, subject: string, detail: string) => {
      loggedEvents.push({ event, subject, detail });
    },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (name: string) => (name === "TRUCKING" ? fakeSheet : null),
      }),
    },
  });

  vm.runInContext(
    `${code}\n${customerLookup}\n${resolver}\n;globalThis.__resolver = { resolveCustomerFromEmailV2_, matchCustomerByTextV2_, buildCustomerRecords_, findCustomerDbHeader_ };`,
    context,
  );
  return { helpers: context.__resolver as ResolverHelpers, loggedEvents };
}

const HEADER = ["CUSTOMER NAME", "ADDRESS", "CONTACT", "EMAIL SENDERS"];

describe("resolveCustomerFromEmailV2_", () => {
  it("resolves via an exact sender address match (Tier A)", () => {
    const dbRows = [
      HEADER,
      ["MEGA MART", "123 Main St", "Jane", "orders@megamart.com"],
      ["TOKTOK BEAUTY", "456 Oak Ave", "John", "buying@toktokbeauty.com"],
    ];
    const { helpers } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "Jane Buyer <orders@megamart.com>", subject: "New PO", body: "", messageId: "m1" },
      {},
      {},
    );
    expect(result).toEqual({ customer: "MEGA MART", method: "sender", confidence: "high" });
  });

  it("resolves via a domain-suffix sender match", () => {
    const dbRows = [HEADER, ["MEGA MART", "123 Main St", "Jane", "megamart.com"]];
    const { helpers } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "shipping@ops.megamart.com", subject: "", body: "", messageId: "m2" },
      {},
      {},
    );
    expect(result?.customer).toBe("MEGA MART");
  });

  it("degrades gracefully to text-only when EMAIL SENDERS is absent", () => {
    const dbRows = [
      ["CUSTOMER NAME", "ADDRESS", "CONTACT"],
      ["MEGA MART", "123 Main St", "Jane"],
    ];
    const { helpers } = loadResolverHelpers(dbRows);
    const bySenderOnly = helpers.resolveCustomerFromEmailV2_(
      { from: "orders@megamart.com", subject: "no logistics text", body: "", messageId: "m3" },
      {},
      {},
    );
    expect(bySenderOnly).toBeNull();
    const byText = helpers.resolveCustomerFromEmailV2_(
      { from: "random@unrelated.com", subject: "Shipment update for Mega Mart", body: "", messageId: "m4" },
      {},
      {},
    );
    expect(byText?.customer).toBe("MEGA MART");
  });

  it("matches a word-boundary-anchored customer name in subject/body text (Tier B)", () => {
    const dbRows = [HEADER, ["MEGA MART", "123 Main St", "Jane", ""]];
    const { helpers } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "carrier@xpo.com", subject: "Rate confirmation", body: "Pickup for Mega Mart scheduled", messageId: "m5" },
      {},
      {},
    );
    expect(result).toEqual({ customer: "MEGA MART", method: "text", confidence: "medium" });
  });

  // Regression for the 2026-08-12 KORHEIM incident's customer-matching bug
  // class: an unrelated name that merely starts with an aliased brand must
  // never resolve to that brand.
  it("does not false-positive on a name sharing only a prefix (MEGA MARTINEZ)", () => {
    const dbRows = [HEADER, ["MEGA MART", "123 Main St", "Jane", ""]];
    const { helpers } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "ops@unrelated.com", subject: "Shipment for Mega Martinez Distribution", body: "", messageId: "m6" },
      {},
      {},
    );
    expect(result).toBeNull();
  });

  it("never guesses between an ambiguous multi-location family", () => {
    const dbRows = [
      HEADER,
      ["MEGA MART - 1", "1 First St", "Jane", ""],
      ["MEGA MART - 2", "2 Second St", "Jack", ""],
    ];
    const { helpers } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "ops@unrelated.com", subject: "New Mega Mart shipment", body: "", messageId: "m7" },
      {},
      {},
    );
    expect(result).toBeNull();
  });

  it("returns null and logs when the two tiers disagree, never guessing", () => {
    const dbRows = [
      HEADER,
      ["MEGA MART", "123 Main St", "Jane", "orders@megamart.com"],
      ["TOKTOK BEAUTY", "456 Oak Ave", "John", ""],
    ];
    const { helpers, loggedEvents } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "orders@megamart.com", subject: "Shipment for TokTok Beauty", body: "", messageId: "m8" },
      {},
      {},
    );
    expect(result).toBeNull();
    expect(loggedEvents.some((e) => e.event === "GMAIL V2 CUSTOMER RESOLVE AMBIGUOUS")).toBe(true);
  });

  it("returns null on zero signal", () => {
    const dbRows = [HEADER, ["MEGA MART", "123 Main St", "Jane", ""]];
    const { helpers } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "random@unrelated.com", subject: "", body: "", messageId: "m9" },
      {},
      {},
    );
    expect(result).toBeNull();
  });

  it("is a full kill switch when disabled", () => {
    const dbRows = [HEADER, ["MEGA MART", "123 Main St", "Jane", "orders@megamart.com"]];
    const { helpers } = loadResolverHelpers(dbRows, (src) =>
      src.replace(
        "var GMAIL_CUSTOMER_RESOLVER_ENABLED_V2 = true;",
        "var GMAIL_CUSTOMER_RESOLVER_ENABLED_V2 = false;",
      ),
    );
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "orders@megamart.com", subject: "Shipment for Mega Mart", body: "", messageId: "m10" },
      {},
      {},
    );
    expect(result).toBeNull();
  });
});
