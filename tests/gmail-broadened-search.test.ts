import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type GmailQueryHelpers = {
  gmailV2Queries_: () => string[];
  GMAIL_V2_BROADENED_SEARCH_ENABLED_V2: boolean;
  GMAIL_V2_GENERIC_LOGISTICS_TERMS_V2: string[];
};

function loadGmailQueryHelpers(): GmailQueryHelpers {
  const code = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
  const context = vm.createContext({ console });
  vm.runInContext(
    `${code}\n;globalThis.__gq = { gmailV2Queries_, GMAIL_V2_BROADENED_SEARCH_ENABLED_V2, GMAIL_V2_GENERIC_LOGISTICS_TERMS_V2 };`,
    context,
  );
  return context.__gq as GmailQueryHelpers;
}

describe("gmailV2Queries_ broadened search", () => {
  it("ships enabled by default, appended as the last query", () => {
    const helpers = loadGmailQueryHelpers();
    expect(helpers.GMAIL_V2_BROADENED_SEARCH_ENABLED_V2).toBe(true);
    const queries = helpers.gmailV2Queries_();
    expect(queries).toHaveLength(4);
  });

  it("the original queries stay byte-for-byte unchanged", () => {
    const helpers = loadGmailQueryHelpers();
    const queries = helpers.gmailV2Queries_();
    expect(queries[0]).toContain("AIR SHIPMENT");
    expect(queries[0]).toContain("MAWB subject:HAWB}");
    expect(queries[1]).toContain("from:info@cargomatic.com");
    expect(queries[1]).toContain("subject:pickup}");
    expect(queries[2]).toContain("from:xpo.com");
    expect(queries[2]).toContain('subject:"Pickup Request Created"');
  });

  it("the new clause is sender-agnostic — no from: terms", () => {
    const helpers = loadGmailQueryHelpers();
    const queries = helpers.gmailV2Queries_();
    const broadened = queries[queries.length - 1];
    expect(broadened).not.toMatch(/from:/);
    expect(broadened).toContain('subject:"bill of lading"');
    expect(broadened).toContain('subject:"tracking number"');
  });

  it("every generic term configured is present in the built clause", () => {
    const helpers = loadGmailQueryHelpers();
    const queries = helpers.gmailV2Queries_();
    const broadened = queries[queries.length - 1];
    helpers.GMAIL_V2_GENERIC_LOGISTICS_TERMS_V2.forEach((term) => {
      expect(broadened).toContain(`subject:"${term}"`);
    });
  });

  it("is removable via its own kill switch without touching the other queries", () => {
    const code = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8").replace(
      "var GMAIL_V2_BROADENED_SEARCH_ENABLED_V2 = true;",
      "var GMAIL_V2_BROADENED_SEARCH_ENABLED_V2 = false;",
    );
    const context = vm.createContext({ console });
    vm.runInContext(`${code}\n;globalThis.__gq = { gmailV2Queries_ };`, context);
    const queries = (context.__gq as GmailQueryHelpers).gmailV2Queries_();
    expect(queries).toHaveLength(3);
  });
});
