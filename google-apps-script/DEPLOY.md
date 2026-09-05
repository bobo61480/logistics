# Apps Script Deployment Guide

This guide covers **one-time setup** to get the `.gs` files live in the Apps Script
project bound to the LOGISTICS MASTER 2026 spreadsheet, then the **catch-up /
go-live checklist**.

Email ingestion runs on the **V2** pipeline (`GmailPipelineV2.gs`), driven by the
handler `processLogisticsEmailsV2` on a 15-minute trigger. The legacy V1
`GmailPipeline.gs` is retained only as a compatibility shim — the canonical
trigger plan in `Triggers.gs` uses the V2 handlers.

Thread discovery revisits recent matches in each search on every run and rotates
through older matches inside the existing four-day lookback. The searches are
interleaved within the 12-thread budget, so document emails cannot monopolize
the scan. A backlog cursor advances only after its threads have been inspected;
an interrupted run resumes that page. Existing message-level seen/retry keys and
the September 4 replay boundary remain unchanged. `GMAIL V2 RUN` includes
`scanOffsets` so operators can verify that the scan is progressing.

---

## Files to deploy

| File | What it does |
|------|-------------|
| `google-apps-script/Code.gs` | `doPost` web-app handler, WMS importer, inventory transfer |
| `google-apps-script/GmailPipelineV2.gs` | **Canonical** email ingestion: message-level parse → validate → upsert |
| `google-apps-script/GmailPipeline.gs` | Legacy V1 ingestion (compatibility shim; not on the trigger plan) |
| `google-apps-script/zzzzzzzz_GmailSafetyV4.gs` | Explicit Gmail validation, Drive conversion, and D1 refresh helpers |
| `google-apps-script/Triggers.gs` | `setupAllTriggers()` — single owner of every time-driven job |
| `google-apps-script/InventorySync.gs` | Live inventory + KPI dashboard rebuild |
| `google-apps-script/Validation.gs` | Record validation, PENDING VERIFICATION approve/reject workflow |
| `google-apps-script/StatusNormalization.gs` | `canonicalLogisticsStatus_` status vocabulary |
| `google-apps-script/CustomerLookup.gs` | Customer resolution helpers |
| `google-apps-script/CustomerBackfill.gs` | `reconcileCustomerBackfill` daily backfill |
| `google-apps-script/CustomerMatching.gs` | Shared exact/canonical customer matching primitives |
| `google-apps-script/WmsTruckingSyncV2.gs` | `scanAndImportWmsTruckingOrdersV2` WMS trucking import |
| `google-apps-script/zzzzzzzzz_DeduplicationV4.gs` | Canonical operational/audit deduplication helpers |
| `google-apps-script/zzzzzzzzzzz_WmsLocationSafetyV5.gs` | Location-aware WMS identity and cleanup helpers |
| `google-apps-script/appsscript.json` | Manifest: scopes, Drive API v3, V8 runtime |

> Deploy **all** of the above. Option B (clasp) pushes the whole
> `google-apps-script/` directory, so it always stays in sync; Option A is the
> manual fallback.

---

## Option A — Manual copy-paste (fastest, no tools)

Do this once to get the pipeline live immediately.

1. Open the LOGISTICS MASTER 2026 spreadsheet.
2. **Extensions → Apps Script** → the bound script editor opens.
3. For each `.gs` file in `google-apps-script/`, create (or rename) a script file
   with the same name and paste the content. Include every file listed in the
   table above (at minimum `Code.gs`, `GmailPipelineV2.gs`,
   `GmailPipeline.gs`, `zzzzzzzz_GmailSafetyV4.gs`, `Triggers.gs`, `InventorySync.gs`,
   `Validation.gs`, `StatusNormalization.gs`).
4. Open **Project Settings** (⚙ gear icon) → paste the manifest JSON from
   `google-apps-script/appsscript.json` into the **appsscript.json** editor view
   _(tick "Show 'appsscript.json' manifest file in editor" first)_.

5. **Enable Advanced Drive Service:**
   - Left sidebar → **Services (+)** → search "Drive API" → select version **v3** → Add.
   - The identifier must be `Drive` (matches `Drive.Files.create()` calls in `GmailPipelineV2.gs`).

6. **Save all files** (Ctrl+S or ⌘S).

---

## Option B — clasp (automated; syncs on every git push)

### One-time local setup

```bash
# 1. Install clasp globally — PIN to 2.x (clasp 3.x rejects this project's
#    appsscript.json with `Invalid manifest file`).
npm install -g @google/clasp@2.4.2

# 2. Log in (opens browser for Google OAuth)
clasp login

# 3. The Script ID is already committed in .clasp.json:
#      { "scriptId": "1hEQ3gw0…", "rootDir": "google-apps-script" }
#    (get it from Apps Script → Project Settings (⚙) → Script ID if it changes)

# 4. Push all files
clasp push --force
```

### Automate via GitHub Actions (already set up)

