import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Control Tower light variants", () => {
<<<<<<< HEAD
  it("exposes every comparison route in the shared appearance switcher", () => {
    const source = read("app/style-switcher.tsx");
    expect(source).toContain('{ href: "/", label: "Original" }');
    expect(source).toContain('{ href: "/light-skin", label: "Light Skin" }');
    expect(source).toContain('{ href: "/light", label: "Light Control Tower" }');
    expect(source).toContain('{ href: "/light-full", label: "Light Full" }');
    expect(source).toContain('{ href: "/fulfillment-style", label: "Fulfillment" }');
=======
  it("exposes the StyleKorean/SKWarehouse/SKControl platform links in the shared header nav", () => {
    const source = read("app/style-switcher.tsx");
    expect(source).toContain('{ href: "https://stylekorean.dpdns.org", label: "StyleKorean", key: "stylekorean" }');
    expect(source).toContain('{ href: "https://skwarehouse.dpdns.org", label: "SKWarehouse", key: "skwarehouse" }');
    expect(source).toContain('{ href: "https://skwbp.dpdns.org", label: "SKControl", key: "skwbp" }');
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
  });

  it("keeps each light route presentation-only around the same Home implementation", () => {
    for (const path of ["app/light-skin/page.tsx", "app/light/page.tsx", "app/light-full/page.tsx"]) {
      const source = read(path);
      expect(source).toContain('import Home from "../page"');
      expect(source).toContain("<Home />");
      expect(source).not.toContain("fetch(");
    }
  });

  it("includes a Control Tower rail and source-inspired light design tokens", () => {
    const light = read("app/light/page.tsx");
    const css = read("app/style-variants.module.css");
    expect(light).toContain('aria-label="Control Tower sections"');
    expect(css).toContain(".lightSkin");
    expect(css).toContain(".lightFull");
    expect(css).toContain(".controlTowerShell");
    expect(css).toContain("#f6f9fc");
    expect(css).toContain("#138a55");
  });
});
