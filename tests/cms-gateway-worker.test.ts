import { describe, expect, it, vi } from "vitest";
import bootstrapWorker from "../cms-gateway/bootstrap-worker";
import {
  buildAuthenticatedInvoiceRequest,
  fetchSessionInvoiceRows,
  isCmsSessionExpiredResponse,
  type CmsSessionClient,
} from "../cms-gateway/worker";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("session-backed CMS invoice transport", () => {
  it("builds the direct CMS request with browser-session authentication only", () => {
    const init = buildAuthenticatedInvoiceRequest("CMS_E=session-cookie");
    const headers = new Headers(init.headers);

    expect(headers.get("cookie")).toBe("CMS_E=session-cookie");
    expect(headers.get("x-requested-with")).toBe("XMLHttpRequest");
    expect(headers.get("accept")).toContain("application/json");
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("uses CMS_SESSION_COOKIE as a bootstrap session for direct invoice reads", async () => {
    const cookie = "CMS_E=bootstrap-cookie; CSMS=bootstrap-context";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        err: 0,
        rows: 1,
        data: [{ invc_no: "INV-BOOT", invc_dt: "2026-08-15", invc_atot: 125, biz_curr: "USD" }],
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const response = await bootstrapWorker.fetch(
        new Request("https://gateway.example/sales-summary?month=2026-08"),
        {
          CMS_UPSTREAM_MCP_URL: "https://cms.mcp.siliconii.com/mcp/",
          CMS_SESSION_COOKIE: cookie,
        },
      );
      const body = await response.json() as { ok?: boolean; rows?: Array<{ totalSales?: number }> };

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.rows?.[0]?.totalSales).toBe(125);
      expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("cookie")).toBe(cookie);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("classifies redirects and login HTML as an expired CMS session", async () => {
    expect(
      await isCmsSessionExpiredResponse(
        new Response(null, { status: 302, headers: { location: "https://auth.siliconii.com/" } }),
      ),
    ).toBe(true);
    expect(
      await isCmsSessionExpiredResponse(
        new Response("<html><form action='/Logon/CheckLogin'>login</form></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    ).toBe(true);
    expect(await isCmsSessionExpiredResponse(jsonResponse({ err: 0, data: [] }))).toBe(false);
  });

  it("invalidates, renews, and retries exactly once after session expiry", async () => {
    const sessionClient: CmsSessionClient = {
      getSession: vi.fn().mockResolvedValue({ cookieHeader: "CMS_E=old" }),
      invalidate: vi.fn().mockResolvedValue(undefined),
      renew: vi.fn().mockResolvedValue({ cookieHeader: "CMS_E=new" }),
      health: vi.fn(),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          err: 0,
          rows: 1,
          data: [{ invc_no: "INV-1", invc_dt: "2026-08-15", invc_atot: 100, biz_curr: "USD" }],
        }),
      );

    const rows = await fetchSessionInvoiceRows("2026-08", sessionClient, fetchImpl);

    expect(rows).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sessionClient.invalidate).toHaveBeenCalledTimes(1);
    expect(sessionClient.renew).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("cookie")).toBe("CMS_E=old");
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("cookie")).toBe("CMS_E=new");
  });

  it("stops after the single retry if the renewed session also fails", async () => {
    const sessionClient: CmsSessionClient = {
      getSession: vi.fn().mockResolvedValue({ cookieHeader: "CMS_E=old" }),
      invalidate: vi.fn().mockResolvedValue(undefined),
      renew: vi.fn().mockResolvedValue({ cookieHeader: "CMS_E=new" }),
      health: vi.fn(),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );

    await expect(fetchSessionInvoiceRows("2026-08", sessionClient, fetchImpl)).rejects.toThrow(
      "CMS_AUTH_SESSION_INVALID",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sessionClient.invalidate).toHaveBeenCalledTimes(1);
    expect(sessionClient.renew).toHaveBeenCalledTimes(1);
  });
});