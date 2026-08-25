import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("app/page.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");

describe("calendar-strip schedule redesign", () => {
  it("day-groups SmallParcelSchedule the same way ScheduleBoard already does", () => {
    expect(page).toContain("function ParcelCard({");
    expect(page).toContain("days.map((day, index) => {");
    expect(page).toContain('dayKey(item.date) === dayKey(day)');
    // Both parent call sites must pass the shared 14-day `days` array.
    const parcelCallSites = page.match(/<SmallParcelSchedule[\s\S]*?\/>/g) ?? [];
    expect(parcelCallSites).toHaveLength(2);
    for (const callSite of parcelCallSites) {
      expect(callSite).toContain("days={days}");
    }
  });

  it("does not leak dark-theme overrides from the schedule/parcel panels onto the shared .panel-heading class other panels use", () => {
    // .panel-heading is reused by untouched panels (inventory, low stock) —
    // a bare `[data-theme="dark"] .panel-heading` selector would wash out
    // their still-light headings. Only the scoped form is allowed.
    expect(css).not.toMatch(/\[data-theme="dark"\]\s+\.panel-heading\s*[,{]/);
    expect(css).toContain('[data-theme="dark"] .schedule-panel .panel-heading');
  });
});
