import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const card = readFileSync("app/ingestion-roadmap-card.tsx", "utf8");
const page = readFileSync("app/page.tsx", "utf8");

describe("Gmail Shipping-Doc Ingestion roadmap placeholder", () => {
  it("makes no network calls or API references — purely static UI", () => {
    expect(card).not.toMatch(/fetch\(|axios|XMLHttpRequest/);
    expect(card).not.toContain("useState");
    expect(card).not.toContain("useEffect");
  });

  it("labels itself clearly as a proposed, not-yet-built feature", () => {
    expect(card).toContain("Roadmap · Design Placeholder");
    expect(card).toContain("Not built yet");
    expect(card).toContain("Not connected");
    expect(card).toContain("no Gmail connection, parser, or classifier behind this");
  });

  it("distinguishes itself from the real, already-built Shipment Notices feed", () => {
    expect(card).toMatch(/separate from the real[\s\S]*Shipment Notices/);
  });

  it("mounts alongside, not instead of, the real GmailIngestionCard", () => {
    expect(page).toContain("<GmailIngestionCard");
    expect(page).toContain("<IngestionRoadmapCard />");
  });
});
