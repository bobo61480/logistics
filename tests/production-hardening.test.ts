import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("production hardening", () => {
  it("verifies all appearance routes and live Worker APIs after Cloudflare deploy", () => {
    const workflow = read(".github/workflows/deploy-cloudflare.yml");
    expect(workflow).toContain("npm ci");
    for (const route of ["/light-skin", "/light", "/light-full", "/fulfillment-style"]) {
      expect(workflow).toContain(route);
    }
    expect(workflow).toContain("/api/logistics/health");
    expect(workflow).toContain("/api/logistics/snapshot");
    expect(workflow).toContain("/api/logistics/reconciliation");
    expect(workflow).toContain('"ok":true');
    expect(workflow).toContain("sourceHealth");
    expect(workflow).toContain("worker-v6-d1-active");
    expect(workflow).toContain("d1 migrations apply");
    expect(workflow).toContain('binding = "DB"');
    expect(workflow).toContain('snapshot.storage!=="d1"');
    expect(workflow).toContain("x-content-type-options: nosniff");
  });

  it("ships a reusable production smoke verifier", () => {
    const script = read("scripts/verify-production.mjs");
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["verify:production"]).toBe("node scripts/verify-production.mjs");
    expect(script).toContain("/api/logistics/health");
    expect(script).toContain("/api/logistics/snapshot");
    expect(script).toContain("/light-skin");
    expect(script).toContain("/light-full");
    expect(script).toContain("x-frame-options");
  });

  it("keeps Cloudflare as the only site deployment path", () => {
    expect(existsSync(".github/workflows/deploy-planner.yml")).toBe(false);
    expect(existsSync(".github/workflows/build-style-variants.yml")).toBe(false);
    expect(existsSync("public/CNAME")).toBe(false);
  });
});
