import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("production hardening", () => {
  it("verifies all appearance routes and the D1-only frontend after Cloudflare deploy", () => {
    const workflow = read(".github/workflows/deploy-cloudflare.yml");
    expect(workflow).toContain("npm ci");
    for (const route of ["/light-skin", "/light", "/light-full", "/fulfillment-style"]) {
      expect(workflow).toContain(route);
    }
    expect(workflow).toContain("StyleKorean application marker missing");
    expect(workflow).toContain("/api/logistics/health");
    expect(workflow).toContain("/api/logistics/snapshot");
    expect(workflow).toContain("/api/logistics/reconciliation");
    expect(workflow).toContain("2026-08-29-worker-v9-d1-canonical-dedupe");
    expect(workflow).toContain('health.frontendSource!=="d1"');
    expect(workflow).toContain('snapshot.storage!=="d1"');
    expect(workflow).toContain('snapshot.frontendSource!=="d1"');
    expect(workflow).toContain("d1 migrations apply");
    expect(workflow).toContain("wrangler deploy --keep-vars");
    expect(workflow).toContain("wrangler versions upload");
    expect(workflow).toContain("wrangler versions deploy");
    expect(workflow).toContain("Authentication error [code: 10000]");
    expect(workflow).toContain("A version-only deployment cannot recover a detached zone route");
    expect(workflow).toContain("Production route recovery failed");
    expect(workflow).toContain("gh issue create");
    expect(workflow).toContain('EXPECTED_DATABASE_CONFIGURED: "true"');
    expect(workflow).toContain("Number(health.databaseAgeSeconds)>30*60");
    expect(workflow).toContain("snapshot.stale===true");
    expect(workflow).toContain("x-content-type-options: nosniff");

    const wranglerConfig = read("wrangler.toml");
    expect(wranglerConfig).toContain("[[d1_databases]]");
    expect(wranglerConfig).toContain('binding = "DB"');
    expect(wranglerConfig).toContain('database_name = "stylekorean-logistics-read-model"');
    expect(wranglerConfig).toContain('migrations_dir = "./migrations"');
    expect(wranglerConfig).toContain("[triggers]");
    expect(wranglerConfig).toContain('crons = ["*/15 * * * *"]');

    const worker = read("worker/index.ts");
    expect(worker).toContain('const WORKER_VERSION = "2026-08-29-worker-v9-d1-canonical-dedupe"');
    expect(worker).toContain('frontendSource: "d1"');
    expect(worker).toContain('statusWriteMode: "strict Google Sheets + D1 dual write"');
    expect(worker).toContain('return json({ ok: false, error: "D1 frontend database is not configured"');
    expect(worker).toContain("const refreshed = await refreshDatabaseSnapshot(env)");
    expect(worker).toContain("fetchOperationalSources(env.APPS_SCRIPT_WRITE_URL)");
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
    expect(script).toContain("REQUIRE_D1");
    expect(script).toContain('snapshot.storage !== "sheets"');
  });

  it("keeps Cloudflare as the only site deployment path", () => {
    expect(existsSync(".github/workflows/deploy-planner.yml")).toBe(false);
    expect(existsSync(".github/workflows/build-style-variants.yml")).toBe(false);
    expect(existsSync("public/CNAME")).toBe(false);
  });

  it("publishes the first D1 snapshot before reporting database storage", () => {
    const worker = read("worker/index.ts");
    expect(worker).toContain("const initial = await refreshDatabaseSnapshot(env)");
    expect(worker).toContain('storage: "d1"');
    expect(worker).toContain('"D1-INITIALIZED"');
    expect(worker).not.toContain('storage: "sheets"');
  });
});
