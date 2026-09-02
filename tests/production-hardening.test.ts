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
    expect(workflow).toContain("/api/logistics/monthly-kpis?month=");
    expect(workflow).toContain('"wms-sheet-fallback"');
    expect(workflow).toContain("2026-09-02-worker-v12-sse-d1-fastpath");
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
    expect(wranglerConfig).toContain('pattern = "stylekorean.dpdns.org"');
    expect(wranglerConfig).toContain("custom_domain = true");
    expect(wranglerConfig).not.toContain('pattern = "stylekorean.dpdns.org/*"');
    expect(wranglerConfig).not.toContain('zone_id = "5d128576939145a0274370efd693dafe"');
    expect(wranglerConfig).toContain("[assets]");
    expect(wranglerConfig).toContain('directory = "./out"');
    expect(wranglerConfig).toContain('binding = "ASSETS"');
    expect(wranglerConfig).toContain('run_worker_first = ["/api/*"]');
    expect(wranglerConfig).toContain("[[d1_databases]]");
    expect(wranglerConfig).toContain('binding = "DB"');
    expect(wranglerConfig).toContain('database_name = "stylekorean-logistics-read-model"');
    expect(wranglerConfig).toContain('migrations_dir = "./migrations"');
    expect(wranglerConfig).toContain("[triggers]");
    expect(wranglerConfig).toContain('crons = ["*/15 * * * *"]');

    const worker = read("worker/index.ts");
    expect(worker).toContain('const WORKER_VERSION = "2026-09-02-worker-v12-sse-d1-fastpath"');
    expect(worker).toContain('frontendSource: "d1"');
    expect(worker).toContain('statusWriteMode: "strict Google Sheets + D1 dual write"');
    expect(worker).toContain('return json({ ok: false, error: "D1 frontend database is not configured"');
    expect(worker).toContain("const refreshed = await refreshDatabaseSnapshot(env)");
    expect(worker).toContain("fetchOperationalSources(env.APPS_SCRIPT_WRITE_URL)");
    expect(worker).toContain("env.ASSETS.fetch(request)");
  });

  it("ships a reusable D1-only production smoke verifier", () => {
    const script = read("scripts/verify-production.mjs");
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["verify:production"]).toBe("node scripts/verify-production.mjs");
    expect(script).toContain("/api/logistics/health");
    expect(script).toContain("/api/logistics/snapshot");
    expect(script).toContain("/light-skin");
    expect(script).toContain("/light-full");
    expect(script).toContain("x-frame-options");
    expect(script).toContain("REQUIRE_D1");
    expect(script).toContain('snapshot.storage !== "d1"');
    expect(script).toContain('snapshot.frontendSource !== "d1"');
  });

  it("keeps live CMS KPI checks in an explicit verification command", () => {
    const script = read("scripts/verify-live-cms-kpis.mjs");
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["verify:live-cms-kpis"]).toBe("node scripts/verify-live-cms-kpis.mjs");
    expect(script).toContain("PRODUCTION_BASE_URL");
    expect(script).toContain("CMS_GATEWAY_BASE_URL");
    expect(script).toContain('replace(/\\/$/, "")');
    expect(script).toContain('cache: "no-store"');
    expect(script).toContain("AbortController");
    expect(script).toContain("invalid JSON");
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
