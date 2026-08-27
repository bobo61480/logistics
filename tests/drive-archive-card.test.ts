import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const card = readFileSync("app/drive-archive-card.tsx", "utf8");

describe("Document Folders", () => {
  it("omits the legacy email archive and uses category-specific icons", () => {
    expect(card).not.toContain("SK Logistics Email Archive");
    expect(card).toContain('pattern: /^shipping documents$/i, emoji: "📑"');
    expect(card).toContain('pattern: /^bill of ladings$/i, emoji: "🚢"');
    expect(card).toContain('pattern: /^pod$/i, emoji: "✅"');
    expect(card).toContain('pattern: /^entry summaries$/i, emoji: "🛃"');
    expect(card).toContain('pattern: /^supplies purchase$/i, emoji: "🛒"');
  });
});
