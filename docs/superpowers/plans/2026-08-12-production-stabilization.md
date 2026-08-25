# Production Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop active Gmail/WH Trucking corruption loops, establish one status vocabulary and one trigger owner, and preserve rollback copies before any broader redesign.

**Architecture:** Keep `LOGISTICS MASTER 2026` as the operational write target and the external WMS workbook read-only. Introduce one Apps Script status-normalization helper, harden WMS V2 exact-date matching, centralize trigger provisioning, and verify live Apps Script behavior before continuing.

**Tech Stack:** Google Apps Script, Google Sheets, Gmail, GitHub Actions/clasp, Vitest source/regression tests.

## Global Constraints

- External WMS / Stylekorean workbook remains read-only.
- No nearby-date shipment merging.
- Terminal statuses may not be automatically regressed.
- Ambiguous extraction goes to review/error rather than destructive write.
- Preserve `backup/pre-control-tower-hybrid-20260812` and a Drive copy of `LOGISTICS MASTER 2026`.

---

### Task 1: Preserve production rollback state

**Files:**
- No code modification.
- Drive: copy `LOGISTICS MASTER 2026` to `LOGISTICS MASTER 2026 - PRE CONTROL TOWER HYBRID 2026-08-12`.

**Interfaces:**
- Produces: immutable Git branch and Drive workbook copy used for rollback.

- [ ] **Step 1: Verify Git backup branch exists**

Confirm `backup/pre-control-tower-hybrid-20260812` resolves from pre-change `main`.

- [ ] **Step 2: Copy Logistics Master in Drive**

Use Drive copy semantics; do not rename or mutate the source workbook.

- [ ] **Step 3: Record backup URLs/branch in final audit notes**

No production mutation begins until both rollback points exist.

### Task 2: Canonicalize operational statuses before every Apps Script write

**Files:**
- Create: `google-apps-script/StatusNormalization.gs`
- Modify: `google-apps-script/GmailPipelineV2.gs`
- Modify: `google-apps-script/InventorySync.gs` where tracking writes source statuses.
- Test: `tests/apps-script-integrity.test.ts`

**Interfaces:**
- Produces: `canonicalLogisticsStatus_(value)` returning an allowed canonical status string or `""`.
- Produces: `isTerminalLogisticsStatus_(value)`.

- [ ] **Step 1: Write failing source-level regression tests**

Add assertions equivalent to:

```ts
expect(statusSource).toContain('"FDA REVIEW/HOLD": "FDA Review / Hold"');
expect(statusSource).toContain('function canonicalLogisticsStatus_');
expect(gmailSource).toContain('canonicalLogisticsStatus_(record.status)');
```

Run: `npm test -- tests/apps-script-integrity.test.ts`
Expected: FAIL before the helper exists.

- [ ] **Step 2: Implement canonical status helper**

```js
var LOGISTICS_STATUS_ALIASES_ = {
  "SCHEDULED": "Scheduled",
  "WORK IN PROGRESS": "Work in Progress",
  "WIP": "Work in Progress",
  "PENDING": "Pending",
  "SHIPPING": "Shipping",
  "SHIPPED": "Shipped",
  "DELIVERED": "Delivered",
  "RECEIVED": "Received",
  "CANCELLED": "Cancelled",
  "COMPLETED": "Completed",
  "CUSTOMS CLEARANCE": "Customs Clearance",
  "FDA HOLD": "FDA Review / Hold",
  "FDA REVIEW": "FDA Review / Hold",
  "FDA REVIEW/HOLD": "FDA Review / Hold",
  "FDA REVIEW / HOLD": "FDA Review / Hold",
  "FWS HOLD": "FWS Review / Hold",
  "FWS REVIEW": "FWS Review / Hold",
  "FWS REVIEW/HOLD": "FWS Review / Hold",
  "FWS REVIEW / HOLD": "FWS Review / Hold",
  "FDA DETAINED": "FDA Detained",
  "AQI EXAMINATION": "AQI Examination",
  "DELAYED": "Delayed"
};

function canonicalLogisticsStatus_(value) {
  var key = String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
  return LOGISTICS_STATUS_ALIASES_[key] || "";
}

function isTerminalLogisticsStatus_(value) {
  return /^(Shipped|Delivered|Received|Cancelled|Completed)$/.test(canonicalLogisticsStatus_(value));
}
```

- [ ] **Step 3: Normalize Gmail status before writing IMPORTS/WH Trucking**

In `updateInboundRowV2_` and outbound updates:

```js
var normalizedStatus = canonicalLogisticsStatus_(record.status);
if (record.status && !normalizedStatus) {
  throw new Error("Unsupported logistics status: " + record.status);
}
if (normalizedStatus && !isTerminalLogisticsStatus_(current)) {
  set(28, normalizedStatus, true);
}
```

Use the corresponding outbound status column for WH Trucking.

- [ ] **Step 4: Run focused and full tests**

