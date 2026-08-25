import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const card = readFileSync("app/ingestion-roadmap-card.tsx", "utf8");
const page = readFileSync("app/page.tsx", "utf8");

describe("Gmail Shipping-Doc Ingestion production explanation", () => {
  it("makes no network calls or API references — purely static UI", () => {
    expect(card).not.toMatch(/fetch\(|axios|XMLHttpRequest/);
    expect(card).not.toContain("useState");
    expect(card).not.toContain("useEffect");
  });

  it("labels itself clearly as a connected production automation", () => {
    expect(card).toContain("Production automation · 15-minute polling");
    expect(card).toContain('className="status-tag">Connected');
    expect(card).toContain("The production pipeline uses Apps Script");
    expect(card).not.toContain("Not built yet");
    expect(card).not.toContain("Not connected");
  });

  it("explains that Shipment Notices reports the same pipeline without making a duplicate request", () => {
    expect(card).toMatch(/Shipment Notices[\s\S]*same Worker snapshot/);
    expect(card).toContain("without launching a second ingestion pipeline");
  });

  it("mounts alongside, not instead of, the real GmailIngestionCard", () => {
    expect(page).toContain("<GmailIngestionCard");
    expect(page).toContain("<IngestionRoadmapCard />");
  });
});
