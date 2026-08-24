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
    expect(status).toContain("STATUS_WRITE_RATE_LIMITER.limit");
    expect(status).toContain("Status write rate limit exceeded");
    expect(status).toContain('"retry-after": "60"');
    expect(status).toContain('event: "status-write-confirmed"');
    expect(status).not.toContain("AKfycbz770kmpwqMTA-h-lzeLARgVnDh_VDjh-70OOKk_yE-iXJTmzAsVXUtln17QTOURO1R");
    expect(wrangler).toContain("AKfycbz770kmpwqMTA-h-lzeLARgVnDh_VDjh-70OOKk_yE-iXJTmzAsVXUtln17QTOURO1R");
    expect(wrangler).toContain('name = "STATUS_WRITE_RATE_LIMITER"');
    expect(wrangler).toContain("limit = 30");
    expect(wrangler).toContain("period = 60");
  });

  it("reports the intentionally public access policy without presenting safeguards as authentication", () => {
    const worker = read("worker/index.ts");

    expect(worker).toContain('accessPolicy: "public"');
    expect(worker).toContain('statusWriteAuthentication: "none"');
    expect(worker).toContain('statusWriteRateLimit: "30 requests per 60 seconds per client IP and Cloudflare location"');
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

  it("only merges same-customer, same-date trucking rows, and keeps status writes pinned to their real source row", () => {
    // A 2026-08-12 incident removed customer+date trucking consolidation because it could
    // hide distinct operational moves. Control Tower reintroduced it deliberately (2026-08-23)
    // to roll same-shipment invoices into one card, but only for trucking rows, and status
    // edits still resolve to whichever constituent row actually supplied the displayed status
    // — never blindly to the first row in the group — so a merged card can't silently write
    // to the wrong shipment.
    const page = read("app/page.tsx");

    expect(page).toContain("function consolidateTruckingItems");
    expect(page).toContain(
      "The status dropdown and \"source row\" link act on primary's row",
    );
    expect(page).toContain('editable: statusSource === primary ? primary.editable : false');
  });
});
