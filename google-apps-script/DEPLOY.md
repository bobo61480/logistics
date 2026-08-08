# Apps Script Deployment Guide

This guide covers **one-time setup** to get all five `.gs` files live in the Apps Script project
bound to the LOGISTICS MASTER 2026 spreadsheet, then the **catch-up / go-live checklist**.

---

## Files to deploy

| File | What it does |
|------|-------------|
| `google-apps-script/Code.gs` | `doPost` web-app handler, WMS importer, inventory transfer |
| `google-apps-script/GmailPipeline.gs` | Email ingestion: archive → parse → upsert |
| `google-apps-script/Triggers.gs` | `setupAllTriggers()`, `requestSiteRedeploy()` |
| `google-apps-script/InventorySync.gs` | Live inventory + KPI dashboard rebuild |
| `google-apps-script/Validation.gs` | Record validation, PENDING VERIFICATION workflow |
| `google-apps-script/appsscript.json` | Manifest: scopes, Drive API v3, V8 runtime |

---

## Option A — Manual copy-paste (fastest, no tools)

Do this once to get the pipeline live immediately.

1. Open the LOGISTICS MASTER 2026 spreadsheet.
2. **Extensions → Apps Script** → the bound script editor opens.
3. For each of the five files below, create (or rename) a script file and paste the content:

   | Editor file name | Source file |
   |-----------------|-------------|
   | `Code.gs` | `google-apps-script/Code.gs` |
   | `GmailPipeline.gs` | `google-apps-script/GmailPipeline.gs` |
   | `Triggers.gs` | `google-apps-script/Triggers.gs` |
   | `InventorySync.gs` | `google-apps-script/InventorySync.gs` |
   | `Validation.gs` | `google-apps-script/Validation.gs` |

4. Open **Project Settings** (⚙ gear icon) → paste the manifest JSON from
   `google-apps-script/appsscript.json` into the **appsscript.json** editor view
   _(tick "Show 'appsscript.json' manifest file in editor" first)_.

5. **Enable Advanced Drive Service:**
   - Left sidebar → **Services (+)** → search "Drive API" → select version **v3** → Add.
   - The identifier must be `Drive` (matches `Drive.Files.create()` calls in `GmailPipeline.gs`).

6. **Save all files** (Ctrl+S or ⌘S).

---

## Option B — clasp (automated; syncs on every git push)

### One-time local setup

```bash
# 1. Install clasp globally
npm install -g @google/clasp

# 2. Log in (opens browser for Google OAuth)
clasp login

# 3. Get the Script ID from the Apps Script editor:
#    Apps Script → Project Settings (⚙) → Script ID (long alphanumeric string)
#    Paste it into .clasp.json:
#      { "scriptId": "YOUR_SCRIPT_ID", "rootDir": "google-apps-script" }

# 4. Push all files
clasp push --force
```

### Automate via GitHub Actions (already set up)

The workflow `.github/workflows/deploy-planner.yml` has a `deploy-apps-script` job that
runs `clasp push --force` whenever a `.gs` file changes on `main`.

You need to add **one repo secret**:

1. Run `clasp login` locally → this creates `~/.clasprc.json`.
2. Copy the full JSON content of that file.
3. GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `CLASP_ACCESS_TOKEN`
   - Value: *(paste the ~/.clasprc.json content)*

> The `~/.clasprc.json` access token expires. Re-run `clasp login` and update the secret
> whenever the CI push step fails with an auth error.

---

## Go-live checklist (run in order, in the Apps Script editor)

After all five files are in the editor:

### Step 1 — Grant OAuth scopes

In the Apps Script editor, select `processLogisticsEmails` from the function dropdown and click ▶ **Run**.
A permissions dialog will appear — click **Review permissions → Allow**.
This grants Gmail, Drive, Sheets, and URL Fetch scopes in one shot.

### Step 2 — Enable Advanced Drive Service (if not done in Option A step 5)

Services (+) → Drive API v3 → Add.

### Step 3 — Set required script properties

**Project Settings → Script properties → Add property**:

| Property | Value |
|----------|-------|
| `GITHUB_TOKEN` | Fine-grained PAT for `bobo61480/logistics` with **Contents: Read & write** permission (needed for `requestSiteRedeploy`) |
| `GITHUB_REPO` | `bobo61480/logistics` *(optional — this is the default)* |

### Step 4 — Catch up the email backlog

The default `newer_than:7d` query misses weeks of backlog.  Do a one-time catch-up:

1. In `GmailPipeline.gs`, temporarily change:
   ```js
   // line 33 — change 7d → 60d
   'has:attachment newer_than:60d -label:sk-logistics/processed ...'
   // line 37 — raise batch size
   maxThreadsPerRun: 50,
   ```
2. Run `processLogisticsEmails` manually 3–5 times until it reports `threads: 0`.
3. Revert both values (`7d`, `20`) and save.

### Step 5 — Register all time-driven triggers

Run `setupAllTriggers()` once.  This provisions 6 triggers:

| Function | Schedule |
|----------|---------|
| `processLogisticsEmails` | every 15 min |
| `processApprovedPending` | every 30 min |
| `scanAndImportWmsTruckingOrders` | every 30 min |
| `syncInventoryModule` | every 1 hour |
| `enrichImportsFromContainerLog` | daily at 6 AM |
| `requestSiteRedeploy` | daily at 7 AM |

Verify in **Triggers** (clock icon in left sidebar) — you should see all 6.

### Step 6 — Verify the pipeline is running

After the first 15-minute cycle:
1. Check the **PIPELINE LOG** tab in LOGISTICS MASTER 2026 — you should see `RUN COMPLETE` rows.
2. Check the **PENDING VERIFICATION** tab — any ambiguous emails land here for review.
3. Check **INVENTORY** and **KPI DASHBOARD** tabs after the first hour.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Drive is not defined` | Advanced Drive Service not enabled | Services → Drive API v3 → Add |
| `You do not have permission` on Gmail | OAuth scopes not granted | Run `processLogisticsEmails` interactively |
| `GITHUB_TOKEN script property not set` | Property missing | Project Settings → Script Properties → add `GITHUB_TOKEN` |
| All threads show 0 results | `newer_than:7d` window, no matching emails | Temporarily change to `newer_than:60d` |
| `clasp push` fails in CI: `401 Unauthorized` | Expired access token | Re-run `clasp login` locally and update `CLASP_ACCESS_TOKEN` secret |
| Triggers clock shows no triggers | `setupAllTriggers()` never run | Run it once in the editor |
