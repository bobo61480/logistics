import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker from "../cms-gateway/worker";

describe("CMS gateway unattended auth deployment", () => {
  it("provisions all unattended-auth secrets through GitHub Actions without command-line values", () => {
    const workflow = readFileSync(".github/workflows/deploy-cms-gateway.yml", "utf8");

    for (const name of ["CMS_AUTH_USER", "CMS_AUTH_PASSWORD", "CMS_TOTP_SECRET"]) {
      expect(workflow).toContain(`${name}: \${{ secrets.${name} }}`);
      expect(workflow).toContain(`printf '%s' "$${name}" | npx wrangler secret put ${name}`);
      expect(workflow).not.toMatch(new RegExp(`wrangler secret put ${name}[^\\n]*--value`, "i"));
    }
  });

  it("returns only safe unattended-session metadata from health", async () => {
    const response = await worker.fetch(
      new Request("https://gateway.example/health"),
      {
        CMS_UPSTREAM_MCP_URL: "https://cms.mcp.siliconii.com/mcp/",
      },
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      unattendedAuthConfigured: false,
      cmsSessionState: "missing",
      cmsSessionCreatedAt: null,
      cmsSessionExpiresAt: null,
      cmsSessionLastValidatedAt: null,
    });

    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of [
      "cookieheader",
      "password",
      "totpsecret",
      "totpcode",
      "pending_token",
      "guid",
      "cms_auth_user",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
