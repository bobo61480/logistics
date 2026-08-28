import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const card = readFileSync("app/ingestion-roadmap-card.tsx", "utf8");
const noticesCard = readFileSync("app/gmail-ingestion-card.tsx", "utf8");
const page = readFileSync("app/page.tsx", "utf8");

describe("Gmail Shipping-Doc Ingestion production explanation", () => {
  it("uses the shared snapshot and makes no additional network calls", () => {
    expect(card).not.toMatch(/fetch\(|axios|XMLHttpRequest/);
    expect(card).not.toContain("useState");
    expect(card).not.toContain("useEffect");
  });

  it("labels itself clearly as a connected production automation", () => {
    expect(card).toContain("Production automation · 15-minute polling");
    expect(card).toContain('className="status-tag">Connected');
    expect(card).toContain("Recently Received Documents");
    expect(card).not.toContain("Not built yet");
    expect(card).not.toContain("Not connected");
  });

  it("reports received documents, time, and exact Drive destination", () => {
    expect(card).toContain("Recently Received Documents");
    expect(card).toContain("Documents received");
    expect(card).toContain("Received");
    expect(card).toContain("Uploaded to");
    expect(card).toContain("event.documentNames");
    expect(card).toContain("event.archiveFolderPath");
    expect(card.toLowerCase()).not.toContain("placeholder");
  });

  it("mounts alongside, not instead of, the real GmailIngestionCard", () => {
    expect(page).toContain("<GmailIngestionCard");
    expect(page).toContain("<IngestionRoadmapCard events={gmailIngestion} />");
  });

  it("shows sender, shipment, and main point for every notice", () => {
    expect(noticesCard).toContain("Sender");
    expect(noticesCard).toContain("Shipment");
    expect(noticesCard).toContain("Main point");
  });

  it("wires Approve/Reject review controls into the card, not just the handler", () => {
    // Regression for a Codex review finding: page.tsx defined
    // handleReview/postPendingReview but never passed them to
    // GmailIngestionCard, and the card itself rendered no review controls
    // at all — the whole approval workflow was unreachable from the
    // dashboard.
    expect(page).toMatch(/<GmailIngestionCard[\s\S]*?onReview=\{handleReview\}/);
    expect(page).toMatch(/<GmailIngestionCard[\s\S]*?reviewingKey=\{reviewingKey\}/);
    expect(noticesCard).toContain("onReview?: (event: GmailIngestionEvent, decision:");
    expect(noticesCard).toContain('onReview && event.status === "needsReview"');
    expect(noticesCard).toContain("No unique identifier");
    expect(noticesCard).toContain("event.issues");
  });
});
