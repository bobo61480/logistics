import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("app/globals.css", "utf8");
const liveMap = readFileSync("app/live-map.tsx", "utf8");
const driveArchive = readFileSync("app/drive-archive-card.tsx", "utf8");
const gmailIngestion = readFileSync("app/gmail-ingestion-card.tsx", "utf8");

describe("PR-5 dark-theme reskin: no shared-class leaks", () => {
  it("scopes live-map heading/total overrides to .live-map-panel, since .inventory-heading/.inventory-total are shared with still-light inventory panels", () => {
    expect(css).toContain('[data-theme="dark"] .live-map-panel .inventory-heading h2');
    expect(css).toContain('[data-theme="dark"] .live-map-panel .inventory-total');
    expect(css).not.toMatch(/\[data-theme="dark"\]\s+\.inventory-heading\s*[,{]/);
    expect(css).not.toMatch(/\[data-theme="dark"\]\s+\.inventory-total\s*[,{]/);
  });

  it("gives the map's own content area a dark background override, not just the panel chrome", () => {
    expect(css).toContain('[data-theme="dark"] .live-map-container');
  });

  it("marks the Tailwind-styled cards with hct-card wrapper classes for scoped dark overrides", () => {
    expect(liveMap).toContain('className="inventory-panel live-map-panel"');
    expect(driveArchive).toContain("hct-card");
    expect(gmailIngestion).toContain("hct-card");
    expect(css).toContain('[data-theme="dark"] .hct-card');
  });
});
