import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Control Tower light variants", () => {
  it("links out to the SKWarehouse and SKControl applications", () => {
    const source = read("app/app-links.tsx");
    expect(source).toContain('{ href: "https://skwarehouse.dpdns.org", label: "SKWarehouse" }');
    expect(source).toContain('{ href: "https://skwbp.dpdns.org", label: "SKControl" }');
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
