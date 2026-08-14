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
    expect(code).toContain('trucking: readSnapshotRows_(SPREADSHEET_ID, "WH Trucking Request"');
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

  it("central trigger provisioning cleans legacy and current WMS/Gmail handlers", () => {
    const triggers = read("google-apps-script/Triggers.gs");

    expect(triggers).toContain('"processLogisticsEmails"');
    expect(triggers).toContain('"processLogisticsEmailsV2"');
    expect(triggers).toContain('"scanAndImportWmsTruckingOrders"');
    expect(triggers).toContain('"scanAndImportWmsTruckingOrdersV2"');
    expect(triggers).not.toContain('{ handler: "scanAndImportWmsTruckingOrdersV2"');
    expect(triggers).not.toContain('{ handler: "requestSiteRedeploy"');
  });

  it("keeps the WMS trucking importer disabled even if a stale trigger calls it", () => {
    const importer = read("google-apps-script/WmsTruckingSyncV2.gs");

    expect(importer).toContain("var WMS_TRUCKING_SYNC_ENABLED = false;");
    expect(importer).toContain('return { ok: true, skipped: "disabled" };');
  });
});
