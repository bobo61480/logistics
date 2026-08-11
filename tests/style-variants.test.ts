import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("live dashboard style variants", () => {
  test.each([
    ["app/light/page.tsx", "styles.light"],
    ["app/fulfillment-style/page.tsx", "styles.fulfillment"],
  ])("%s reuses the canonical live dashboard", (file, themeClass) => {
    expect(fs.existsSync(path.join(root, file))).toBe(true);
    const source = read(file);
    expect(source).toContain('import Home from "../page"');
    expect(source).toContain('import styles from "../style-variants.module.css"');
    expect(source).toContain(themeClass);
    expect(source).toContain("<Home />");
    expect(source).toContain('href="/"');
    expect(source).toContain('href="/light"');
    expect(source).toContain('href="/fulfillment-style"');
  });

  test("variant CSS places TK after the outbound trucking board", () => {
    const css = read("app/style-variants.module.css");
    expect(css).toContain("display: contents");
    expect(css).toContain(":global(.outbound-panel)");
    expect(css).toContain(":global(.fulfillment-tk-panel)");
    expect(css).toContain(":global(.outbound-parcel-panel)");
    expect(css).toMatch(/outbound-panel\)[^{]*\{[^}]*order:\s*12/s);
    expect(css).toMatch(/fulfillment-tk-panel\)[^{]*\{[^}]*order:\s*13/s);
    expect(css).toMatch(/outbound-parcel-panel\)[^{]*\{[^}]*order:\s*14/s);
  });

  test("fulfillment money fields render as USD with a dollar sign", () => {
    const source = read("app/fulfillment-tk-panel.tsx");
    expect(source).toContain("function formatFulfillmentValue");
    expect(source).toContain('style: "currency"');
    expect(source).toContain('currency: "USD"');
  });

  test("both approved visual themes are present", () => {
    const css = read("app/style-variants.module.css");
    expect(css).toContain("--variant-mint");
    expect(css).toContain("--lookup-green");
    expect(css).toContain("#e9f8ef");
    expect(css).toContain("#138a55");
  });
});
