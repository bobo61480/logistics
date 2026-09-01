import { describe, expect, it, vi } from "vitest";
import {
  createCmsSession,
  generateTotp,
  mergeCookies,
  parseSetCookieHeaders,
  sessionExpiresAt,
} from "../cms-gateway/auth";

const TEST_ENV = {
  CMS_AUTH_USER: "fixture-user",
  CMS_AUTH_PASSWORD: "fixture-password",
  CMS_TOTP_SECRET: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
};

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers).entries()) },
  });
}

function sessionTransResponse(location: string) {
  const headers = new Headers({ location });
  headers.append(
    "set-cookie",
    "CMS_E=auth-a; Path=/; Domain=.siliconii.com; Expires=Wed, 02 Sep 2026 06:16:02 GMT; HttpOnly",
  );
  headers.append("set-cookie", "ASP.NET_SessionId=session-a; Path=/; Domain=cms.siliconii.com; HttpOnly");
  return new Response(null, { status: 302, headers });
}

describe("Siliconii auth primitives", () => {
  it("generates deterministic six-digit RFC 6238 codes", async () => {
    expect(await generateTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toBe("287082");
    expect(await generateTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1_111_111_109_000)).toBe("081804");
  });

  it("rejects malformed Base32 without echoing the secret", async () => {
    const secret = "bad*seed";
    await expect(generateTotp(secret, 59_000)).rejects.toThrow("CMS_AUTH_TOTP_SECRET_INVALID");
    try {
      await generateTotp(secret, 59_000);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("parses multiple Set-Cookie values without splitting an Expires comma", () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "CMS_E=abc123; Path=/; Domain=.siliconii.com; Expires=Wed, 02 Sep 2026 06:16:02 GMT; HttpOnly",
    );
    headers.append("set-cookie", "CSMS_U=def456; Path=/; Domain=cms.siliconii.com; HttpOnly");

    const parsed = parseSetCookieHeaders(headers);
    expect(parsed.map((cookie) => cookie.name)).toEqual(["CMS_E", "CSMS_U"]);
    expect(parsed[0]?.expiresAt).toBe("2026-09-02T06:16:02.000Z");
    expect(parsed[1]?.expiresAt).toBeNull();
  });

  it("merges cookies by name so newer values replace older ones", () => {
    const merged = mergeCookies(
      new Map([
        ["appKey", "guid-1"],
        ["CMS_E", "old"],
      ]),
      [
        { name: "CMS_E", value: "new" },
        { name: "CSMS", value: "ctx" },
      ],
    );

    expect([...merged.entries()]).toEqual([
      ["appKey", "guid-1"],
      ["CMS_E", "new"],
      ["CSMS", "ctx"],
    ]);
  });

  it("uses the earliest persistent CMS cookie expiry", () => {
    expect(
      sessionExpiresAt([
        { name: "ASP.NET_SessionId", value: "session", expiresAt: null },
        { name: "CMS_E", value: "a", expiresAt: "2026-09-02T06:16:02.000Z" },
        { name: "CSMS_U", value: "b", expiresAt: "2026-09-02T06:18:02.000Z" },
      ]),
    ).toBe("2026-09-02T06:16:02.000Z");
  });
});

describe("Siliconii unattended login exchange", () => {
  it("turns the VerifyTotp guid into appKey and captures CMS cookies across redirects", async () => {
    const redirectHeaders = new Headers();
    redirectHeaders.append("set-cookie", "CSMS_U=auth-b; Path=/; Domain=cms.siliconii.com; HttpOnly");
    redirectHeaders.append("set-cookie", "CSMS=context; Path=/; Domain=cms.siliconii.com");

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ result: "F_TOTP_VERIFY", pending_token: "pending-1", totp_step: "V1" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          result: "S",
          guid: "guid-123",
          data: [{ col_1: "CSMS", col_2: "https://cms.siliconii.com//Sys/SessionTrans" }],
        }),
      )
      .mockResolvedValueOnce(sessionTransResponse("/Sales/InvcList"))
      .mockResolvedValueOnce(new Response("<html>cms</html>", { status: 200, headers: redirectHeaders }))
      .mockResolvedValueOnce(jsonResponse({ err: 0, rows: 0, data: [], onRowCount: 0 }));

    const session = await createCmsSession(TEST_ENV, { fetchImpl, nowMs: 59_000 });

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const handoffInit = fetchImpl.mock.calls[2]?.[1];
    expect(new Headers(handoffInit?.headers).get("cookie")).toBe("appKey=guid-123");
    expect(session.cookieHeader).toContain("appKey=guid-123");
    expect(session.cookieHeader).toContain("CMS_E=auth-a");
    expect(session.cookieHeader).toContain("ASP.NET_SessionId=session-a");
    expect(session.cookieHeader).toContain("CSMS_U=auth-b");
    expect(session.cookieHeader).toContain("CSMS=context");
    expect(session.expiresAt).toBe("2026-09-02T06:16:02.000Z");

    const validationInit = fetchImpl.mock.calls[4]?.[1];
    expect(new Headers(validationInit?.headers).get("x-requested-with")).toBe("XMLHttpRequest");
    expect(new Headers(validationInit?.headers).get("cookie")).toContain("CMS_E=auth-a");
  });

  it("rejects a SessionTrans redirect that leaves cms.siliconii.com", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ result: "F_TOTP_VERIFY", pending_token: "pending-1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          result: "S",
          guid: "guid-123",
          data: [{ col_1: "CSMS", col_2: "https://cms.siliconii.com//Sys/SessionTrans" }],
        }),
      )
      .mockResolvedValueOnce(sessionTransResponse("https://example.invalid/escape"));

    await expect(createCmsSession(TEST_ENV, { fetchImpl, nowMs: 59_000 })).rejects.toThrow(
      "CMS_AUTH_HANDOFF_REJECTED",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("bounds a TOTP rejection to one adjacent-window retry", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ result: "F_TOTP_VERIFY", pending_token: "pending-1" }))
      .mockResolvedValueOnce(jsonResponse({ result: "F_TOTP_VERIFY", err: -1, errMsg: "invalid code" }))
      .mockResolvedValueOnce(
        jsonResponse({
          result: "S",
          guid: "guid-123",
          data: [{ col_1: "CSMS", col_2: "https://cms.siliconii.com//Sys/SessionTrans" }],
        }),
      )
      .mockResolvedValueOnce(sessionTransResponse("/Sales/InvcList"))
      .mockResolvedValueOnce(new Response("<html>cms</html>", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ err: 0, rows: 0, data: [] }));

    await createCmsSession(TEST_ENV, { fetchImpl, nowMs: 59_000 });

    const totpCalls = fetchImpl.mock.calls.filter(([input]) => String(input).includes("/Logon/VerifyTotp"));
    expect(totpCalls).toHaveLength(2);
    const firstCode = JSON.parse(String(totpCalls[0]?.[1]?.body)).code;
    const secondCode = JSON.parse(String(totpCalls[1]?.[1]?.body)).code;
    expect(firstCode).not.toBe(secondCode);
  });

  it("fails closed on primary-login rejection without echoing fixture credentials", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ result: "F_LOCK", err: -1, errMsg: "account locked" }));

    try {
      await createCmsSession(TEST_ENV, { fetchImpl, nowMs: 59_000 });
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).toContain("CMS_AUTH_PRIMARY_REJECTED");
      expect(String(error)).not.toContain(TEST_ENV.CMS_AUTH_USER);
      expect(String(error)).not.toContain(TEST_ENV.CMS_AUTH_PASSWORD);
      expect(String(error)).not.toContain(TEST_ENV.CMS_TOTP_SECRET);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
