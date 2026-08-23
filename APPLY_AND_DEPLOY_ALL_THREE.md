# Apply and deploy — all three apps

**Sandbox note:** this environment had no network access this session (npm registry
returned `host_not_allowed`), so none of this was run through `npm run typecheck` /
`npm test` / `npm run build`. I hand-reviewed every edit (brace/paren balance,
`.gs` syntax via `node --check`, cross-file consistency), but **you need to run the
real toolchain locally before pushing anything** — commands are below for each repo.

---

## 1. `bobo61480/logistics` (stylekorean.dpdns.org)

**What changed:** Gmail-ingestion review can now be approved/rejected from the
dashboard instead of only by editing the PENDING VERIFICATION sheet directly;
colorful folder icons (vs. plain file icons) on real Drive folder links; confirmed
and tidied the existing cross-app platform nav.

```bash
cd /path/to/logistics
git checkout main && git pull
unzip -o logistics-changed-files.zip -d .   # overwrites the 13 files listed below
npm ci
npm run typecheck   # must pass clean
npm test            # all should pass now — no known pre-existing failures in the files touched
npm run build
```

Files touched: `worker/sources.ts`, `worker/pending-review-command.ts` (new),
`worker/database.ts`, `worker/index.ts`, `app/page.tsx`,
`app/gmail-ingestion-card.tsx`, `app/drive-archive-card.tsx`,
`app/style-switcher.tsx`, `app/style-variants.module.css`,
`google-apps-script/Code.gs`, `google-apps-script/Validation.gs`,
`tests/control-tower-light-variants.test.ts`, `tests/style-variants.test.ts`.

```bash
git add -A
git commit -m "Add dashboard approve/reject for Gmail review rows; colorful Drive folder icons; platform nav parity"
git push
```

Pushing triggers the Cloudflare deploy workflow for the site itself. **Code.gs and
Validation.gs need the same manual redeploy step as last time** — pushing to `main`
alone does not update the live `/exec` endpoint:

1. Open the Apps Script project bound to LOGISTICS MASTER 2026.
2. Paste in the updated `Code.gs` and `Validation.gs`.
3. Deploy → Manage deployments → edit the existing deployment → **New version** → Deploy.
4. Verify: `curl -X POST "$APPS_SCRIPT_EXEC_URL" -d '{"action":"reviewPending","reviewKey":"test","decision":"approve"}'`
   should return `{"ok":false,"error":"That review row is no longer open..."}` (a
   real, well-formed rejection — proves the new branch is live, not a fallback to
   the old "Source sheet not found" error from the legacy path).

---

## 2. `bobo61480/skwarehouse` (skwarehouse.dpdns.org)

**What changed:** this app was missing the Gmail-ingestion pipeline and the
carrier/freight/event-map analytics that skwbp already had — ported that whole
feature set over for parity, plus the cross-app nav and an orphaned `CNAME`
cleanup.

```bash
cd /path/to/skwarehouse
git checkout main && git pull
unzip -o skwarehouse-changed-files.zip -d .
rm -f CNAME   # moved to archive/legacy-github-pages/CNAME — delete the old root copy
npm ci
npm run typecheck
npm test      # includes new assertions for the ported Gmail/analytics parity
npm run build
git add -A && git rm --cached CNAME 2>/dev/null
git commit -m "Port Gmail ingestion + analytics parity from skwbp; add cross-app nav; archive dead CNAME"
git push
```

**New GitHub repository secrets required** (Settings → Secrets and variables →
Actions) for the ported Gmail pipeline to actually activate on deploy — without
these, the workflow's new step just logs "not configured" and Gmail ingestion
stays disabled (same graceful-degradation behavior skwbp already has):
- `GMAIL_INGEST_TOKEN` — must match the token you put in `GmailIngestion.gs`'s
  Script Properties for the `skwarehouse.dpdns.org` target (see §4 below).
- `GOOGLE_STATUS_WEBHOOK_URL` / `PLANNER_STATUS_TOKEN` — same values already
  configured for skwbp, since both point at the same `StatusWriteback.gs`
  deployment bound to LOGISTICS MASTER 2026.

---

## 3. `bobo61480/skwbp` (skwbp.dpdns.org)

**What changed:** `GmailIngestion.gs` now fans out to both warehouse mirrors from
one Gmail scan instead of only posting to skwbp; cross-app nav added; the five
orphaned legacy static files at repo root (`admin.html`, `app.js`,
`database-config.js`, `index.html`, `platform-config.js` — confirmed unreferenced
by anything in the actual Next.js/Worker build) moved into
`archive/legacy-static-site/`, matching the same pattern already used in
`bobo61480/logistics`.

```bash
cd /path/to/skwbp
git checkout main && git pull
git rm admin.html app.js database-config.js index.html platform-config.js
unzip -o skwbp-changed-files.zip -d .
npm ci
npm run typecheck
npm test
npm run build
git add -A
git commit -m "Fan out Gmail ingestion to both warehouse mirrors; add cross-app nav; archive dead legacy static site"
git push
```

---

## 4. One-time Gmail Apps Script update (shared, singleton project)

`GmailIngestion.gs` is a **single script**, installed once in whichever Apps
Script project owns the logistics Gmail account — not one-per-repo. It now posts
to *both* `skwbp.dpdns.org` and `skwarehouse.dpdns.org` from the same 15-minute
scan instead of just skwbp, tracking acceptance **per target** so a transient
failure on one mirror doesn't lose the message for the other.

1. Open that Gmail account's Apps Script project.
2. Replace the installed `GmailIngestion.gs` with the updated version (identical
   copies now live in both repos for reference — either works).
3. In **Script Properties**, set `SKW_GMAIL_INGEST_TARGETS` to:
   ```json
   [
     {"url":"https://skwbp.dpdns.org/api/warehouse/gmail-ingest","token":"<skwbp's GMAIL_INGEST_TOKEN>"},
     {"url":"https://skwarehouse.dpdns.org/api/warehouse/gmail-ingest","token":"<skwarehouse's GMAIL_INGEST_TOKEN>"}
   ]
   ```
   (If you skip this, `installSkwGmailIngestion()` seeds it automatically with
   both URLs and empty tokens — which means both targets get silently skipped
   until you fill the tokens in, never an unauthenticated call.)
4. Run `installSkwGmailIngestion()` once from the Apps Script editor to
   reset the trigger and do an immediate first pass.

---

## What I did *not* touch, and why

- **`build-d1-import.mjs`'s validation logic genuinely differs** between
  skwarehouse (requires the upstream stylekorean snapshot to already be D1-backed)
  and skwbp (tolerates a Sheets-fallback upstream). That's a real, separate design
  decision, not drift — I left it as-is rather than silently unifying it.
- **No literal shared database** between the three apps. "Shared data source" here
  means skwarehouse and skwbp each independently mirror stylekorean's snapshot on
  a 15-minute cron into their own isolated D1 — which was already the deliberate
  architecture (see `skwbp`'s `LINKING_NOTES.md`: "no shared Worker, no shared
  database"). I kept that; the parity work was about *feature* gaps, not the
  sharing model itself.
