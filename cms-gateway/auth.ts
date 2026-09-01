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

type CreateCmsSessionOptions = {
  fetchImpl?: typeof fetch;
  nowMs?: number;
};

type AuthResponse = {
  result?: string | null;
  pending_token?: string | null;
  guid?: string | null;
  data?: Array<{ col_1?: string | null; col_2?: string | null }>;
};

const AUTH_ORIGIN = "https://auth.siliconii.com";
const CMS_ORIGIN = "https://cms.siliconii.com";
const CHECK_LOGIN_URL = `${AUTH_ORIGIN}/Logon/CheckLogin`;
const VERIFY_TOTP_URL = `${AUTH_ORIGIN}/Logon/VerifyTotp`;
const MAX_HANDOFF_REDIRECTS = 5;

export class CmsAuthError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CmsAuthError";
    this.code = code;
  }
}

function requiredSecret(value: string | undefined): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new CmsAuthError("CMS_AUTH_NOT_CONFIGURED");
  return normalized;
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
  const decoded = decodeBase32(secret);
  const keyBytes = new Uint8Array(decoded.length);
  keyBytes.set(decoded);

  const counter = Math.floor(nowMs / 1000 / 30);
  const high = Math.floor(counter / 0x1_0000_0000);
  const low = counter >>> 0;
  const counterBytes = new Uint8Array(8);
  counterBytes[0] = (high >>> 24) & 0xff;
  counterBytes[1] = (high >>> 16) & 0xff;
  counterBytes[2] = (high >>> 8) & 0xff;
  counterBytes[3] = high & 0xff;
  counterBytes[4] = (low >>> 24) & 0xff;
  counterBytes[5] = (low >>> 16) & 0xff;
  counterBytes[6] = (low >>> 8) & 0xff;
  counterBytes[7] = low & 0xff;

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, counterBytes.buffer as ArrayBuffer),
  );
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

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function cookieAppliesToCms(cookie: ParsedCookie): boolean {
  if (!cookie.domain) return true;
  const domain = cookie.domain.replace(/^\./, "");
  return domain === "siliconii.com" || domain === "cms.siliconii.com";
}

async function safeJson<T>(response: Response, errorCode: string): Promise<T> {
  if (!response.ok) throw new CmsAuthError(errorCode);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) throw new CmsAuthError(errorCode);
  try {
    return await response.json<T>();
  } catch {
    throw new CmsAuthError(errorCode);
  }
}

async function postAuthJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, string>,
  errorCode: string,
): Promise<AuthResponse> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: AUTH_ORIGIN,
        Referer: `${AUTH_ORIGIN}/`,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CmsAuthError(errorCode);
  }
  return safeJson<AuthResponse>(response, errorCode);
}

function csmsHandoffUrl(payload: AuthResponse): URL {
  const target = payload.data?.find((item) => String(item.col_1 ?? "").toUpperCase() === "CSMS")?.col_2;
  if (!target) throw new CmsAuthError("CMS_AUTH_HANDOFF_REJECTED");
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new CmsAuthError("CMS_AUTH_HANDOFF_REJECTED");
  }
  if (url.origin !== CMS_ORIGIN) throw new CmsAuthError("CMS_AUTH_HANDOFF_REJECTED");
  return url;
}

function validationUrl(): URL {
  const url = new URL("/SalesProcess/INVCList", CMS_ORIGIN);
  url.search = new URLSearchParams({
    mode: "R01",
    key_val: "",
    appr_yn: "Y",
    block_gbn: "F",
    block_pages: "10",
    page_rows: "1",
    curr_block: "1",
    curr_page: "1",
    base_key: "",
    sdt: "2026-01-01",
    edt: "2099-12-31",
    comp_cd: "CO000007",
    whouse_cd: "",
    invc_user: "",
    dept_cd: "",
    cust_cd: "",
    cust_nm: "",
    prod_cd: "",
    prod_nm: "",
    biz_type: "",
    creq_yn: "",
    ow_yn: "",
    ow_sdt: "",
    ow_edt: "",
    invc_no: "",
    curr_lang: "ENG",
  }).toString();
  return url;
}

