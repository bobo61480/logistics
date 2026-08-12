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
    expect(worker).toContain("env.ASSETS.fetch(request)");
    expect(wrangler).toContain('main = "worker/index.ts"');
    expect(wrangler).toContain('binding = "ASSETS"');
    expect(wrangler).toContain('run_worker_first = ["/api/*"]');
  });

  it("keeps the WMS source read-only and proxies writes only to the approved Apps Script endpoint", () => {
    const sources = read("worker/sources.ts");
    const status = read("worker/status-command.ts");

    expect(sources).toContain("14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I");
    expect(sources).not.toMatch(/fetch\([^\n]+method:\s*["']POST/i);
    expect(status).toContain("AKfycbz770kmpwqMTA-h-lzeLARgVnDh_VDjh-70OOKk_yE-iXJTmzAsVXUtln17QTOURO1R");
  });
});
