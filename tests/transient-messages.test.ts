import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("temporary warnings and errors", () => {
  it("fades dashboard action messages and removes them after three seconds", () => {
    const page = readFileSync("app/page.tsx", "utf8");
    const css = readFileSync("app/globals.css", "utf8");

    expect(page).toContain("setNoticeFading(true), 2400");
    expect(page).toContain('setNotice(""), 3000');
    expect(page).toContain('noticeFading ? " fade-out"');
    expect(css).toContain(".toast.fade-out");
  });

  it("replaces blocking fulfillment alerts with a three-second inline error", () => {
    const fulfillment = readFileSync("app/FulfillmentTkOrders.tsx", "utf8");

    expect(fulfillment).not.toContain("window.alert(");
    expect(fulfillment).toContain('setError(`Save failed:');
    expect(fulfillment).toContain('window.setTimeout(() => setError(""), 3000)');
    expect(fulfillment).toContain("transient-error-fade");
  });
});
