# Siliconii Unattended Session Renewal Design

## Goal

Add a production-safe authentication subsystem to `stylekorean-cms-gateway` that can renew a Siliconii CSMS browser session without manual TOTP entry, then use the renewed session for read-only CMS requests such as `GET /SalesProcess/INVCList`.

The gateway must never commit, log, return, or expose the CMS username, password, TOTP seed, TOTP codes, handoff GUID, pending token, or raw cookie values.

## Confirmed authentication model

The observed Siliconii login flow is:

1. `POST https://auth.siliconii.com/Logon/CheckLogin` with JSON `{ uid, pwd, sys_gbn: "CSMS" }`.
2. When MFA is required, the response returns `result: "F_TOTP_VERIFY"`, a `pending_token`, and `totp_step: "V1"`.
3. `POST https://auth.siliconii.com/Logon/VerifyTotp` with JSON `{ pending_token, code }`.
4. A successful response returns `result: "S"`, a `guid`, and an application handoff URL for CSMS at `https://cms.siliconii.com//Sys/SessionTrans`.
5. The returned `guid` becomes the `.siliconii.com` `appKey` handoff cookie.
6. The gateway requests `/Sys/SessionTrans` with `Cookie: appKey=<guid>` and captures the CMS cookies emitted by the server/redirect chain.
7. Those Siliconii-generated cookies are used for authenticated read requests to CMS endpoints.

The gateway must not fabricate `CMS_E`, `CSMS_U`, `CSMS_M`, `CO`, `CSMS`, or `ASP.NET_SessionId`. Those values must come from Siliconii's own session exchange.

## Security boundary

### Cloudflare Worker secrets

The unattended login requires three long-lived secrets:

- `CMS_AUTH_USER`
- `CMS_AUTH_PASSWORD`
- `CMS_TOTP_SECRET`

`CMS_TOTP_SECRET` is the Base32 TOTP seed, not a rotating six-digit code.

Optional existing secrets such as `CMS_IMS_API_KEY` and `CMS_MCP_AUTH_TOKEN` may remain during migration, but they are not part of the new browser-session renewal flow.

The three auth secrets must be configured only as Cloudflare Worker secrets. They must not appear in `wrangler.cms-gateway.toml`, GitHub source, GitHub Actions logs, health responses, error responses, or test fixtures containing real values.

### MFA trade-off

Storing both password and TOTP seed in the same Worker security boundary collapses interactive MFA into unattended machine authentication. This design accepts that trade-off because the user explicitly requires fully unattended renewal. The implementation must minimize blast radius by keeping the gateway read-only, restricting proxied CMS operations, never exposing raw CMS responses, and never exposing any authentication artifacts.

A vendor-supported service account or API credential remains the preferred long-term replacement when Siliconii provides one.

## Components

### `cms-gateway/auth.ts`

Owns authentication and session renewal. It will provide focused interfaces:

```ts
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

export function generateTotp(secret: string, nowMs?: number): Promise<string>;
export function parseSetCookieHeaders(headers: Headers): Array<{ name: string; value: string; expiresAt: string | null }>;
export function mergeCookies(existing: Map<string, string>, next: Array<{ name: string; value: string }>): Map<string, string>;
export function sessionExpiresAt(setCookies: Array<{ name: string; value: string; expiresAt: string | null }>): string | null;
export async function createCmsSession(env: CmsAuthEnv): Promise<CmsSession>;
```

`createCmsSession()` implements `CheckLogin -> VerifyTotp -> appKey -> SessionTrans -> cookie capture`.

### `cms-gateway/session-store.ts`

Owns session state and renewal coordination. The implementation must use a Cloudflare Durable Object, not process-global memory, because Workers are horizontally distributed and ephemeral.

The Durable Object stores only the current CMS session and metadata. It must never store the CMS password or TOTP seed.

The stored record is:

```ts
export type StoredCmsSession = {
  cookieHeader: string;
  createdAt: string;
  expiresAt: string | null;
  lastValidatedAt: string | null;
};
```

The Durable Object serializes renewal so concurrent requests do not all perform MFA login at once.

Its internal API supports:

- `GET /session` -> return current session metadata and cookie header to the Worker only.
- `POST /renew` -> force one serialized renewal.
- `POST /invalidate` -> clear the stored session.

These routes are service-internal. They are not exposed through the public Worker router.

### `cms-gateway/worker.ts`

The existing gateway remains the external read-only API boundary.

Direct CMS requests call `getValidSession()` before contacting Siliconii. The direct request path sends:

