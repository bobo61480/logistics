import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function makeHarness(messageTime = "2026-09-04T12:00:00Z") {
  const source = readFileSync("google-apps-script/GmailXpoV2.gs", "utf8");
  const properties = new Map<string, string>();
  const pendingRows: unknown[] = [];
  const messageEpoch = Date.parse(messageTime);
  let now = messageEpoch + 1_000;

  class FakeDate extends Date {
    constructor(value?: string | number | Date) {
      super(value === undefined ? now : value instanceof Date ? value.getTime() : value);
    }
    static now() { return now; }
  }

  const message = {
    getId: () => "xpo-late-source-row",
    getDate: () => new FakeDate(messageEpoch),
    getSubject: () => "Shipment Progress for Pro 07553743510 - Delivered",
    getPlainBody: () => [
      "Shipment: 755-374351",
      "Pro Number: 07553743510",
      "PO# 0101346865",
      "Pickup: 09/04/2026",
    ].join("\n"),
  };
  const propertyStore = {
    getProperty: (key: string) => properties.get(key) ?? null,
    setProperty: (key: string, value: string) => { properties.set(key, String(value)); },
    deleteProperty: (key: string) => { properties.delete(key); },
  };
  const context = vm.createContext({
    console,
    Date: FakeDate,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) },
    GmailApp: { search: () => [{ getMessages: () => [message] }] },
    PropertiesService: { getScriptProperties: () => propertyStore },
    ensureCanonicalTriggersForVersion_: () => false,
    recordTriggerLockSkip_: () => undefined,
    consumeTriggerLockSkips_: () => 0,
    normalizeEmailDateV2_: (value: string) => value,
    addPendingRow_: (entry: unknown) => { pendingRows.push(entry); },
    addCommittedAuditRow_: () => undefined,
    logPipeline_: () => undefined,
    gmailSafetyV4RefreshD1_: () => undefined,
  });
  vm.runInContext(
    `${source}\nupsertXpoSourceV2_ = function () { return { matched: false, reason: "No source row matched" }; };
     globalThis.__xpo = { run: processXpoTrackingEmailsV2, seen: gmailXpoSeenV2_ };`,
    context,
  );
  const api = context.__xpo as {
    run: () => { pending: number; retryDeferred: number };
    seen: (id: string) => boolean;
  };
  return {
    api,
    pendingRows,
    advance(minutes: number) { now += minutes * 60_000; },
  };
}

describe("XPO Gmail late-source retry", () => {
  it("keeps notices dated before today's one-time recovery cutoff consumed", () => {
    const harness = makeHarness("2026-09-04T06:59:59Z");
    const result = harness.api.run();

    expect(result.pending).toBe(0);
    expect(harness.pendingRows).toHaveLength(0);
    expect(harness.api.seen("xpo-late-source-row")).toBe(true);
  });

  it("does not permanently consume an unmatched notice on the first attempt", () => {
    const harness = makeHarness();
    const result = harness.api.run();

    expect(result.pending).toBe(0);
    expect(result.retryDeferred).toBe(1);
    expect(harness.pendingRows).toHaveLength(0);
    expect(harness.api.seen("xpo-late-source-row")).toBe(false);
  });

  it("parks the notice once after four bounded attempts", () => {
    const harness = makeHarness();
    for (const waitMinutes of [16, 31, 61]) {
      const result = harness.api.run();
      expect(result.pending).toBe(0);
      harness.advance(waitMinutes);
    }

    const final = harness.api.run();
    expect(final.pending).toBe(1);
    expect(harness.pendingRows).toHaveLength(1);
    expect(harness.api.seen("xpo-late-source-row")).toBe(true);
  });
});