The workflow `.github/workflows/deploy-apps-script.yml` runs `clasp push --force`
and updates the existing web-app deployment whenever a file under
`google-apps-script/` (or the workflow / `.clasp.json`) changes on `main`. It
installs a **pinned** `@google/clasp@2.4.2` for the reason noted above.

You need to add **one repo secret**:

1. Run `clasp login` locally → this creates `~/.clasprc.json`.
2. Copy the full JSON content of that file.
3. GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `CLASP_ACCESS_TOKEN`
   - Value: *(paste the ~/.clasprc.json content)*

> The `~/.clasprc.json` access token expires. Re-run `clasp login` and update the secret
> whenever the CI push step fails with a `401 Unauthorized` auth error.

---

## Go-live checklist (run in order, in the Apps Script editor)

After all files are in the editor:

### Step 1 — Grant OAuth scopes

In the Apps Script editor, select `processLogisticsEmailsV2` from the function
dropdown and click ▶ **Run**. A permissions dialog will appear — click
**Review permissions → Allow**. This grants Gmail, Drive, Sheets, and URL Fetch
scopes in one shot.

### Step 2 — Enable Advanced Drive Service (if not done in Option A step 5)

Services (+) → Drive API v3 → Add.

### Step 3 — Set script properties (optional)

**Project Settings → Script properties**:

| Property | Value |
|----------|-------|
| `GITHUB_REPO` | `bobo61480/logistics` *(optional — default)* |

> `requestSiteRedeploy` / `GITHUB_TOKEN` are **obsolete** — live operational data
> no longer requires a code redeploy (`requestSiteRedeploy` is now a no-op shim in
> `Triggers.gs` and is not on the trigger plan). No `GITHUB_TOKEN` is needed.

### Step 4 — Catch up the email backlog

V2 uses a short rolling window: `GMAIL_V2_LOOKBACK_DAYS = 4`
(`GmailPipelineV2.gs`), so on first go-live it only sees the last few days. For a
one-time catch-up:

1. In `GmailPipelineV2.gs`, temporarily raise the window and batch size:
   ```js
   var GMAIL_V2_LOOKBACK_DAYS = 60;   // was 4
   var GMAIL_V2_MAX_THREADS   = 40;   // was 12
   ```
2. Run `processLogisticsEmailsV2` manually 3–5 times until the run stats report
   `threads: 0` (and `budgetHit: false`).
3. Revert both values (`4`, `12`) and save.

### Step 5 — Register all time-driven triggers

Run `setupAllTriggers()` once. This removes legacy handlers and provisions the
canonical plan from `Triggers.gs` (9 triggers):

| Function | Schedule |
|----------|---------|
| `processLogisticsEmailsV2` | every 15 min |
| `processApprovedPending` | every 30 min |
| `scanAndImportWmsTruckingOrdersV2` | every 15 min |
| `processXpoTrackingEmailsV2` | every 15 min |
| `trackSmallParcelsStatusUpdates` | every 1 hour |
| `syncInventoryModule` | every 1 hour |
| `dedupeAllOperationalSheetsV4` | daily at 4 AM |
| `enrichImportsFromContainerLog` | daily at 6 AM |
| `reconcileCustomerBackfill` | daily at 5 AM |

Verify in **Triggers** (clock icon in left sidebar) — you should see all 7.

### Step 6 — Verify the pipeline is running

After the first 15-minute cycle:
1. Check the **PIPELINE LOG** tab in LOGISTICS MASTER 2026 — you should see
   `GMAIL V2 RUN` rows whose detail is the run-stats JSON
   (`threads`, `messages`, `inserted`, `updated`, `pending`, `errors`), plus
   `INGEST COMMIT` rows for auto-matched shipments.
2. Check the **PENDING VERIFICATION** tab — ambiguous emails land here as yellow
   NEEDS REVIEW rows for a human to approve/reject (or approve from the
   dashboard Shipment Notices card).
3. Check **INVENTORY** and **KPI DASHBOARD** tabs after the first hour.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `clasp push` fails in CI: `Invalid manifest file "appsscript.json"` | clasp **3.x** was installed (unpinned) and rejects the 2.x-style manifest | Pin `@google/clasp@2.4.2` in the install step (already done in the workflow) |
| `Drive is not defined` | Advanced Drive Service not enabled | Services → Drive API v3 → Add |
| `You do not have permission` on Gmail | OAuth scopes not granted | Run `processLogisticsEmailsV2` interactively |
| Run stats show `threads: 0` every cycle | `newer_than:4d` window, no matching emails | Temporarily raise `GMAIL_V2_LOOKBACK_DAYS` (Step 4) |
| `clasp push` fails in CI: `401 Unauthorized` | Expired access token | Re-run `clasp login` locally and update `CLASP_ACCESS_TOKEN` secret |
| Triggers clock shows no triggers | `setupAllTriggers()` never run | Run it once in the editor |
