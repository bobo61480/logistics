import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync("scripts/sync-google-sheets-d1.mjs", "utf8");

/**
 * The sync script self-executes on import, so the classifier is lifted into a
 * vm context instead — the same approach the Apps Script helper tests use.
 */
function loadClassifier(): (status: number, payload: unknown) => boolean {
  const match = source.match(/function isFatalSheetsFailure\([\s\S]*?\n}/);
  if (!match) throw new Error("isFatalSheetsFailure not found in sync script");
  const context = createContext({});
  runInContext(`${match[0]}\nglobalThis.__fn = isFatalSheetsFailure;`, context);
  return (context as { __fn: (status: number, payload: unknown) => boolean }).__fn;
}

const isFatalSheetsFailure = loadClassifier();

describe("Google Sheets -> D1 sync fatal-failure detection", () => {
  // The exact payload Google returns when the Sheets API is not enabled for the
  // project owning the OAuth client. This took a production sync from "37 tabs
  // failed" to one actionable line.
  it("treats a disabled Sheets API as fatal rather than a per-tab error", () => {
    expect(isFatalSheetsFailure(403, {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "Google Sheets API has not been used in project 1072944905499 before or it is disabled.",
        errors: [{ reason: "SERVICE_DISABLED" }],
      },
    })).toBe(true);
  });

  it("treats a revoked or expired credential as fatal", () => {
    expect(isFatalSheetsFailure(401, { error: { message: "Invalid Credentials" } })).toBe(true);
  });

  it("treats accessNotConfigured as fatal", () => {
    expect(isFatalSheetsFailure(403, { error: { errors: [{ reason: "accessNotConfigured" }] } })).toBe(true);
  });

  // Per-tab problems must NOT abort the run: one missing or renamed tab should
  // leave every other tab free to sync.
  it("leaves genuinely per-tab failures non-fatal", () => {
    expect(isFatalSheetsFailure(404, { error: { message: "Requested entity was not found." } })).toBe(false);
    expect(isFatalSheetsFailure(400, { error: { message: "Unable to parse range: 'Sheet9'!A1:Z" } })).toBe(false);
    expect(isFatalSheetsFailure(429, { error: { message: "Quota exceeded" } })).toBe(false);
    expect(isFatalSheetsFailure(500, { error: { message: "Internal error" } })).toBe(false);
  });

  it("does not misread a 403 that carries no project-level reason", () => {
    expect(isFatalSheetsFailure(403, { error: { message: "The caller does not have permission to edit." } })).toBe(false);
  });
});

describe("Google Sheets -> D1 sync fatal-failure handling", () => {
  it("skips the public fallback for a fatal failure", () => {
    // A private workbook can only 404 on the gviz fallback, so retrying there
    // adds a second misleading error to every tab.
    expect(source).toContain("if (apiError instanceof FatalSheetsError) throw apiError;");
  });

  it("aborts the run and records it rather than reporting every tab", () => {
    expect(source).toContain("if (fatal) return {");
    expect(source).toContain("FATAL ${fatal.message}");
    expect(source).toContain("process.exitCode = 1;");
  });
});
