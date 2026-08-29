import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("control tower Worker routing", () => {
  it("routes logistics APIs through a Worker and static pages through ASSETS", () => {
    const worker = read("worker/index.ts");
    const wrangler = read("wrangler.toml");

    expect(worker).toContain('url.pathname === "/api/logistics/snapshot"');
    expect(worker).toContain('url.pathname === "/api/logistics/status"');
    expect(worker).toContain('url.pathname === "/api/logistics/health"');
    expect(worker).toContain('url.pathname === "/api/logistics/reconciliation"');
    expect(worker).toContain("env.ASSETS.fetch(request)");
    expect(wrangler).toContain('main = "worker/index.ts"');
    expect(wrangler).toContain('binding = "ASSETS"');
    expect(wrangler).toContain('run_worker_first = ["/api/*"]');
    expect(wrangler).toContain('pattern = "stylekorean.dpdns.org/*"');
    expect(wrangler).toContain('zone_id = "5d128576939145a0274370efd693dafe"');
    expect(wrangler).not.toContain("custom_domain = true");
    expect(wrangler).toContain("workers_dev = false");
  });

  it("makes Google Sheets plus D1 a strict dual-write path", () => {
    const sources = read("worker/sources.ts");
    const status = read("worker/status-command.ts");
    const wrangler = read("wrangler.toml");

    expect(sources).toContain("14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I");
    expect(sources).not.toMatch(/fetch\([^\n]+method:\s*["']POST/i);
    expect(status).toContain("EDITABLE_SHEETS");
    expect(status).toContain("Cross-origin status writes are not allowed");
    expect(status).toContain("Cross-site status writes are not allowed");
    expect(status).toContain("Content-Type must be application/json");
    expect(status).toContain("MAX_COMMAND_BYTES");
    expect(status).toContain("STATUS_WRITE_RATE_LIMITER.limit");
    expect(status).toContain("Status write rate limit exceeded");
    expect(status).toContain('"retry-after": "60"');
    expect(status).toContain("applyConfirmedStatusToSnapshot");
    expect(status).toContain("rolled back to keep both stores consistent");
    expect(status).toContain('event: "status-dual-write-confirmed"');
    expect(status).toContain('frontendSource: "d1"');
    expect(status).not.toContain("AKfycbz770kmpwqMTA-h-lzeLARgVnDh_VDjh-70OOKk_yE-iXJTmzAsVXUtln17QTOURO1R");
    expect(wrangler).toContain("AKfycbz770kmpwqMTA-h-lzeLARgVnDh_VDjh-70OOKk_yE-iXJTmzAsVXUtln17QTOURO1R");
    expect(wrangler).toContain('name = "STATUS_WRITE_RATE_LIMITER"');
  });

  it("uses D1 as the exclusive frontend source", () => {
    const worker = read("worker/index.ts");
    expect(worker).toContain('frontendSource: "d1"');
    expect(worker).toContain('dataStore: "Cloudflare D1"');
    expect(worker).toContain('googleSheetsRole: "synchronized operational source"');
    expect(worker).toContain('deduplication: "enabled-before-d1-publish"');
    expect(worker).not.toContain('storage: "sheets"');
  });

  it("keeps the last good D1 snapshot visible during a short source outage", () => {
    const worker = read("worker/index.ts");
    expect(worker).toContain("SNAPSHOT_REFRESH_SECONDS");
    expect(worker).toContain('x-stylekorean-cache", "D1-STALE"');
    expect(worker).toContain("Response is stale");
    expect(worker).toContain("staleReason");
  });

  it("adds baseline security headers to APIs and static assets", () => {
    const worker = read("worker/index.ts");
    expect(worker).toContain("content-security-policy");
    expect(worker).toContain("strict-transport-security");
    expect(worker).toContain("x-content-type-options");
    expect(worker).toContain("x-frame-options");
  });

  it("only merges same-customer, same-date trucking presentation rows, while writes stay pinned to real source rows", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("function consolidateTruckingItems");
    expect(page).toContain("The status dropdown and \"source row\" link act on primary's row");
    expect(page).toContain('editable: statusSource === primary ? primary.editable : false');
  });
});
