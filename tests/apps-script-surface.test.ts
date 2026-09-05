import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const DIR = "google-apps-script";
const files = readdirSync(DIR).filter((name) => name.endsWith(".gs")).sort();
const sources = new Map(files.map((name) => [name, readFileSync(join(DIR, name), "utf8")]));

type Declaration = { file: string; kind: string };

/**
 * Every GLOBAL declaration, mapped to where it is declared.
 *
 * Parsed rather than regex-matched, and read from `SourceFile.statements` so
 * only true top-level declarations count — scope is decided by syntax, not by
 * indentation, so a nested helper is excluded because it is not a top-level
 * statement, not because of how it is formatted.
 *
 * Covers functions, classes and var/let/const alike: a `const` in one file and
 * a `var` of the same name in another is the collision that actually breaks a
 * deployment, and looking only at functions would miss it entirely.
 */
const declarations = (() => {
  const map = new Map<string, Declaration[]>();
  const add = (name: string, file: string, kind: string) =>
    map.set(name, [...(map.get(name) ?? []), { file, kind }]);

  for (const [file, source] of sources) {
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2019, true, ts.ScriptKind.JS);
    for (const statement of parsed.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        add(statement.name.text, file, "function");
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        add(statement.name.text, file, "class");
      } else if (ts.isVariableStatement(statement)) {
        const { flags } = statement.declarationList;
        const kind = flags & ts.NodeFlags.Const ? "const" : flags & ts.NodeFlags.Let ? "let" : "var";
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) add(declaration.name.text, file, kind);
        }
      }
    }
  }
  return map;
})();

const isFunction = (name: string) =>
  (declarations.get(name) ?? []).some((entry) => entry.kind === "function");

const triggers = sources.get("Triggers.gs") ?? "";

describe("Apps Script global surface", () => {
  // Apps Script loads every .gs file into ONE global scope. Two files declaring
  // the same name is either a silent wrong-implementation bug (two functions —
  // whichever loads last wins) or a hard load failure that takes down the whole
  // project ("Identifier X has already been declared", when either side is a
  // const or let). Neither is visible in a per-file review.
  it("declares every global exactly once across the whole project", () => {
    const duplicated = [...declarations.entries()]
      .filter(([, where]) => where.length > 1)
      .map(([name, where]) => `${name}: ${where.map((w) => `${w.file} (${w.kind})`).join(" vs ")}`);
    expect(duplicated).toEqual([]);
  });

  // A scheduled handler that no longer exists fails silently in production:
  // the trigger fires, Apps Script cannot resolve the name, and the job simply
  // stops running. Trimming dead code must never reach a scheduled entrypoint.
  it("backs every scheduled trigger handler with a real function", () => {
    const planned = [...triggers.matchAll(/\{\s*handler:\s*"([A-Za-z0-9_$]+)"/g)].map((m) => m[1]);
    expect(planned.length).toBeGreaterThan(0);
    for (const handler of planned) {
      expect(isFunction(handler), `TRIGGER_PLAN handler ${handler} has no function definition`).toBe(true);
    }
  });

  // Retired triggers are pruned by setupAllTriggers(), but a legacy trigger can
  // still be installed until it runs. These thin aliases keep such a trigger
  // from hard-erroring in the meantime, so they outlive their schedule.
  it("keeps the legacy handler aliases that pending trigger cleanup still needs", () => {
    for (const alias of ["scanAndImportWmsTruckingOrders", "dedupeWhTruckingLocationSafeV5", "requestSiteRedeploy"]) {
      expect(isFunction(alias), `${alias} is still referenced by TRIGGER_CLEANUP_HANDLERS`).toBe(true);
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
