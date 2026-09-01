# Siliconii Unattended Session Renewal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `stylekorean-cms-gateway` renew its Siliconii CSMS browser session automatically using Worker secrets for the username, password, and Base32 TOTP seed, then use the renewed cookie session for read-only invoice requests.

**Architecture:** `cms-gateway/auth.ts` owns RFC 6238 TOTP generation and the `CheckLogin -> VerifyTotp -> SessionTrans` exchange. `cms-gateway/session-store.ts` exports a SQLite-backed Durable Object that stores only the current cookie header and timestamps and serializes renewal. `cms-gateway/worker.ts` asks the Durable Object for a valid session, retries an expired CMS request once after invalidation/renewal, and exposes only sanitized health metadata.

**Tech Stack:** TypeScript 5.9, Vitest 4, Cloudflare Workers Web Crypto, Cloudflare Durable Objects with SQLite storage, Wrangler 4.120+.

**Spec:** `docs/superpowers/specs/2026-08-31-siliconii-unattended-session-renewal-design.md`

## Global Constraints

- Never commit, log, return, or expose `CMS_AUTH_USER`, `CMS_AUTH_PASSWORD`, `CMS_TOTP_SECRET`, TOTP codes, pending tokens, GUIDs, or raw cookie values.
- Keep all CMS operations read-only and do not expose an arbitrary CMS proxy.
- `CMS_TOTP_SECRET` is a Base32 seed and remains a Worker secret only.
- New Durable Object storage must use SQLite.
- Direct `/SalesProcess/INVCList` calls must use `Cookie` and `X-Requested-With: XMLHttpRequest`; `CMS_IMS_API_KEY` is not CMS browser authentication.
- Renewal is bounded: one adjacent-window TOTP retry and one request-level invalidate-renew-retry cycle.
- Public health/error responses contain only sanitized status, timestamps, and stable error codes.

---

### Task 1: TOTP and Cookie Primitives

**Files:**
- Create: `tests/cms-gateway-auth.test.ts`
- Create: `cms-gateway/auth.ts`

**Interfaces:**
- Produces: `generateTotp(secret, nowMs?)`, `parseSetCookieHeaders(headers)`, `mergeCookies(existing, next)`, `sessionExpiresAt(cookies)`, `CmsAuthError`.

- [ ] **Step 1: Write failing primitive tests**

Create tests that import the future helpers and assert deterministic RFC 6238 6-digit values, malformed Base32 rejection, cookie parsing with an `Expires=Wed, ... GMT` attribute, overwrite-by-name behavior, and earliest persistent-cookie expiration.

```ts
import { describe, expect, it } from "vitest";
import { generateTotp, mergeCookies, parseSetCookieHeaders, sessionExpiresAt } from "../cms-gateway/auth";

describe("Siliconii auth primitives", () => {
  it("generates deterministic six-digit RFC 6238 codes", async () => {
    expect(await generateTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toBe("287082");
  });

  it("rejects malformed Base32 without echoing it", async () => {
    await expect(generateTotp("bad*seed", 59_000)).rejects.toThrow("CMS_AUTH_TOTP_SECRET_INVALID");
  });
});
```

- [ ] **Step 2: Run PR CI and verify RED**

Open a PR from the feature branch and run the repository CI. Expected failure: module `../cms-gateway/auth` is missing.

- [ ] **Step 3: Implement the primitives**

Implement Base32 decode, HMAC-SHA1 using `crypto.subtle`, HOTP dynamic truncation, six-digit formatting, `Headers.getSetCookie()` parsing, cookie map merging, and earliest non-session expiration calculation. All thrown errors use sanitized fixed messages/codes.

- [ ] **Step 4: Run CI and verify GREEN**

Expected: primitive tests pass; existing tests and typecheck remain green.

### Task 2: Siliconii Login and Session Exchange

**Files:**
- Modify: `tests/cms-gateway-auth.test.ts`
- Modify: `cms-gateway/auth.ts`

**Interfaces:**
- Produces: `createCmsSession(env, options?) -> Promise<CmsSession>` and `validateCmsSession(cookieHeader, fetchImpl?)`.

- [ ] **Step 1: Add failing auth-flow tests**

Mock `fetch` with sequential responses for `CheckLogin`, `VerifyTotp`, `SessionTrans`, an internal CMS redirect, and a JSON validation probe. Assert that the VerifyTotp `guid` is sent as `appKey`, cookies from multiple responses are merged, only `https://cms.siliconii.com` redirects are followed, and an external redirect throws `CMS_AUTH_HANDOFF_REJECTED`.

- [ ] **Step 2: Run CI and verify RED**

Expected failure: `createCmsSession`/`validateCmsSession` do not exist.

- [ ] **Step 3: Implement login flow**

Implement:

```ts
POST https://auth.siliconii.com/Logon/CheckLogin
POST https://auth.siliconii.com/Logon/VerifyTotp
GET  https://cms.siliconii.com//Sys/SessionTrans
```

Use JSON for the auth posts, generate TOTP immediately before VerifyTotp, permit one adjacent 30-second window retry only for a TOTP-style rejection, validate the CSMS handoff origin, manually follow at most five CMS-origin redirects, collect every `Set-Cookie`, then validate with a one-row `GET /SalesProcess/INVCList` probe that must return JSON with `err === 0` and an array `data`.

- [ ] **Step 4: Run CI and verify GREEN**

Expected: successful login, external redirect rejection, bounded retry, and sanitized-error tests pass.

