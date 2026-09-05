#!/usr/bin/env node

/**
 * Production launcher for the Google Sheets -> D1 mirror.
 *
 * The existing clasp OAuth credential belongs to a Google Cloud project where
 * sheets.googleapis.com is disabled. The credential itself is valid and has
 * access to the private workbooks, so intercept private docs.google.com GViz
 * and CSV export reads and attach the bearer token. This preserves the normal
 * public Logistics Master path while avoiding a Google Cloud API dependency.
 */

const PRIVATE_SHEET_IDS = new Set([
  "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I",
  "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8",
]);
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const nativeFetch = globalThis.fetch.bind(globalThis);
let tokenPromise = null;

function parseJsonSecret(raw, label) {
  if (!raw) return null;
  const candidates = [String(raw).trim()];
  try { candidates.push(Buffer.from(String(raw).trim(), "base64").toString("utf8")); } catch {}
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  throw new Error(`${label} is not valid JSON/base64 JSON`);
}

function claspCredential() {
  const parsed = parseJsonSecret(process.env.CLASP_ACCESS_TOKEN, "CLASP_ACCESS_TOKEN");
  if (!parsed) return null;
  const token = parsed.token || parsed.tokens || parsed;
  const settings = parsed.oauth2ClientSettings || parsed.oauth2_client_settings || parsed.credentials || {};
  return {
    accessToken: String(token.access_token || token.accessToken || "").trim(),
    refreshToken: String(token.refresh_token || token.refreshToken || "").trim(),
    expiryDate: Number(token.expiry_date || token.expiryDate || 0),
    clientId: String(settings.clientId || settings.client_id || parsed.client_id || "").trim(),
    clientSecret: String(settings.clientSecret || settings.client_secret || parsed.client_secret || "").trim(),
  };
}

async function getClaspToken() {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const credential = claspCredential();
      if (!credential) throw new Error("CLASP_ACCESS_TOKEN is required for private workbook GViz reads");
      if (credential.accessToken && (!credential.expiryDate || credential.expiryDate > Date.now() + 60_000)) return credential.accessToken;
      if (!credential.refreshToken || !credential.clientId || !credential.clientSecret) {
        if (credential.accessToken) return credential.accessToken;
        throw new Error("CLASP_ACCESS_TOKEN cannot refresh and has no usable access token");
      }
      const response = await nativeFetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          client_id: credential.clientId,
          client_secret: credential.clientSecret,
          refresh_token: credential.refreshToken,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.access_token) {
        const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
        throw new Error(`Clasp OAuth refresh failed: ${detail}`);
      }
      return payload.access_token;
    })();
  }
  return tokenPromise;
}

function privateSheetDownloadId(url) {
  try {
    const parsed = new URL(typeof url === "string" ? url : url.url);
    if (parsed.hostname !== "docs.google.com" || !parsed.pathname.includes("/spreadsheets/d/")) return "";
    if (!parsed.pathname.endsWith("/gviz/tq") && !parsed.pathname.endsWith("/export")) return "";
    const match = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)\/(?:gviz\/tq|export)$/);
    return match && PRIVATE_SHEET_IDS.has(match[1]) ? match[1] : "";
  } catch {
    return "";
  }
}

globalThis.fetch = async function authenticatedFetch(input, init = {}) {
  if (!privateSheetDownloadId(input)) return nativeFetch(input, init);
  const token = await getClaspToken();
  const headers = new Headers(init.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "text/csv,*/*");
  return nativeFetch(input, { ...init, headers });
};

await import("./sync-google-sheets-d1.mjs");
