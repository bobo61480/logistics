# Production Hardening and Rollback Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI/deployment verify application behavior rather than only file existence/HTTP response, retain rollback evidence, and produce an operator-facing completion audit.

**Architecture:** Strengthen GitHub Actions around the same build/deploy path, add deterministic API/live smoke probes, preserve backup refs, and verify operational data/automation after deployment before declaring success.

**Tech Stack:** GitHub Actions, Vitest, TypeScript, Next.js build, Playwright, Wrangler/Cloudflare Workers, clasp/Apps Script, curl.

## Global Constraints

- Never claim live success from merge alone.
- Production must be independently checked after deploy.
- Backup Git branch and Drive workbook copy remain retained.
- Live checks must avoid destructive mutations unless explicitly designed as safe noop/readback verification.

---

### Task 1: Strengthen PR CI

**Files:**
- Modify: `.github/workflows/ci-pr.yml`

- [ ] Run `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:e2e` for application/Worker/Apps Script/test/config changes.
- [ ] Cache npm through `actions/setup-node` with Node `22.13.0`.
- [ ] Commit `ci: verify full control tower changes`.

### Task 2: Strengthen production Worker deploy

**Files:**
- Modify: `.github/workflows/deploy-cloudflare.yml`

- [ ] Use `npm ci` rather than non-lockfile install.
- [ ] Run unit, type, build before deployment.
- [ ] Apply D1 migrations only when a real D1 binding/database id is present in `wrangler.toml`.
- [ ] Deploy Worker/static assets.
- [ ] Probe `/`, `/light`, `/light-skin`, `/light-full`, `/fulfillment-style`.
- [ ] Probe `/api/logistics/health` and `/api/logistics/snapshot` and require JSON `ok: true` for snapshot core sources.
- [ ] Retry live probes at most six times with ten seconds between attempts and print the failing response status/body prefix before exiting non-zero.
- [ ] Commit `ci: verify live control tower behavior`.

### Task 3: Strengthen Apps Script deployment verification

**Files:**
- Modify: `.github/workflows/deploy-apps-script.yml`
- Modify: the Apps Script web entry file containing `doGet`/operation routing.

- [ ] Keep clasp push/deploy.
- [ ] Verify expected deployment ID remains registered.
- [ ] Add a non-mutating operation `op=health` returning JSON fields `ok`, `gmailPipelineVersion`, `appsScriptDeployVersion`, `wmsTruckingVersion`, and `statusVocabularyVersion`.
- [ ] Curl the deployed `/exec?op=health` URL after deployment and require `ok: true` plus the current version strings.
- [ ] Commit `ci: verify live Apps Script version`.

### Task 4: Add production smoke script

**Files:**
- Create: `scripts/verify-production.mjs`
- Modify: `package.json`
- Create: `tests/verify-production-script.test.ts`

**Interface:**

```js
const base = process.env.PRODUCTION_BASE_URL || "https://stylekorean.dpdns.org";
```

Checks:

- required routes HTTP 200;
- snapshot JSON `ok === true`;
- `sourceHealth` contains IMPORTS and outbound core sources;
- `generatedAt` parses as a valid date;
- root HTML contains `StyleKorean` and the appearance navigation shell;
- no route body contains `Application error`, `Internal Server Error`, or Cloudflare deployment error markers.

- [ ] Add source-level test that the script contains all required routes and API assertions.
- [ ] Add `"verify:production": "node scripts/verify-production.mjs"` to package scripts.
- [ ] Commit `test: add production control tower smoke verifier`.

### Task 5: Add operational post-deploy audit

**Files:**
- Create: `docs/operations/control-tower-verification.md`

- [ ] Record exact checks for Gmail error-loop cessation, WMS trucking idempotency, import ETA visibility, carrier inference, Fulfillment TK, inventory, KPIs, and review queue.
- [ ] Include rollback process by backup Git ref and Drive workbook copy.
- [ ] Commit `docs: add control tower production verification runbook`.

### Task 6: Final live verification

- [ ] Confirm Cloudflare deploy job succeeded for the exact final main SHA.
- [ ] Run `npm run verify:production` in CI or an environment with network access.
- [ ] Read live `PIPELINE LOG` after the final scheduled Gmail cycle and confirm the known AB221 validation error no longer increases.
- [ ] Search live `WH Trucking Request` and confirm the two Korheim invoices are separated and stable after at least one importer interval.
- [ ] Inspect live IMPORTS rows around current/future ETAs and verify later-than-08/14 shipments are represented by the source logic.
- [ ] Verify a representative `1Z` parcel resolves to UPS.
- [ ] Verify Fulfillment TK endpoint/card loads.
- [ ] Verify inbound/stock inventory panels have source data or an explicit healthy empty state.
- [ ] Verify KPI snapshot returns numeric KPI fields rather than a transport error.

### Task 7: Completion audit

**Files:**
- Create: `docs/operations/2026-08-12-control-tower-completion-audit.md`

Include:

- pre-change Git backup ref;
- Drive backup URL/title;
- implementation PR/merge SHAs;
- production deploy SHA/run;
- test/type/build/E2E results;
- Apps Script deployment result;
- live source/automation verification timestamps;
- D1 status (active or exact external provisioning blocker);
- remaining non-critical limitations;
- exact rollback procedure.

Commit: `docs: record control tower completion audit`.