### Task 3: Durable Object Session Coordinator

**Files:**
- Create: `tests/cms-gateway-session-store.test.ts`
- Create: `cms-gateway/session-store.ts`
- Modify: `wrangler.cms-gateway.toml`

**Interfaces:**
- Produces: `CmsSessionStore` Durable Object class; `getSessionStub(env)` helper; internal `GET /session`, `POST /renew`, `POST /invalidate`, `GET /health` endpoints.

- [ ] **Step 1: Add failing session-policy tests**

Test pure helpers exported from `session-store.ts`: `shouldRenewSession(session, nowMs)`, validation-throttle behavior, and sanitization of health metadata. Test the Durable Object handler with a fake storage object so a missing session renews, a session with <=15 minutes remaining renews, a healthy session is reused, and invalidate clears it.

- [ ] **Step 2: Run CI and verify RED**

Expected failure: `cms-gateway/session-store.ts` is missing.

- [ ] **Step 3: Implement Durable Object**

Use `DurableObject` from `cloudflare:workers`. Persist one `StoredCmsSession` under storage key `cms-session`; keep credentials only in `env`. Use `ctx.blockConcurrencyWhile()`/object serialization semantics so renewal is single-flight. A failed renewal does not overwrite an existing still-valid session.

Add Wrangler configuration:

```toml
[[durable_objects.bindings]]
name = "CMS_SESSION_STORE"
class_name = "CmsSessionStore"

[exports.CmsSessionStore]
type = "durable-object"
storage = "sqlite"
```

- [ ] **Step 4: Run CI and verify GREEN**

Expected: session tests, Wrangler/typecheck, existing unit tests, and build pass.

### Task 4: Gateway Session-backed Invoice Transport

**Files:**
- Create: `tests/cms-gateway-worker.test.ts`
- Modify: `cms-gateway/worker.ts`

**Interfaces:**
- Consumes: `CMS_SESSION_STORE`, `CmsSessionStore` internal API.
- Produces: direct invoice fetch through authenticated CMS cookie session; exactly one invalidate-renew-retry on recognized expiry.

- [ ] **Step 1: Add failing gateway tests**

Test exported helpers for authenticated CMS request construction and expiry detection. Assert `Cookie` + `X-Requested-With` are present, `x-api-key` is absent, a redirect/login HTML response is classified as session expiry, and a second failure stops rather than looping.

- [ ] **Step 2: Run CI and verify RED**

Expected failure: worker does not expose/use the new session-backed transport.

- [ ] **Step 3: Integrate session transport**

Extend `Env` with `CMS_AUTH_USER?`, `CMS_AUTH_PASSWORD?`, `CMS_TOTP_SECRET?`, and `CMS_SESSION_STORE`. Replace the current direct invoice path that depends on `CMS_IMS_API_KEY` with a session-backed fetch. Preserve the old MCP fallback only as a temporary diagnostic fallback. On recognized expiry, call internal invalidate/renew, then retry the same CMS request exactly once.

- [ ] **Step 4: Run CI and verify GREEN**

Expected: authenticated request tests pass; all existing tests/typecheck/build remain green.

### Task 5: Health, Secret Provisioning, and Production Verification

**Files:**
- Modify: `cms-gateway/worker.ts`
- Modify: `.github/workflows/deploy-cms-gateway.yml`
- Modify: `wrangler.cms-gateway.toml`
- Modify: `docs/SILICONII_CMS_ENDPOINTS.md` if present, otherwise update the existing Siliconii integration documentation.

**Interfaces:**
- Produces: safe health fields and deploy-time secret provisioning.

- [ ] **Step 1: Add failing configuration/health assertions**

Add source-level tests that verify the workflow provisions `CMS_AUTH_USER`, `CMS_AUTH_PASSWORD`, and `CMS_TOTP_SECRET` via stdin to `wrangler secret put`, and that health JSON never contains a username, password, seed, cookie, GUID, or pending token field.

- [ ] **Step 2: Run CI and verify RED**

Expected: workflow/health assertions fail before configuration is updated.

- [ ] **Step 3: Wire deployment and safe health**

Workflow environment:

```yaml
CMS_AUTH_USER: ${{ secrets.CMS_AUTH_USER }}
CMS_AUTH_PASSWORD: ${{ secrets.CMS_AUTH_PASSWORD }}
CMS_TOTP_SECRET: ${{ secrets.CMS_TOTP_SECRET }}
```

For each non-empty value, pipe with `printf '%s' "$VALUE" | npx wrangler secret put ...`. Never echo values. `/health` reports only `unattendedAuthConfigured`, `cmsSessionState`, `cmsSessionCreatedAt`, `cmsSessionExpiresAt`, and `cmsSessionLastValidatedAt`.

- [ ] **Step 4: Run full PR verification**

CI commands must succeed:

```bash
npm test
npm run typecheck
npm run build
```

- [ ] **Step 5: Merge and verify deployment**

After PR CI is green, merge to `main`, wait for `deploy-cms-gateway.yml`, and verify:

```bash
curl -fsS https://stylekorean-cms-gateway.stylekorean.workers.dev/health
curl -fsS 'https://stylekorean-cms-gateway.stylekorean.workers.dev/sales-summary?month=2026-08'
```

If the three auth secrets are not yet configured, deployment must still succeed and health must report `unattendedAuthConfigured: false`; the session-backed sales route must return the sanitized `CMS_AUTH_NOT_CONFIGURED` state rather than leaking data or looping.
