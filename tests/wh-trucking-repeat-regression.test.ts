import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("WH Trucking Request repeat regression", () => {
  it("reconstructs destination-aware target keys exactly like WMS source keys", () => {
    const importer = read("google-apps-script/WmsTruckingSyncV2.gs");

    expect(importer).toContain(
      "var targetDestinationHint = targetLocationIndex !== undefined ? normalizeWmsDestinationHint_(targetRow[targetLocationIndex]) : \"\";",
    );
    expect(importer).toContain(
      "var targetKey = wmsExactGroupKey_(targetCustomer, targetDateInfo, targetDestinationHint);",
    );
  });

  it("never lets Gmail append when a strong invoice or PRO identity is already ambiguous", () => {
    const gmail = read("google-apps-script/GmailPipelineV2.gs");

    expect(gmail).toContain("if (candidates.length > 1 && candidates[0].score === candidates[1].score)");
    expect(gmail).toContain('blocked: "ambiguous-existing-identity"');
    expect(gmail).toContain("if (!allowInsert) return { matched: false, action: \"noop\" };");
  });
});