Run:
`npm test -- tests/apps-script-integrity.test.ts`
`npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `fix: canonicalize Apps Script logistics statuses`.

### Task 3: Stop deterministic Gmail retry loops

**Files:**
- Modify: `google-apps-script/GmailPipelineV2.gs`
- Test: `tests/apps-script-integrity.test.ts`

**Interfaces:**
- Produces: `gmailV2RecordFailure_(message, error)` or equivalent deterministic failure disposition.

- [ ] **Step 1: Add failing regression test**

Assert deterministic unsupported-status/validation failures are persisted into review/error disposition rather than left endlessly unseen.

- [ ] **Step 2: Implement failure classification**

```js
function gmailV2DeterministicError_(error) {
  var text = String(error && error.message || error || "");
  return /data validation|unsupported logistics status|ambiguous|cannot be safely inserted/i.test(text);
}
```

In the per-message catch block, write a pending/review row for deterministic failures and mark the message seen only after that review record succeeds. Leave transient service failures unseen for bounded retry.

- [ ] **Step 3: Add attempt/backoff metadata**

Store `GMAIL_V2_ATTEMPT_<messageId>` and timestamp/error for transient failures; skip retry until the calculated backoff window has elapsed. Cap attempts and move to review after the cap.

- [ ] **Step 4: Run tests and commit**

Run `npm test`, then commit `fix: bound Gmail pipeline retries`.

### Task 4: Complete WH Trucking V2 exact-date repair and legacy-path removal

**Files:**
- Modify: `google-apps-script/Code.gs`
- Modify: `google-apps-script/WmsTruckingSyncV2.gs`
- Modify: `google-apps-script/zz_WmsTruckingCompatibility.gs`
- Test: `tests/wms-trucking-v2.test.ts`

**Interfaces:**
- Canonical key: `normalizeWmsCustomerKey_(canonicalWmsCustomer_(customer)) + "___" + exact YYYY-MM-DD`.
- Compatibility entry point: only one global `scanAndImportWmsTruckingOrders()` wrapper delegating to V2.

- [ ] **Step 1: Add failing regression fixtures for 08/07 vs 08/13**

Fixture must model:

```text
KORHEIM (CERRITOS) | IN00462238 | 08/07/2026 | 5129.20
KORHEIM (CERRITOS) | IN00464263 | 08/13/2026 | 22954.72
```

Assert they produce two exact groups and cannot select one another's target row.

- [ ] **Step 2: Remove/rename the legacy importer body from `Code.gs`**

No second global `scanAndImportWmsTruckingOrders()` implementation may remain.

- [ ] **Step 3: Keep one compatibility wrapper**

```js
function scanAndImportWmsTruckingOrders() {
  return scanAndImportWmsTruckingOrdersV2();
}
```

- [ ] **Step 4: Add V2 duplicate-key/noop guard**

Before appending, re-check the in-memory target index for the exact group key and update the index immediately after any pending row is staged so duplicate source groups cannot schedule duplicate appends in one run.

- [ ] **Step 5: Run focused/full tests and commit**

Run `npm test -- tests/wms-trucking-v2.test.ts` and `npm test`.
Commit: `fix: make WMS trucking import exact-date idempotent`.

### Task 5: Clean live Korheim duplicate rows safely

**Files:**
- Live Google Sheet only: `LOGISTICS MASTER 2026` -> `WH Trucking Request`.

**Interfaces:**
- Preserve `IN00464263` / 08/13 row.
- Preserve/create one `IN00462238` / 08/07 row.

- [ ] **Step 1: Re-read all rows containing `KORHEIM` and both invoice numbers immediately before mutation**

Abort cleanup if the live signature no longer matches the documented incident.

- [ ] **Step 2: Identify exact malformed duplicate rows**

Deletion candidates must match the combined invoice/date/value corruption signature; unrelated neighboring rows are excluded.

- [ ] **Step 3: Retain one correct 08/07 row**

Set only canonical customer, invoice `IN00462238`, ship date `08/07/2026`, value `5129.20`, preserving address/format/formulas/validation.

- [ ] **Step 4: Delete confirmed duplicate rows bottom-up**

Use Sheets batch row deletion in descending ranges to avoid index drift.

- [ ] **Step 5: Verify post-cleanup counts**

Search again and require exactly one valid row for each invoice/date pair.

### Task 6: Make `setupAllTriggers()` the only trigger owner

**Files:**
- Modify: `google-apps-script/Triggers.gs`
- Modify: self-provisioning helpers in `GmailPipelineV2.gs`, `InventorySync.gs`, and other modules as required.
- Test: `tests/apps-script-integrity.test.ts`

**Interfaces:**
- `setupAllTriggers()` removes obsolete aliases and provisions one desired handler per job.

- [ ] **Step 1: Add failing trigger-hygiene test**

Assert legacy handler names are listed for cleanup and module code does not call `ScriptApp.newTrigger` during normal job execution.

- [ ] **Step 2: Define cleanup aliases**

Include at minimum:

```js
var TRIGGER_CLEANUP_HANDLERS = [
  "processLogisticsEmails",
  "processLogisticsEmailsV2",
  "scanAndImportWmsTruckingOrders",
  "scanAndImportWmsTruckingOrdersV2",
  "trackSmallParcelsStatusUpdates",
  "syncInventoryModule",
  "enrichImportsFromContainerLog",
  "requestSiteRedeploy"
];
```

Provision only desired current handlers.

- [ ] **Step 3: Remove daily redeploy from steady-state plan**

Operational data refresh must not require code redeployment.

- [ ] **Step 4: Run tests and commit**

Commit: `fix: centralize production Apps Script triggers`.

### Task 7: Deploy Apps Script and verify stabilization

**Files:**
- `.github/workflows/deploy-apps-script.yml` only if verification needs strengthening.

- [ ] **Step 1: Push stabilization branch/PR and require CI**
- [ ] **Step 2: Merge only after tests/typecheck/build succeed**
- [ ] **Step 3: Verify Apps Script deployment workflow succeeds**
- [ ] **Step 4: Run/reprovision `setupAllTriggers()` through the available execution path if supported**
- [ ] **Step 5: Verify PIPELINE LOG after at least one scheduled Gmail cycle**

Success: known `AB221` validation error no longer increments.

- [ ] **Step 6: Verify Korheim remains exactly two legitimate shipments after a subsequent WMS sync window**

Record final counts and timestamps in the completion audit.
