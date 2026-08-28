import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type DiscoveryHelpers = {
  gmailV2AdmissibleThreadsForQueryV2_: (
    query: string,
    deadline: number,
    offsetKey?: string,
  ) => { admissible: FakeThread[]; deferredCounts: Record<string, number>; truncated: boolean };
};

type FakeThread = { getId: () => string; getMessages: () => FakeMessage[] };
type FakeMessage = { getId: () => string; getDate: () => Date };

function makeThread(id: string): FakeThread {
  return {
    getId: () => id,
    getMessages: () => [{ getId: () => id + "-m1", getDate: () => new Date() }],
  };
}

// A fake clock that returns base+0, base+1, base+2, ... on successive calls,
// so a deadline can be pinned to an exact call count instead of racing real
// wall-clock time (which is too fast/unreliable to hit a "mid-page" break
// deterministically in a unit test).
function makeFakeClock(base: number) {
  let counter = 0;
  return () => base + counter++;
}

function loadHelpers(searchCalls: Array<[string, number, number]>, threadsByQuery: FakeThread[], props: Map<string, string>, nowFn: () => number) {
  const pipeline = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
  const context = vm.createContext({
    console,
    Date: { now: nowFn },
    GmailApp: {
      search: (query: string, start: number, pageSize: number) => {
        searchCalls.push([query, start, pageSize]);
        return threadsByQuery.slice(start, start + pageSize);
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) => props.get(key) ?? null,
        setProperty: (key: string, value: string) => props.set(key, value),
        deleteProperty: (key: string) => props.delete(key),
      }),
    },
  });
  vm.runInContext(
    `${pipeline}\n;globalThis.__discovery = { gmailV2AdmissibleThreadsForQueryV2_ };`,
    context,
  );
  return context.__discovery as DiscoveryHelpers;
}

describe("gmailV2AdmissibleThreadsForQueryV2_ discovery offset persistence", () => {
  // Regression for a Codex review finding: a deadline hit mid-page used to
  // abandon the rest of that page with no memory of where it stopped, so
  // every trigger invocation restarted the same query at offset 0 — a
  // stable backlog at the front of the results could permanently starve an
  // unseen thread ranked behind it.
  it("persists the exact resume point when the deadline is hit mid-page, not the full page size", () => {
    const searchCalls: Array<[string, number, number]> = [];
    const threads = Array.from({ length: 5 }, (_, i) => makeThread("t" + i));
    const props = new Map<string, string>();
    // A tight deadline trips partway through the page, before every thread
    // is evaluated — the exact tick count a real evaluation consumes
    // (multiple internal Date.now() reads per thread) isn't something a
    // regression test should hardcode, so this asserts the invariant that
    // actually matters: the persisted offset advances one-for-one with
    // however many threads were actually evaluated, not rounded up to a
    // full page, and the scan was genuinely interrupted (not all 5 reached).
    const helpers = loadHelpers(searchCalls, threads, props, makeFakeClock(1000));
    const result = helpers.gmailV2AdmissibleThreadsForQueryV2_("q", 1003, "OFFSET_KEY");

    expect(result.admissible.length).toBeGreaterThan(0);
    expect(result.admissible.length).toBeLessThan(threads.length);
    expect(result.admissible.map((t) => t.getId())).toEqual(
      threads.slice(0, result.admissible.length).map((t) => t.getId()),
    );
    expect(props.get("OFFSET_KEY")).toBe(String(result.admissible.length));
  });

  it("resumes from the persisted offset on the next call instead of re-scanning from 0", () => {
    const searchCalls: Array<[string, number, number]> = [];
    const threads = Array.from({ length: 5 }, (_, i) => makeThread("t" + i));
    const props = new Map<string, string>([["OFFSET_KEY", "2"]]);
    const helpers = loadHelpers(searchCalls, threads, props, makeFakeClock(2000));
    const result = helpers.gmailV2AdmissibleThreadsForQueryV2_("q", 999999, "OFFSET_KEY");

    expect(searchCalls[0]).toEqual(["q", 2, 50]);
    expect(result.admissible.map((t) => t.getId())).toEqual(["t2", "t3", "t4"]);
  });

  it("resets the offset to 0 once the query's results are genuinely exhausted", () => {
    const searchCalls: Array<[string, number, number]> = [];
    const threads = Array.from({ length: 3 }, (_, i) => makeThread("t" + i));
    const props = new Map<string, string>([["OFFSET_KEY", "50"]]);
    const helpers = loadHelpers(searchCalls, threads, props, makeFakeClock(3000));
    // Simulate having previously advanced to offset 50 with nothing left
    // there (a short-lived query whose backlog has since fully drained) —
    // GmailApp.search always returns whatever the fixture holds regardless
    // of start, so this exercises the "page shorter than page size" exhaustion
    // path directly.
    helpers.gmailV2AdmissibleThreadsForQueryV2_("q", 999999, "OFFSET_KEY");

    expect(props.has("OFFSET_KEY")).toBe(false);
  });

  // Regression for a Codex review finding: "this thread wasn't found by
  // this query" is only trustworthy when the query's discovery actually
  // reached its true end-of-results this run — the caller uses `truncated`
  // to know when that conclusion can't be drawn (e.g. before deciding a
  // thread found only by the broadened query is genuinely broadened-only).
  it("reports truncated:true when the deadline cuts discovery short", () => {
    const searchCalls: Array<[string, number, number]> = [];
    const threads = Array.from({ length: 5 }, (_, i) => makeThread("t" + i));
    const props = new Map<string, string>();
    const helpers = loadHelpers(searchCalls, threads, props, makeFakeClock(5000));
    const result = helpers.gmailV2AdmissibleThreadsForQueryV2_("q", 5003, "OFFSET_KEY");
    expect(result.truncated).toBe(true);
  });

  it("reports truncated:false once a query's results are genuinely exhausted", () => {
    const searchCalls: Array<[string, number, number]> = [];
    const threads = Array.from({ length: 3 }, (_, i) => makeThread("t" + i));
    const props = new Map<string, string>();
    const helpers = loadHelpers(searchCalls, threads, props, makeFakeClock(6000));
    const result = helpers.gmailV2AdmissibleThreadsForQueryV2_("q", 999999, "OFFSET_KEY");
    expect(result.truncated).toBe(false);
  });

  it("does not persist or read an offset when no offsetKey is passed", () => {
    const searchCalls: Array<[string, number, number]> = [];
    const threads = Array.from({ length: 3 }, (_, i) => makeThread("t" + i));
    const props = new Map<string, string>();
    const helpers = loadHelpers(searchCalls, threads, props, makeFakeClock(4000));
    helpers.gmailV2AdmissibleThreadsForQueryV2_("q", 999999);

    expect(searchCalls[0]).toEqual(["q", 0, 50]);
    expect(props.size).toBe(0);
  });
});
