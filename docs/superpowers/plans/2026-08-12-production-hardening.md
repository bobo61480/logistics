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
- Modify/create: `.github/workflows/ci-pr.yml`

- [ ] Run `npm ci`, `npm test`, `npm run typecheck`, `npm run build` on relevant application/Apps Script/test/config changes.
- [ ] Run Playwright smoke tests when build/runtime supports it.
- [ ] Cache npm through `actions/setup-node`.
- [ ] Commit `ci: verify full control tower changes`.

### Task 2: Strengthen production Worker deploy

**Files:**
- Modify: `.github/workflows/deploy-cloudflare.yml`

- [ ] Use `npm ci` rather than non-lockfile install.
- [ ] Run unit, type, build before deployment.
- [ ] Apply D1 migrations only when the D1 binding/database is configured.
- [ ] Deploy Worker/static assets.
- [ ] Probe `/`, `/light`, `/light-skin`, `/light-full`, `/fulfillment-style`.
- [ ] Probe `/api/logistics/health` and `/api/logistics/snapshot` and require JSON `ok: true` for snapshot core sources.
- [ ] Keep retries bounded and log response snippets on failure.
- [ ] Commit `ci: verify live control tower behavior`.

### Task 3: Strengthen Apps Script deployment verification

**Files:**
- Modify: `.github/workflows/deploy-apps-script.yml`

- [ ] Keep clasp push/deploy.
- [ ] Verify expected deployment ID remains registered.
- [ ] Add a non-mutating GET/health operation to Apps Script if absent, returning version markers for Gmail pipeline, trigger plan, WMS importer, and status vocabulary.
- [ ] Curl that health operation after deployment and verify current version markers.
- [ ] Commit `ci: verify live Apps Script version`.

### Task 4: Add production smoke script

**Files:**
- Create: `scripts/verify-production.mjs`
- Add npm script: `verify:production`.

**Interface:**

```js
const base = process.env.PRODUCTION_BASE_URL || "https://stylekorean.dpdns.org";
```

Checks:

- required routes HTTP 200;
- snapshot JSON ok;
- sourceHealth contains core sources;
- generatedAt parseable;
- HTML contains the application title/style switcher shell;
- no route serves an obvious deployment error page.

- [ ] Add script-level tests where practical.
- [ ] Commit `test: add production control tower smoke verifier`.

### Task 5: Add operational post-deploy audit

**Files:**
- Create: `docs/operations/control-tower-verification.md`

- [ ] Record exact checks for Gmail error-loop cessation, WMS trucking idempotency, import ETA visibility, carrier inference, Fulfillment TK, inventory, KPIs, and review queue.
- [ ] Include rollback commands/process by backup Git ref and Drive workbook copy.
- [ ] Commit `docs: add control tower production verification runbook`.

### Task 6: Final live verification

- [ ] Confirm Cloudflare deploy job succeeded for the exact final main SHA.
- [ ] Run production smoke verifier.
- [ ] Read live `PIPELINE LOG` after the final scheduled Gmail cycle and confirm the known AB221 validation error no longer increases.
- [ ] Search live `WH Trucking Request` and confirm the two Korheim invoices are separated and stable after at least one importer interval.
- [ ] Inspect live IMPORTS rows around current/future ETAs and verify later-than-08/14 shipments are visible through source logic.
- [ ] Verify a representative `1Z` parcel resolves to UPS.
- [ ] Verify Fulfillment TK endpoint/card loads.
- [ ] Verify inbound/stock inventory panels have source data or explicit healthy empty state.
- [ ] Verify KPI snapshot returns numbers rather than transport error.

### Task 7: Completion audit

**Files:**
- Create: `docs/operations/2026-08-12-control-tower-completion-audit.md`

Include:

- pre-change Git backup ref;
- Drive backup URL/title;
- implementation PR/merge SHAs;
- production deploy SHA/run;
- test/type/build results;
- Apps Script deployment result;
- live source/automation verification timestamps;
- D1 status (active or exact external provisioning blocker);
- remaining non-critical limitations;
- exact rollback procedure.

Commit: `docs: record control tower completion audit`.
