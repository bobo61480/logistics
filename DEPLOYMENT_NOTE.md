# Apps Script deployment reconciliation — 2026-08-07

`google-apps-script/Code.gs` was out of sync with what's actually deployed at
the WRITE_ENDPOINT `/exec` URL used by `app/page.tsx`.

**What was found:**
- Neither the old `google-apps-script/Code.gs` (682 lines) nor `backup/Code.gs`
  (258 lines) matched the code actually running behind the live deployment.
- The old `backup/Code.gs`'s `findInboundTarget_` searched for header names
  `["STATUS", "INBOUND STATUS"]` only — it never included `"WEBSITE STATUS"`,
  the actual column header on the IMPORTS tab. Any deployment running that
  logic would fail to find the status column on every inbound write.
- A live test POST to the deployed `/exec` URL returned an HTML page
  ("Update not completed — Missing or invalid confirmation") whose JS posts
  a result back via `window.postMessage(..., "https://tokkiboi.github.io")`.
  That's the *legacy* static-site domain. This means the current deployment
  is a frozen snapshot from before the migration to the Next.js dashboard —
  editing script source in the Apps Script editor does not update a live
  deployment; it must be redeployed as a new version.

**What was done:**
- `google-apps-script/Code.gs` replaced with the corrected source (provided
  directly from the Apps Script editor), which:
  - Includes `"WEBSITE STATUS"` in both `findInboundTarget_` and
    `findOutboundTarget_` header searches.
  - Fixes a concurrency-guard bug where `"" `/`"SCHEDULED"` default-status
    equivalence was never actually tolerated (dead code path).
  - Fixes `create30MinTrigger()` deleting ALL triggers in the project
    instead of only its own (would have silently killed the Gmail pipeline,
    inventory sync, and container-log triggers from `Triggers.gs`).

**Still required (manual, in the Apps Script editor — script.google.com):**
1. Open the project bound to deployment ID
   `AKfycbwyVnU2jvOtMFXuY7KtX_8-hHXYVLrc6R2Dr_6akdDaTGQPc8duSo7tpguIuk00MjDl`.
2. Confirm the editor's `Code.gs` matches this file (paste this version in
   if it doesn't).
3. Deploy → Manage deployments → edit the existing web app deployment →
   select "New version" → Deploy. This keeps the same `/exec` URL so
   `WRITE_ENDPOINT` in `app/page.tsx` does not need to change.
4. Re-verify with a test status write before trusting it in production.

`backup/Code.gs` is now known-stale relative to this version and should not
be used as a reference; kept only for history.
