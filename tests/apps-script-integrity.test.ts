import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Apps Script production integrity", () => {
  it("serves an owner-authorized read snapshot for the private production workbooks", () => {
    const code = read("google-apps-script/Code.gs");
    expect(code).toContain("function doGet(e)");
    expect(code).toContain('action !== "snapshot"');
    expect(code).toContain("readSnapshotRows_");
    expect(code).toContain("NATIONAL_SPREADSHEET_ID");
    expect(code).toContain('trucking: readSnapshotRows_(master, "WH Trucking Request"');
    expect(code).toContain("const master = SpreadsheetApp.openById(SPREADSHEET_ID);");
    expect(code).not.toContain("readSnapshotRows_(SPREADSHEET_ID,");
    expect(code).toContain("function readSnapshotRows_(spreadsheet,");
  });

  it("deploys the snapshot as an anonymous owner-authorized web app and smoke-tests it", () => {
    const manifest = JSON.parse(read("google-apps-script/appsscript.json"));
    const workflow = read(".github/workflows/deploy-apps-script.yml");

    expect(manifest.webapp).toEqual({
      access: "ANYONE_ANONYMOUS",
      executeAs: "USER_DEPLOYING",
    });
    expect(workflow).toContain("Verify anonymous snapshot gateway");
    expect(workflow).toContain("payload.sources?.imports");
    expect(workflow).toContain("payload.sources?.trucking");
  });

  it("uses the spreadsheet-compatible canonical FDA/FWS status vocabulary", () => {
    const code = read("google-apps-script/Code.gs");
    const gmail = read("google-apps-script/GmailPipelineV2.gs");

    expect(code).toContain('"FDA Review / Hold"');
    expect(code).toContain('"FWS Review / Hold"');
    expect(code).not.toContain('"FDA Review/Hold"');
    expect(code).not.toContain('"FWS Review/Hold"');
    expect(gmail).toContain("canonicalLogisticsStatus_(record.status)");
  });

  it("has exactly one production compatibility entry point for the legacy WMS scanner name", () => {
    const code = read("google-apps-script/Code.gs");
    const compatibility = read("google-apps-script/zz_WmsTruckingCompatibility.gs");
    const combined = `${code}\n${compatibility}`;
    const matches = combined.match(/function\s+scanAndImportWmsTruckingOrders\s*\(/g) ?? [];

    expect(matches).toHaveLength(1);
    expect(compatibility).toContain("return scanAndImportWmsTruckingOrdersV2();");
  });

  it("central trigger provisioning cleans legacy WMS/Gmail handlers and provisions the current ones", () => {
    const triggers = read("google-apps-script/Triggers.gs");

    expect(triggers).toContain('"processLogisticsEmails"');
    expect(triggers).toContain('"processLogisticsEmailsV2"');
    expect(triggers).toContain('"scanAndImportWmsTruckingOrders"');
    expect(triggers).toContain('"scanAndImportWmsTruckingOrdersV2"');
    // Re-enabled 2026-08-23 (see the "re-enables the hardened WMS trucking
    // importer" test below) — the V2 handler IS provisioned now, unlike the
    // legacy alias and the obsolete requestSiteRedeploy handler.
    expect(triggers).toContain('{ handler: "scanAndImportWmsTruckingOrdersV2", minutes: 15 }');
    expect(triggers).not.toContain('{ handler: "scanAndImportWmsTruckingOrders",');
    expect(triggers).not.toContain('{ handler: "requestSiteRedeploy"');
  });

  it("re-enables the hardened WMS trucking importer in dry-run mode with the customer-canonicalization fix", () => {
    const importer = read("google-apps-script/WmsTruckingSyncV2.gs");
    const code = read("google-apps-script/Code.gs");

    expect(importer).toContain("var WMS_TRUCKING_SYNC_ENABLED = true;");
    expect(importer).toContain("var WMS_TRUCKING_DRY_RUN = true;");
    expect(importer).toContain("function logWmsDryRun_(");
    expect(importer).toContain("function wouldChangeMappedValue_(");
    // Word-boundary anchored — must not collapse "MEGA MARTINEZ..." into
    // "MEGA MART" the way the unanchored `indexOf(...) === 0` check used to
    // (see tests/wms-trucking-sync.test.ts for the behavioral regression test).
    expect(code).toContain('/^MEGA MART\\b/.test(key)');
    expect(code).toContain('/^TOKTOK BEAUTY\\b/.test(key)');
    expect(code).toContain('/^ROYAL IMEX\\b/.test(key)');
    expect(code).not.toContain('key.indexOf("MEGA MART") === 0');
    expect(code).not.toContain('key.indexOf("TOKTOK BEAUTY") === 0');
    expect(code).not.toContain('key.indexOf("ROYAL IMEX") === 0');
  });

  it("runs the WH Trucking Request customer-lookup create path live, after a dry-run review period", () => {
    const lookup = read("google-apps-script/CustomerLookup.gs");
    expect(lookup).toContain("var CUSTOMER_LOOKUP_ENABLED = true;");
    expect(lookup).toContain("var CUSTOMER_CREATE_DRY_RUN = false;");
    // Codex review on PR #92: a live-write caller must not treat an
    // ambiguous match (multiple existing locations for the same brand) the
    // same as a genuinely absent customer, or it creates a fresh blank
    // duplicate on top of already-known locations. Both files below guard
    // the same class of bug independently (see the NOTE ON DUPLICATED
    // HELPERS convention in CustomerBackfill.gs).
    expect(lookup).toContain("function isAmbiguousLocationFamily_(");
    expect(lookup).toContain("LockService.getScriptLock()");
    // Round 2 of the same review: matching a record created earlier in the
    // same paste must not blindly apply its address to a row with a
    // different actual address, and a dropped edit on lock timeout must be
    // observable in PIPELINE LOG, not just the executions log.
    expect(lookup).toContain("function customerAddressConflicts_(");
    expect(lookup).toContain("CUSTOMER LOOKUP LOCK TIMEOUT");
    // The handler is NOT a bare onEdit(e): that auto-installs as a
    // restricted simple trigger that can't call SpreadsheetApp.openById
    // (which logPipeline_ needs). It's customerLookupOnEdit(e), registered
    // as a full installable trigger in Triggers.gs instead.
    expect(lookup).toContain("function customerLookupOnEdit(e)");
    expect(lookup).not.toMatch(/function\s+onEdit\s*\(/);
  });

  it("runs the customer backfill batch job live, with the '- 1'/'- 2' second-location write path implemented", () => {
    const backfill = read("google-apps-script/CustomerBackfill.gs");
    expect(backfill).toContain("var CUSTOMER_BACKFILL_ENABLED = true;");
    expect(backfill).toContain("var CUSTOMER_BACKFILL_DRY_RUN = false;");
    expect(backfill).toContain("function appendBackfillCustomer_(");
    expect(backfill).toContain("function fillBackfillCustomerAddress_(");
    expect(backfill).toContain("function flagBackfillSecondLocation_(");
    expect(backfill).toContain("function isAmbiguousLocationFamily_(");
    expect(backfill).toContain('"ambiguous-location-family"');
    // Every candidate is still logged to PIPELINE LOG regardless of dry-run
    // state, live or not — the audit trail must never be silently dropped.
    expect(backfill).toContain("function logCustomerBackfillCandidate_(");
    // Round 2 of Codex's PR #92 review: appending the new numbered location
    // must happen BEFORE renaming the original to "- 1", so a partial-write
    // failure self-heals instead of orphaning an unmatchable row; and an
    // already-ambiguous suffix family must still be able to append a
    // genuinely new address via appendNewFamilyLocation_/isSuffixLocationFamily_.
    expect(backfill).toContain("function appendNewFamilyLocation_(");
    expect(backfill).toContain("function isSuffixLocationFamily_(");
    expect(backfill).toContain("function hasEstablishedSuffixConvention_(");
  });

  it("registers the WH Trucking Request customer-lookup edit handler as a fully-authorized installable trigger", () => {
    const triggers = read("google-apps-script/Triggers.gs");
    // Codex review on PR #92: a bare global onEdit(e) auto-installs as a
    // restricted simple trigger that can't call SpreadsheetApp.openById
    // (which CustomerLookup.gs's ambiguous/lock-timeout logging needs) — it
    // must instead be a normal installable trigger like every other handler
    // here.
    expect(triggers).toContain('{ handler: "customerLookupOnEdit" }');
    expect(triggers).toContain("EDIT_TRIGGER_PLAN");
    expect(triggers).toContain(".forSpreadsheet(SPREADSHEET_ID).onEdit().create()");
    expect(triggers).toContain('"customerLookupOnEdit"');
  });
});
