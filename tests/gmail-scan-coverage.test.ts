import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Message = { getId(): string; getDate(): Date };
type Thread = { getId(): string; getMessages(): Message[]; addLabel: ReturnType<typeof vi.fn> };
const receivedAt = new Date("2026-09-04T17:00:00Z");
function message(id: string): Message {
  return { getId: () => id, getDate: () => receivedAt };
}
function thread(id: string): Thread {
  const messages = [message(`${id}-message`)];
  return { getId: () => id, getMessages: () => messages, addLabel: vi.fn() };
}
function harness(queries: Record<string, Thread[]>) {
  const values = new Map<string, string>();
  let now = Date.parse("2026-09-05T02:00:00Z");
  class ClockDate extends Date { static now() { return now; } }
  const processMessage = vi.fn((_message: Message) => ({ inserted: 0, updated: 1, noop: 0, pending: 0 }));
  const refresh = vi.fn();
  const context = vm.createContext({
    Date: ClockDate,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key: string) => values.get(key) ?? null,
      setProperty: (key: string, value: string) => values.set(key, value),
      deleteProperty: (key: string) => values.delete(key),
    }) },
    GmailApp: { search: (query: string, start: number, max: number) => queries[query].slice(start, start + max) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: vi.fn() }) },
    SpreadsheetApp: { flush: vi.fn() },
    ensureCanonicalTriggersForVersion_: vi.fn(),
    consumeTriggerLockSkips_: () => 0,
    writeLog_: vi.fn(),
    gmailSafetyV4RefreshD1_: refresh,
  });
  vm.runInContext(readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8"), context);
  context.gmailV2Queries_ = () => Object.keys(queries);
  context.gmailV2Labels_ = () => ({ processed: "processed", pending: "pending", error: "error" });
  context.processLogisticsMessageV2_ = processMessage;
  return {
    values, processMessage, refresh,
    run: () => vm.runInContext("processLogisticsEmailsV2()", context) as { threads: number; messages: number; budgetHit: boolean },
    elapse: (ms: number) => { now += ms; },
  };
}

describe("Gmail bounded scan coverage", () => {
  it("reaches matches beyond the first twelve and gives both query groups a turn", () => {
    const docs = Array.from({ length: 20 }, (_, i) => thread(`docs-${i}`));
    const carriers = Array.from({ length: 20 }, (_, i) => thread(`carrier-${i}`));
    const h = harness({ docs, carriers });
    const first = h.run();
    expect(first.threads).toBe(12);
    expect(h.processMessage.mock.calls.map(([item]) => item.getId()).slice(0, 2))
      .toEqual(["docs-0-message", "carrier-0-message"]);
    for (let i = 0; i < 7; i++) expect(h.run().threads).toBeLessThanOrEqual(12);
    expect(h.processMessage).toHaveBeenCalledTimes(40);
    expect(h.values.has("GMAIL_V2_V7_SEEN_docs-19-message")).toBe(true);
    expect(h.values.has("GMAIL_V2_V7_SEEN_carrier-19-message")).toBe(true);
  });

  it("discovers a later reply on a processed thread without replaying old messages", () => {
    const recent = thread("recent");
    const h = harness({ docs: [recent], carriers: [] });
    h.run();
    h.run();
    recent.getMessages().push(message("later-reply"));
    expect(h.run().messages).toBe(1);
    expect(h.processMessage).toHaveBeenCalledTimes(2);
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps the backlog cursor when the execution budget stops a scan early", () => {
    const h = harness({
      docs: Array.from({ length: 12 }, (_, i) => thread(`docs-${i}`)),
      carriers: Array.from({ length: 12 }, (_, i) => thread(`carrier-${i}`)),
    });
    h.processMessage.mockImplementationOnce(() => {
      h.elapse(210_000);
      return { inserted: 0, updated: 1, noop: 0, pending: 0 };
    });
    expect(h.run().budgetHit).toBe(true);
    expect(h.values.has("GMAIL_V2_SCAN_CURSOR_0")).toBe(false);
    expect(h.values.has("GMAIL_V2_SCAN_CURSOR_1")).toBe(false);
    h.run();
    expect(h.values.get("GMAIL_V2_SCAN_CURSOR_0")).toBe("6");
    expect(h.values.get("GMAIL_V2_SCAN_CURSOR_1")).toBe("6");
    expect(h.processMessage).toHaveBeenCalledTimes(12);
  });

  it("deduplicates overlapping searches and wraps at the end of the result set", () => {
    const shared = Array.from({ length: 7 }, (_, i) => thread(`shared-${i}`));
    const h = harness({ docs: shared, carriers: shared });
    expect(h.run().threads).toBe(6);
    expect(h.run().threads).toBe(4);
    expect(h.values.get("GMAIL_V2_SCAN_CURSOR_0")).toBe("3");
    expect(h.run().messages).toBe(0);
    expect(h.processMessage).toHaveBeenCalledTimes(7);
  });
});
