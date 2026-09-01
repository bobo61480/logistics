import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(`google-apps-script/${name}`, "utf8");

describe("Apps Script consolidation", () => {
  it("keeps all production schedules under the canonical trigger owner", () => {
    const triggers = read("Triggers.gs");
    const inventory = read("InventorySync.gs");
    expect(triggers.match(/ScriptApp\.newTrigger\(/g)).toHaveLength(1);
    expect(triggers).toContain('"dedupeWhTruckingLocationSafeV5"');
    expect(triggers).not.toContain('{ handler: "dedupeWhTruckingLocationSafeV5"');
    expect(inventory).not.toContain("ensureHourlySmallParcelTrigger_");
    expect(existsSync("google-apps-script/zzzzzzzzzz_DeduplicationSchedulerV4.gs")).toBe(false);
    expect(read("GmailPipelineV2.gs")).not.toContain("syncInventoryModule()");
  });

  it("does not replace canonical functions during file evaluation", () => {
    const source = readdirSync("google-apps-script")
      .filter((name) => name.endsWith(".gs"))
      .map((name) => read(name))
      .join("\n");
    const protectedNames = [
      "doGet",
      "mergeRecordContextV2_",
      "upsertInboundEmailV2_",
      "upsertOutboundEmailV2_",
      "commitApprovedPendingRow_",
      "reviewPendingRow_",
      "addPendingRow_",
      "addCommittedAuditRow_",
      "syncInventoryModule",
      "normalizeWmsDestinationHint_",
      "chooseWmsTargetRow_",
      "scanAndImportWmsTruckingOrdersV2",
    ];
    for (const name of protectedNames) {
      expect(source).not.toMatch(new RegExp(`(?:^|\\n)\\s*${name}\\s*=\\s*function\\b`));
    }
  });

  it("shares exact and canonical customer matching between lookup and backfill", () => {
    const shared = read("CustomerMatching.gs");
    const lookup = read("CustomerLookup.gs");
    const backfill = read("CustomerBackfill.gs");
    expect(shared).toContain("matchUniqueCustomerRecord_");
    expect(lookup).toContain("return matchUniqueCustomerRecord_(customerValue, records)");
    expect(backfill).toContain("return matchUniqueCustomerRecord_(customerValue, records)");
  });
});