export async function validateCmsSession(
  sessionCookie: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(validationUrl(), {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        Cookie: sessionCookie,
        Referer: `${CMS_ORIGIN}/Sales/InvcList`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
  } catch {
    throw new CmsAuthError("CMS_AUTH_SESSION_INVALID");
  }

  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    throw new CmsAuthError("CMS_AUTH_SESSION_INVALID");
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) throw new CmsAuthError("CMS_AUTH_SESSION_INVALID");
  let payload: { err?: number; data?: unknown[] };
  try {
    payload = await response.json<{ err?: number; data?: unknown[] }>();
  } catch {
    throw new CmsAuthError("CMS_AUTH_SESSION_INVALID");
  }
  if (payload.err !== 0 || !Array.isArray(payload.data)) {
    throw new CmsAuthError("CMS_AUTH_SESSION_INVALID");
  }
}

async function exchangeHandoff(
  fetchImpl: typeof fetch,
  handoff: URL,
  guid: string,
): Promise<{ jar: Map<string, string>; cookies: ParsedCookie[] }> {
  let jar = new Map<string, string>([["appKey", guid]]);
  const captured: ParsedCookie[] = [];
  let current = handoff;

  for (let redirectCount = 0; redirectCount <= MAX_HANDOFF_REDIRECTS; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          Cookie: cookieHeader(jar),
          Referer: `${AUTH_ORIGIN}/`,
        },
      });
    } catch {
      throw new CmsAuthError("CMS_AUTH_SESSION_EXCHANGE_FAILED");
    }

    const responseCookies = parseSetCookieHeaders(response.headers).filter(cookieAppliesToCms);
    captured.push(...responseCookies);
    jar = mergeCookies(jar, responseCookies);

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_HANDOFF_REDIRECTS) {
        throw new CmsAuthError("CMS_AUTH_HANDOFF_REJECTED");
      }
      const location = response.headers.get("location");
      if (!location) throw new CmsAuthError("CMS_AUTH_HANDOFF_REJECTED");
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new CmsAuthError("CMS_AUTH_HANDOFF_REJECTED");
      }
      if (next.origin !== CMS_ORIGIN) throw new CmsAuthError("CMS_AUTH_HANDOFF_REJECTED");
      current = next;
      continue;
    }

    if (!response.ok) throw new CmsAuthError("CMS_AUTH_SESSION_EXCHANGE_FAILED");
    return { jar, cookies: captured };
  }

  throw new CmsAuthError("CMS_AUTH_HANDOFF_REJECTED");
}

export async function createCmsSession(
  env: CmsAuthEnv,
  options: CreateCmsSessionOptions = {},
): Promise<CmsSession> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now();
  const user = requiredSecret(env.CMS_AUTH_USER);
  const password = requiredSecret(env.CMS_AUTH_PASSWORD);
  const totpSecret = requiredSecret(env.CMS_TOTP_SECRET);

  const primary = await postAuthJson(
    fetchImpl,
    CHECK_LOGIN_URL,
    { uid: user, pwd: password, sys_gbn: "CSMS" },
    "CMS_AUTH_PRIMARY_REJECTED",
  );
  const pendingToken = String(primary.pending_token ?? "").trim();
  if (primary.result !== "F_TOTP_VERIFY" || !pendingToken) {
    throw new CmsAuthError("CMS_AUTH_PRIMARY_REJECTED");
  }

  let verified: AuthResponse | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const code = await generateTotp(totpSecret, nowMs + attempt * 30_000);
    const candidate = await postAuthJson(
      fetchImpl,
      VERIFY_TOTP_URL,
      { pending_token: pendingToken, code },
      "CMS_AUTH_TOTP_REJECTED",
    );
    if (candidate.result === "S" && String(candidate.guid ?? "").trim()) {
      verified = candidate;
      break;
    }
  }
  if (!verified) throw new CmsAuthError("CMS_AUTH_TOTP_REJECTED");

  const guid = String(verified.guid ?? "").trim();
  const handoff = csmsHandoffUrl(verified);
  const exchange = await exchangeHandoff(fetchImpl, handoff, guid);
  const finalCookieHeader = cookieHeader(exchange.jar);
  if (!finalCookieHeader) throw new CmsAuthError("CMS_AUTH_SESSION_EXCHANGE_FAILED");

  await validateCmsSession(finalCookieHeader, fetchImpl);

  return {
    cookieHeader: finalCookieHeader,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: sessionExpiresAt(exchange.cookies),
  };
}
