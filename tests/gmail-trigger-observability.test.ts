import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Gmail trigger recovery observability", () => {
  it("records and reports lock-starved Gmail/XPO cycles", () => {
    const triggers = readFileSync("google-apps-script/Triggers.gs", "utf8");
    const gmail = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
    const xpo = readFileSync("google-apps-script/GmailXpoV2.gs", "utf8");

    expect(triggers).toContain('GMAIL_PIPELINE_TRIGGER_SYNC_VERSION = "2026-09-01-central-v8-single-owner"');
    expect(triggers).toContain("recordTriggerLockSkip_");
    expect(triggers).toContain("consumeTriggerLockSkips_");
    expect(triggers).toContain("ensureCanonicalTriggersForVersion_");
    expect(gmail).toContain('recordTriggerLockSkip_("processLogisticsEmailsV2")');
    expect(gmail).toContain('priorLockSkips: consumeTriggerLockSkips_("processLogisticsEmailsV2")');
    expect(xpo).toContain('recordTriggerLockSkip_("processXpoTrackingEmailsV2")');
    expect(xpo).toContain('priorLockSkips: consumeTriggerLockSkips_("processXpoTrackingEmailsV2")');
  });
});
