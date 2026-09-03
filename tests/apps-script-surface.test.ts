import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = "google-apps-script";
const files = readdirSync(DIR).filter((name) => name.endsWith(".gs")).sort();
const sources = new Map(files.map((name) => [name, readFileSync(join(DIR, name), "utf8")]));

/**
 * Every GLOBAL function declaration, mapped to the files declaring it. Anchored
 * at column 0 on purpose: an indented `function` is nested inside another and
 * is locally scoped, so it never participates in the global namespace.
 */
const declarations = (() => {
  const map = new Map<string, string[]>();
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)) {
      map.set(match[1], [...(map.get(match[1]) ?? []), name]);
    }
  }
  return map;
})();

const triggers = sources.get("Triggers.gs") ?? "";

describe("Apps Script global surface", () => {
  // Apps Script loads every .gs file into ONE global scope, so two files
  // declaring the same name silently resolve to whichever loads last. That is
  // invisible in review and produces a wrong-implementation bug at runtime.
  it("declares every function exactly once across the whole project", () => {
    const duplicated = [...declarations.entries()]
      .filter(([, where]) => where.length > 1)
      .map(([name, where]) => `${name} (${where.join(", ")})`);
    expect(duplicated).toEqual([]);
  });

  // A scheduled handler that no longer exists fails silently in production:
  // the trigger fires, Apps Script cannot resolve the name, and the job simply
  // stops running. Trimming dead code must never reach a scheduled entrypoint.
  it("backs every scheduled trigger handler with a real function", () => {
    const planned = [...triggers.matchAll(/\{\s*handler:\s*"([A-Za-z0-9_$]+)"/g)].map((m) => m[1]);
    expect(planned.length).toBeGreaterThan(0);
    for (const handler of planned) {
      expect(declarations.has(handler), `TRIGGER_PLAN handler ${handler} has no definition`).toBe(true);
    }
  });

  // Retired triggers are pruned by setupAllTriggers(), but a legacy trigger can
  // still be installed until it runs. These thin aliases keep such a trigger
  // from hard-erroring in the meantime, so they outlive their schedule.
  it("keeps the legacy handler aliases that pending trigger cleanup still needs", () => {
    for (const alias of ["scanAndImportWmsTruckingOrders", "dedupeWhTruckingLocationSafeV5", "requestSiteRedeploy"]) {
      expect(declarations.has(alias), `${alias} is still referenced by TRIGGER_CLEANUP_HANDLERS`).toBe(true);
    }
  });

  // Removed 2026-09-03 as unreachable: one-off setup routines and superseded
  // trigger aliases. setupAllTriggers() in Triggers.gs is the single owner of
  // trigger provisioning; nothing should reintroduce a second way in.
  it("does not reintroduce the retired one-off and alias helpers", () => {
    for (const retired of [
      "authorizeCmsImsExternalRequest",
      "setMappedValue_",
      "createTimeDrivenTrigger",
      "create30MinTrigger",
      "addWebsiteStatusDropdownToAllSourceSheets",
      "ensureGmailV2Trigger_",
      "getCompletedImportShipments_",
    ]) {
      expect(declarations.has(retired), `${retired} was retired as unreachable`).toBe(false);
    }
  });
});
