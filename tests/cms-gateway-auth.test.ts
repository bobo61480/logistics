import { describe, expect, it } from "vitest";
import {
  generateTotp,
  mergeCookies,
  parseSetCookieHeaders,
  sessionExpiresAt,
} from "../cms-gateway/auth";

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
