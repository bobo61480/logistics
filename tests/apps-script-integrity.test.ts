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

<<<<<<< HEAD
  it("central trigger provisioning cleans legacy and current WMS/Gmail handlers", () => {
=======
  it("central trigger provisioning cleans legacy WMS/Gmail handlers and provisions the current ones", () => {
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
    const triggers = read("google-apps-script/Triggers.gs");

    expect(triggers).toContain('"processLogisticsEmails"');
    expect(triggers).toContain('"processLogisticsEmailsV2"');
    expect(triggers).toContain('"scanAndImportWmsTruckingOrders"');
    expect(triggers).toContain('"scanAndImportWmsTruckingOrdersV2"');
<<<<<<< HEAD
    expect(triggers).not.toContain('{ handler: "scanAndImportWmsTruckingOrdersV2"');
    expect(triggers).not.toContain('{ handler: "requestSiteRedeploy"');
  });

  it("keeps the WMS trucking importer disabled even if a stale trigger calls it", () => {
    const importer = read("google-apps-script/WmsTruckingSyncV2.gs");

    expect(importer).toContain("var WMS_TRUCKING_SYNC_ENABLED = false;");
    expect(importer).toContain('return { ok: true, skipped: "disabled" };');
=======
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
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
  });
});
