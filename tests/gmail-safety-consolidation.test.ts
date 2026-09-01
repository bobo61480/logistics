import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function loadSafety() {
  const source = readFileSync("google-apps-script/zzzzzzzz_GmailSafetyV4.gs", "utf8");
  const context = vm.createContext({ console });
  vm.runInContext(
    `${source}\n;globalThis.__safety = { gmailSafetyV4ApplyRecord_, gmailSafetyV4ValidFreightId_ };`,
    context,
  );
  return context.__safety as {
    gmailSafetyV4ApplyRecord_: (record: Record<string, unknown>, meta: Record<string, unknown>) => Record<string, unknown>;
    gmailSafetyV4ValidFreightId_: (value: unknown) => boolean;
  };
}

function loadCommit(upsertResult: { matched: boolean; action: string; row?: number }) {
  const validation = readFileSync("google-apps-script/Validation.gs", "utf8");
  const context = vm.createContext({
    console,
    GMAIL_SAFETY_V4_NEEDS_CORRECTION: "NEEDS CORRECTION",
    upsertInboundEmailV2_: () => upsertResult,
    upsertOutboundEmailV2_: () => upsertResult,
  });
  vm.runInContext(`${validation}\n;globalThis.__commit = commitApprovedPendingRow_;`, context);
  return context.__commit as (
    sheet: { getRange: (row: number, col: number, rows?: number) => unknown },
    row: number,
    data: string[],
    columns: Record<string, number>,
  ) => { committed: boolean; action: string };
}

function fakePendingRow() {
  const values = new Map<string, string>();
  const backgrounds: string[] = [];
  return {
    values,
    backgrounds,
    sheet: {
      getRange: (row: number, col: number) => ({
        setValue: (value: unknown) => values.set(`${row}:${col}`, String(value)),
        getDisplayValue: () => values.get(`${row}:${col}`) || "",
        setBackground: (value: string) => backgrounds.push(value),
      }),
    },
  };
}

const columns = {
  "Raw JSON": 0,
  Customer: 1,
  "Invoice / PI": 2,
  "BL / PRO": 3,
  Container: 4,
  Qty: 5,
  Note: 6,
  "Ship Date / ETA": 7,
  Kind: 8,
  Status: 9,
  Issues: 10,
};

describe("explicit Gmail safety integration", () => {
  it("rejects placeholder freight IDs and unsafe cancellation instructions", () => {
    const safety = loadSafety();
    expect(safety.gmailSafetyV4ValidFreightId_("TRACKING")).toBe(false);
    const record = safety.gmailSafetyV4ApplyRecord_(
      { pro: "TRACKING", status: "CANCELLED" },
      { from: "operator@stylekoreanus.com" },
    );
    expect(record.pro).toBe("");
    expect(record.status).toBe("");
    expect(String(record.parseError)).toContain("strong shipment identifier");
  });

  it("moves an approved row to NEEDS CORRECTION when no safe upsert occurred", () => {
    const commit = loadCommit({ matched: false, action: "noop" });
    const pending = fakePendingRow();
    const data = ["{}", "Customer", "IN1", "", "", "", "", "9/1/2026", "outbound", "APPROVED", ""];
    const result = commit(pending.sheet, 2, data, columns);
    expect(result).toEqual({ committed: false, matched: false, action: "needs-correction" });
    expect(pending.values.get("2:10")).toBe("NEEDS CORRECTION");
    expect(pending.values.get("2:11")).toContain("could not be uniquely matched");
  });

  it("marks an approved row COMMITTED only after a matched upsert", () => {
    const commit = loadCommit({ matched: true, action: "updated", row: 44 });
    const pending = fakePendingRow();
    const data = ["{}", "Customer", "IN1", "PRO1", "", "", "", "9/1/2026", "outbound", "APPROVED", ""];
    const result = commit(pending.sheet, 2, data, columns);
    expect(result.committed).toBe(true);
    expect(pending.values.get("2:10")).toBe("COMMITTED");
  });
});
