import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type ThreadAdmissionHelpers = {
  gmailV2ThreadHasUnprocessedMessageV2_: (thread: FakeThread) => boolean;
};

type FakeThread = { getMessages: () => FakeMessage[] };
type FakeMessage = { getId: () => string; getDate: () => Date };

function makeMessage(id: string, date: Date): FakeMessage {
  return { getId: () => id, getDate: () => date };
}

function loadHelpers(seenIds: string[], retryDeferredIds: string[] = []) {
  const pipeline = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
  const props = new Map<string, string>();
  seenIds.forEach((id) => props.set("GMAIL_V2_SEEN_" + id, String(Date.now())));
  retryDeferredIds.forEach((id) => props.set("GMAIL_V2_RETRY_AT_" + id, String(Date.now() + 3600000)));

  const context = vm.createContext({
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) => props.get(key) || null,
      }),
    },
  });
  vm.runInContext(
    `${pipeline}\n;globalThis.__admission = { gmailV2ThreadHasUnprocessedMessageV2_ };`,
    context,
  );
  return context.__admission as ThreadAdmissionHelpers;
}

describe("gmailV2ThreadHasUnprocessedMessageV2_", () => {
  it("is true when a thread has at least one fresh, unseen message", () => {
    const helpers = loadHelpers([]);
    const thread = { getMessages: () => [makeMessage("m1", new Date())] };
    expect(helpers.gmailV2ThreadHasUnprocessedMessageV2_(thread)).toBe(true);
  });

  it("is false once every message in the thread is already marked seen", () => {
    const helpers = loadHelpers(["m1", "m2"]);
    const thread = { getMessages: () => [makeMessage("m1", new Date()), makeMessage("m2", new Date())] };
    // Regression for a Codex review finding: a per-query admission cap
    // must not let a fully-processed thread keep consuming its query's
    // share on every run, starving a genuinely new thread ranked below it.
    expect(helpers.gmailV2ThreadHasUnprocessedMessageV2_(thread)).toBe(false);
  });

  it("is true when only SOME of the thread's messages are seen", () => {
    const helpers = loadHelpers(["m1"]);
    const thread = { getMessages: () => [makeMessage("m1", new Date()), makeMessage("m2", new Date())] };
    expect(helpers.gmailV2ThreadHasUnprocessedMessageV2_(thread)).toBe(true);
  });

  it("is false when the only unseen message is retry-deferred", () => {
    const helpers = loadHelpers([], ["m1"]);
    const thread = { getMessages: () => [makeMessage("m1", new Date())] };
    expect(helpers.gmailV2ThreadHasUnprocessedMessageV2_(thread)).toBe(false);
  });

  it("is false when the only unseen message is older than the lookback window", () => {
    const helpers = loadHelpers([]);
    const staleDate = new Date(Date.now() - 30 * 86400000);
    const thread = { getMessages: () => [makeMessage("m1", staleDate)] };
    expect(helpers.gmailV2ThreadHasUnprocessedMessageV2_(thread)).toBe(false);
  });
});
