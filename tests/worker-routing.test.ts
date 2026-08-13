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
    expect(wrangler).toContain('pattern = "stylekorean.dpdns.org"');
    expect(wrangler).toContain("custom_domain = true");
    expect(wrangler).toContain("workers_dev = false");
  });

  it("keeps the WMS source read-only and proxies writes only to the approved Apps Script endpoint", () => {
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
    expect(status).not.toContain("AKfycbz770kmpwqMTA-h-lzeLARgVnDh_VDjh-70OOKk_yE-iXJTmzAsVXUtln17QTOURO1R");
    expect(wrangler).toContain("AKfycbz770kmpwqMTA-h-lzeLARgVnDh_VDjh-70OOKk_yE-iXJTmzAsVXUtln17QTOURO1R");
  });

  it("keeps the last good snapshot available during a short source outage", () => {
    const worker = read("worker/index.ts");
    expect(worker).toContain("SNAPSHOT_REFRESH_SECONDS");
    expect(worker).toContain('x-stylekorean-cache", "STALE"');
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

  it("does not merge distinct trucking source rows in the browser", () => {
    const page = read("app/page.tsx");

    expect(page).not.toContain("consolidateTruckingItems");
    expect(page).not.toContain('invoices.join("\\n")');
    expect(page).toContain("Each source row remains its own operational move");
  });
});
