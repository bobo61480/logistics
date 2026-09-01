export type CmsSession = {
  cookieHeader: string;
  createdAt: string;
  expiresAt: string | null;
};

export type CmsAuthEnv = {
  CMS_AUTH_USER: string;
  CMS_AUTH_PASSWORD: string;
  CMS_TOTP_SECRET: string;
};

export type ParsedCookie = {
  name: string;
  value: string;
  expiresAt: string | null;
  domain?: string;
  path?: string;
};

export class CmsAuthError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CmsAuthError";
    this.code = code;
  }
}

function decodeBase32(input: string): Uint8Array {
  const normalized = input.trim().replace(/\s+/g, "").replace(/=+$/g, "").toUpperCase();
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new CmsAuthError("CMS_AUTH_TOTP_SECRET_INVALID");
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0;
  let bits = 0;
  const output: number[] = [];

  for (const character of normalized) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new CmsAuthError("CMS_AUTH_TOTP_SECRET_INVALID");
    buffer = (buffer << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }

  if (!output.length) throw new CmsAuthError("CMS_AUTH_TOTP_SECRET_INVALID");
  return new Uint8Array(output);
}

export async function generateTotp(secret: string, nowMs = Date.now()): Promise<string> {
  const keyBytes = decodeBase32(secret);
  const counter = BigInt(Math.floor(nowMs / 1000 / 30));
  const counterBytes = new Uint8Array(8);
  let value = counter;
  for (let index = 7; index >= 0; index -= 1) {
    counterBytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = signature[signature.length - 1]! & 0x0f;
  const binary =
    ((signature[offset]! & 0x7f) << 24) |
    ((signature[offset + 1]! & 0xff) << 16) |
    ((signature[offset + 2]! & 0xff) << 8) |
    (signature[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function splitCombinedSetCookie(value: string): string[] {
  return value
    .split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function headerSetCookies(headers: Headers): string[] {
  const maybeHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof maybeHeaders.getSetCookie === "function") {
    return maybeHeaders.getSetCookie();
  }
  const combined = headers.get("set-cookie");
  return combined ? splitCombinedSetCookie(combined) : [];
}

function parseCookie(value: string): ParsedCookie | null {
  const parts = value.split(";").map((part) => part.trim());
  const first = parts.shift();
  if (!first) return null;
  const separator = first.indexOf("=");
  if (separator <= 0) return null;
  const name = first.slice(0, separator).trim();
  const cookieValue = first.slice(separator + 1);
  if (!name) return null;

  let expiresAt: string | null = null;
  let domain: string | undefined;
  let path: string | undefined;
  for (const part of parts) {
    const index = part.indexOf("=");
    const attributeName = (index >= 0 ? part.slice(0, index) : part).trim().toLowerCase();
    const attributeValue = index >= 0 ? part.slice(index + 1).trim() : "";
    if (attributeName === "expires") {
      const parsed = Date.parse(attributeValue);
      if (Number.isFinite(parsed)) expiresAt = new Date(parsed).toISOString();
    } else if (attributeName === "domain" && attributeValue) {
      domain = attributeValue.toLowerCase();
    } else if (attributeName === "path" && attributeValue) {
      path = attributeValue;
    }
  }

  return { name, value: cookieValue, expiresAt, domain, path };
}

export function parseSetCookieHeaders(headers: Headers): ParsedCookie[] {
  return headerSetCookies(headers)
    .map(parseCookie)
    .filter((cookie): cookie is ParsedCookie => cookie !== null);
}

export function mergeCookies(
  existing: Map<string, string>,
  next: Array<{ name: string; value: string }>,
): Map<string, string> {
  const merged = new Map(existing);
  for (const cookie of next) {
    if (!cookie.name) continue;
    if (cookie.value === "") merged.delete(cookie.name);
    else merged.set(cookie.name, cookie.value);
  }
  return merged;
}

export function sessionExpiresAt(
  cookies: Array<{ name: string; value: string; expiresAt: string | null }>,
): string | null {
  const expirations = cookies
    .map((cookie) => cookie.expiresAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (!expirations.length) return null;
  return new Date(Math.min(...expirations)).toISOString();
}