- `Accept: application/json, text/javascript, */*; q=0.01`
- `Cookie: <current generated session cookie header>`
- `X-Requested-With: XMLHttpRequest`
- an appropriate CMS `Referer`

The Worker must not send the inventory `x-api-key` as a substitute for CMS browser authentication.

## TOTP implementation

The gateway generates RFC 6238 TOTP codes using Web Crypto only, with no third-party dependency.

Parameters:

- Base32-decoded secret bytes
- HMAC-SHA1
- 30-second time step
- 6 digits
- counter `floor(unixTimeSeconds / 30)` encoded as an 8-byte big-endian value
- dynamic truncation per RFC 4226

The generator must be deterministic under an injected `nowMs` for tests.

The implementation must validate the Base32 seed and reject empty or malformed input without logging the seed.

## Login flow details

### CheckLogin

Request:

```http
POST https://auth.siliconii.com/Logon/CheckLogin
Content-Type: application/json
Accept: application/json
Origin: https://auth.siliconii.com
```

Body:

```json
{"uid":"<secret>","pwd":"<secret>","sys_gbn":"CSMS"}
```

Expected MFA response:

- HTTP 200
- JSON
- `result === "F_TOTP_VERIFY"`
- non-empty `pending_token`

If the response indicates password expiry, lockout, account disablement, or another terminal login state, the gateway must fail closed with a sanitized error code such as `CMS_AUTH_PRIMARY_REJECTED` and must not retry aggressively.

### VerifyTotp

Generate a current code immediately before the request.

Request body:

```json
{"pending_token":"<temporary>","code":"<generated>"}
```

Expected success response:

- HTTP 200
- `result === "S"`
- non-empty `guid`
- `data` contains `col_1 === "CSMS"` and a `col_2` URL whose origin is exactly `https://cms.siliconii.com`

The implementation must reject a handoff URL on any other origin.

A TOTP rejection receives one bounded retry using the adjacent time window only when the first failure is consistent with clock-bound MFA failure. It must not loop indefinitely.

### SessionTrans

The gateway creates an in-memory cookie jar containing:

```text
appKey=<guid>
```

Then it requests the confirmed CSMS handoff URL with redirects handled manually so every `Set-Cookie` header can be captured.

For every response in the redirect chain:

1. Parse all `Set-Cookie` values.
2. Update the cookie jar by cookie name.
3. Follow only redirects whose destination origin is `https://cms.siliconii.com`.
4. Reject external redirects.
5. Stop after at most 5 redirects.

The final session cookie header is assembled only from cookies applicable to `cms.siliconii.com` and excludes unrelated cookies such as `AWSALB` and `AWSALBCORS` from other domains.

The session is considered created only after a CMS session-validation request succeeds.

## Session validation

The preferred validation request is the existing CMS server-session check endpoint:

```http
POST https://cms.siliconii.com/Sys/GetSessionValue
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Cookie: <session>
```

with a non-sensitive key such as the current user/company session key used by the CMS frontend.

If that endpoint cannot be validated reliably during implementation, use a minimal read-only `GET /SalesProcess/INVCList` request with `page_rows=1` as the session probe.

A valid session must return expected JSON rather than login HTML or a redirect.

## Renewal state machine

`getValidSession()` follows this order:

1. Load the current session from the Durable Object.
2. If no session exists, renew.
3. If an explicit expiration is known and less than 15 minutes remain, renew before use.
4. If no explicit expiration exists, validate at most once every 10 minutes.
5. Use the session for the CMS request.
6. If CMS returns a redirect, login HTML, or another recognized session-expired response, invalidate and renew once.
7. Retry the original CMS request exactly once with the new session.
8. If that retry fails, return a sanitized 502/503 error. Never enter an unbounded authentication loop.

The Durable Object is the single-flight coordinator: while one renewal is in progress, concurrent callers await the same result rather than triggering additional TOTP attempts.

## Expiration policy

Use cookie expiry metadata when Siliconii supplies it. The earliest meaningful CMS authentication-cookie expiration becomes the session expiration. Session cookies with no expiry do not override an explicit persistent-cookie expiration.

Renew proactively when `expiresAt - now <= 15 minutes`.

If no expiry can be derived, the session remains usable until validation fails, with a validation probe no more than once every 10 minutes.

## Error model

Externally visible errors are sanitized codes/messages only. Examples:

- `CMS_AUTH_NOT_CONFIGURED`
- `CMS_AUTH_PRIMARY_REJECTED`
- `CMS_AUTH_TOTP_REJECTED`
- `CMS_AUTH_HANDOFF_REJECTED`
- `CMS_AUTH_SESSION_EXCHANGE_FAILED`
- `CMS_AUTH_SESSION_INVALID`
- `CMS_AUTH_RENEWAL_FAILED`

