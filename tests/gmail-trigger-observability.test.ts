import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("Gmail trigger recovery observability", () => {
  it("records and reports lock-starved Gmail/XPO cycles", () => {
    const triggers = readFileSync("google-apps-script/Triggers.gs", "utf8");
    const gmail = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
    const xpo = readFileSync("google-apps-script/GmailXpoV2.gs", "utf8");

    expect(triggers).toMatch(/GMAIL_PIPELINE_TRIGGER_SYNC_VERSION\s*=\s*"\d{4}-\d{2}-\d{2}-central-v\d+-[^"]+"/);
    expect(triggers).toContain("recordTriggerLockSkip_");
    expect(triggers).toContain("consumeTriggerLockSkips_");
    expect(triggers).toContain("ensureCanonicalTriggersForVersion_");
    expect(gmail).toContain('recordTriggerLockSkip_("processLogisticsEmailsV2")');
    expect(gmail).toContain('priorLockSkips: consumeTriggerLockSkips_("processLogisticsEmailsV2")');
    expect(xpo).toContain('recordTriggerLockSkip_("processXpoTrackingEmailsV2")');
    expect(xpo).toContain('priorLockSkips: consumeTriggerLockSkips_("processXpoTrackingEmailsV2")');
  });

  it("removes every canonical handler before rebuilding the trigger plan", () => {
    const triggers = readFileSync("google-apps-script/Triggers.gs", "utf8");
    const context = vm.createContext({ console });
    vm.runInContext(
      `${triggers}\n;globalThis.__triggerConfig = { plan: TRIGGER_PLAN, cleanup: TRIGGER_CLEANUP_HANDLERS };`,
      context,
    );
    const config = context.__triggerConfig as {
      plan: Array<{ handler: string }>;
      cleanup: string[];
    };
    const cleanup = new Set(config.cleanup);
    expect(config.plan.map((entry) => entry.handler).filter((handler) => !cleanup.has(handler))).toEqual([]);
  });
});
