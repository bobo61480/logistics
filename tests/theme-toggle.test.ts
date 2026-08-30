import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("dark-theme toggle infrastructure", () => {
  it("persists and applies the theme via a single storage key", () => {
    const theme = read("app/theme.ts");
    expect(theme).toContain('export const THEME_STORAGE_KEY = "sk-theme"');
    expect(theme).toContain('document.documentElement.setAttribute("data-theme", "dark")');
    expect(theme).toContain('document.documentElement.removeAttribute("data-theme")');
    expect(theme).toContain("window.localStorage.setItem(THEME_STORAGE_KEY, theme)");
  });

  it("exports an anti-flash boot script that reads the same storage key before paint", () => {
    const theme = read("app/theme.ts");
    expect(theme).toContain("export const THEME_BOOT_SCRIPT");
    expect(theme).toContain("window.localStorage.getItem");
    expect(theme).toMatch(/setAttribute\(("|')data-theme\1,\s*("|')dark\2\)/);
  });

  it("wires the boot script into layout.tsx's <head>, before body content renders", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toContain('import { THEME_BOOT_SCRIPT } from "./theme"');
    expect(layout).toContain("<head>");
    expect(layout).toContain("dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}");
  });

  it("mounts the theme toggle control in the masthead", () => {
    const page = read("app/page.tsx");
    expect(page).toContain('import { ThemeToggle } from "./theme-toggle"');
    expect(page).toContain("<ThemeToggle />");
  });

  it("defines a light default and a dark override for every core semantic token", () => {
    const css = read("app/globals.css");
    const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/);
    const darkMatch = css.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
    expect(rootMatch).not.toBeNull();
    expect(darkMatch).not.toBeNull();

    const tokens = [
      "--surface",
      "--surface-2",
      "--surface-inset",
      "--text",
      "--text-soft",
      "--text-faint",
      "--hairline",
      "--accent-imports",
      "--accent-transfers",
      "--accent-outbound",
      "--status-good",
      "--status-warning",
      "--status-serious",
      "--status-critical",
    ];
    for (const token of tokens) {
      expect(rootMatch![1]).toContain(`${token}:`);
      expect(darkMatch![1]).toContain(`${token}:`);
    }
  });

  it("does not redeclare conflicting custom properties across root blocks", () => {
    const css = read("app/globals.css");
    const rootBodies = [...css.matchAll(/^:root\s*\{([\s\S]*?)^\}/gm)].map((match) => match[1]);
    expect(rootBodies.length).toBeGreaterThan(0);

    const declarations = rootBodies.flatMap((body) =>
      [...body.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]),
    );
    const duplicates = declarations.filter((name, index) => declarations.indexOf(name) !== index);
    expect([...new Set(duplicates)]).toEqual([]);
  });
});