Errors must not include response bodies from `CheckLogin`, `VerifyTotp`, `SessionTrans`, cookies, credentials, TOTP codes, pending tokens, GUIDs, or raw stack traces containing request payloads.

Observability may record timestamps, status classes, durations, renewal count, and sanitized error codes.

## Health endpoint

`GET /health` may add only non-sensitive fields:

```json
{
  "unattendedAuthConfigured": true,
  "cmsSessionState": "valid|renewing|expired|missing|error",
  "cmsSessionCreatedAt": "ISO timestamp or null",
  "cmsSessionExpiresAt": "ISO timestamp or null",
  "cmsSessionLastValidatedAt": "ISO timestamp or null"
}
```

No credential, cookie, token, GUID, TOTP, username, employee name, or account identifier may be returned.

## Deployment configuration

`wrangler.cms-gateway.toml` adds a Durable Object binding and migration for the CMS session store. It must not contain secret values.

The GitHub deployment workflow may provision the following GitHub Actions secrets into Cloudflare Worker secrets when they exist:

- `CMS_AUTH_USER`
- `CMS_AUTH_PASSWORD`
- `CMS_TOTP_SECRET`

GitHub Actions must pipe each value directly to `wrangler secret put` and must never echo the value.

The gateway remains deployable when the three secrets are absent, but `/health` reports `unattendedAuthConfigured: false` and CMS session-backed routes fail with `CMS_AUTH_NOT_CONFIGURED` instead of attempting login.

## Existing CMS client constraints preserved

The existing server-side Siliconii integration remains read-only and reduced. CMS browser-session authentication is not a license to expose arbitrary CMS paths, arbitrary query parameters, or raw CMS responses.

`/SalesProcess/INVCList` requests must include `X-Requested-With: XMLHttpRequest`, and the response contract must still be validated before data is reduced for downstream use.

## Testing

### Unit tests

Add deterministic tests for:

- RFC 6238 TOTP known vectors adapted to 6-digit output.
- Base32 decoding and malformed-secret rejection.
- `Set-Cookie` parsing including `Expires` attributes containing commas.
- Cookie overwrite behavior by name.
- Earliest meaningful session expiration calculation.
- Handoff-origin validation.
- Redirect-limit enforcement.
- Sanitized error behavior.

### Authentication flow tests

Mock `fetch` and verify:

- successful `CheckLogin -> VerifyTotp -> SessionTrans -> validation` flow;
- `guid` becomes `appKey`;
- session cookies are captured from multiple redirect responses;
- external redirect is rejected;
- TOTP retry is bounded;
- password/lockout failures do not trigger TOTP;
- no test failure or thrown error contains fixture credential values.

### Session-store tests

Verify:

- missing session triggers renewal;
- near-expiry session triggers proactive renewal;
- valid session is reused;
- concurrent renewal requests collapse to one login attempt;
- invalidation forces next request to renew;
- a failed renewal does not destroy a still-valid session unless CMS already proved it invalid.

### CMS request integration tests

Verify:

- authenticated direct CMS request uses `Cookie` and `X-Requested-With`;
- login HTML/redirect triggers one invalidate-renew-retry cycle;
- second auth failure stops and returns sanitized error;
- raw cookies are never present in the outward response.

## Production verification

After deployment:

1. `/health` must return HTTP 200 and show whether unattended auth is configured without exposing any secret.
2. With secrets configured, invoke `/sales-summary?month=2026-08`.
3. Confirm the request obtains JSON from the direct Siliconii CMS path rather than login HTML.
4. Confirm the response groups totals by currency and does not combine currencies.
5. Invalidate the stored session through an internal test/deployment mechanism and confirm the next request renews automatically.
6. Confirm logs contain no cookie values, credentials, TOTP seed, TOTP code, pending token, or GUID.

## Rollout

Deploy the unattended renewal path behind the existing gateway. During the first production verification, retain the old MCP fallback only as a temporary diagnostic path. Once direct browser-session renewal is verified, direct CMS session authentication becomes the primary invoice transport and the broken MCP dependency should be removed from the critical path.

## Out of scope

- Reimplementing or decrypting Siliconii cookie formats.
- Fabricating CMS session cookies locally.
- Exposing general-purpose CMS proxy routes.
- Automating write-capable CMS actions.
- Recovering a TOTP seed from a rotating code or HAR capture.
- Storing any real credential or cookie in source control.
