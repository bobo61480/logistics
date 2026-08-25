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
    expect(result).toEqual({ customer: "MEGA MART", method: "text-exact", confidence: "high" });
  });

  // Regression for a Codex review finding on this file: a lone existing
  // TRUCKING row for a brand must never be trusted as a confident match
  // when the email names a DIFFERENT, not-yet-on-file location of that
  // same brand — the canonical/brand key alone is not enough once a
  // record carries a location qualifier.
  it("does not resolve a different, not-yet-on-file location of the same brand to the lone existing location", () => {
    const dbRows = [HEADER, ["MEGA MART (PALO ALTO)", "1 Palo Alto Way", "Jane", ""]];
    const { helpers } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "ops@unrelated.com", subject: "New shipment for Mega Mart (Fremont)", body: "", messageId: "m11" },
      {},
      {},
    );
    expect(result).toBeNull();
  });

  // Round 2 of the same Codex finding: the bypass was specifically in the
  // exact-name tier — a BARE, unqualified candidate ("MEGA MART", no
  // location on file at all) must not match an email naming a MORE
  // specific, different location ("MEGA MART (FREMONT)") just because the
  // padded-substring test can't tell a trailing location qualifier apart
  // from any other trailing word once parens collapse to plain spaces.
  it("does not resolve a bare unqualified candidate when the email names a specific different location", () => {
    const dbRows = [HEADER, ["MEGA MART", "1 Main St", "Jane", ""]];
    const { helpers } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "ops@unrelated.com", subject: "New shipment for Mega Mart (Fremont)", body: "", messageId: "m14" },
      {},
      {},
    );
    expect(result).toBeNull();
  });

  it("still resolves a bare unqualified candidate when the email names it plainly, with no trailing location", () => {
    const dbRows = [HEADER, ["MEGA MART", "1 Main St", "Jane", ""]];
    const { helpers } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "ops@unrelated.com", subject: "New shipment for Mega Mart", body: "", messageId: "m15" },
      {},
      {},
    );
    expect(result?.customer).toBe("MEGA MART");
  });

  // Regression for a Codex review finding: when the text tier itself finds
  // internally conflicting evidence (two different customers both
  // plausibly named), that must block the whole resolution — including a
  // confident sender match — not be silently treated as "no text signal."
  it("rejects a confident sender match when the text tier is internally ambiguous", () => {
    const dbRows = [
      HEADER,
      ["MEGA MART", "1 Main St", "Jane", "orders@megamart.com"],
      ["TOKTOK BEAUTY", "2 Oak Ave", "Jack", ""],
      ["ROYAL IMEX INC", "3 Pine Rd", "Jill", ""],
    ];
    const { helpers, loggedEvents } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      {
        from: "orders@megamart.com",
        subject: "Shipment update",
        body: "Please coordinate with TokTok Beauty and Royal Imex Inc on this load.",
        messageId: "m16",
      },
      {},
      {},
    );
    expect(result).toBeNull();
    expect(loggedEvents.some((e) => e.event === "GMAIL V2 CUSTOMER RESOLVE AMBIGUOUS")).toBe(true);
  });

  // The exact same location DOES resolve, and legal-suffix/ampersand
  // differences between the stored name and the email text wash out via
  // the shared light normalization (Codex review: haystack normalization).
  it("resolves an exact location match, and tolerates a legal-suffix/ampersand spelling difference", () => {
    const exactLocation = loadResolverHelpers([HEADER, ["MEGA MART (PALO ALTO)", "1 Palo Alto Way", "Jane", ""]]);
    const exactResult = exactLocation.helpers.resolveCustomerFromEmailV2_(
      { from: "ops@unrelated.com", subject: "New shipment for Mega Mart (Palo Alto)", body: "", messageId: "m12" },
      {},
      {},
    );
    expect(exactResult?.customer).toBe("MEGA MART (PALO ALTO)");

    const suffixCase = loadResolverHelpers([HEADER, ["A&B LLC", "1 Main St", "Jane", ""]]);
    const suffixResult = suffixCase.helpers.resolveCustomerFromEmailV2_(
      { from: "ops@unrelated.com", subject: "Pickup for A&B LLC", body: "", messageId: "m13" },
      {},
      {},
    );
    expect(suffixResult?.customer).toBe("A&B LLC");
  });

  // Regression for a Codex round-3 finding on PR #102: the location-marker
  // insertion only marked the OPENING paren, so a stored qualifier that is a
  // prefix of a longer haystack mention of the same brand ("MEGA MART
  // (PALO)" stored vs. an email naming "MEGA MART (PALO ALTO)") matched as
  // a padded substring even though PALO and PALO ALTO are different, not
  // yet on-file locations. Marking the closing paren too requires the full
  // qualifier text to match, not just a prefix of it.
  it("does not resolve a shorter stored location qualifier against a longer haystack location", () => {
    const dbRows = [HEADER, ["MEGA MART (PALO)", "1 Palo Way", "Jane", ""]];
    const { helpers } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "ops@unrelated.com", subject: "New shipment for Mega Mart (Palo Alto)", body: "", messageId: "m-loc" },
      {},
      {},
    );
    expect(result).toBeNull();
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

  // Regression for a Codex round-4 finding: the exact-tier early return
  // used to fire before canonical/brand evidence for a DIFFERENT customer
  // was ever checked, so an email naming both an exact-matched customer and
  // a second, brand-only-matched customer silently picked the exact one.
  it("does not silently ignore a canonical/brand match for a different customer when an exact match also fires", () => {
    const dbRows = [
      HEADER,
      ["MEGA MART", "1 Main St", "Jane", ""],
      ["TOKTOK BEAUTY INC", "2 Second St", "Jack", ""],
    ];
    const { helpers } = loadResolverHelpers(dbRows);
    const result = helpers.resolveCustomerFromEmailV2_(
      { from: "ops@unrelated.com", subject: "New shipment for Mega Mart, cc TokTok Beauty on this load", body: "", messageId: "m-conflict" },
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
