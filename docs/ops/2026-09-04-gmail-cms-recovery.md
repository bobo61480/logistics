# Gmail and CMS recovery

## Verified production evidence

Checked on September 4, 2026, Pacific time:

- The main site's health endpoint returns HTTP 200, reports D1 ready, and shows
  recent relational source synchronization. This does not establish CMS health.
- The CMS gateway health endpoint returns HTTP 200 with
  `bootstrapSessionConfigured: true` and `unattendedAuthConfigured: false`.
  Its September sales summary returns HTTP 503 / `CMS_AUTH_NOT_CONFIGURED`.
- The site's sales KPI endpoint returns HTTP 200 with
  `source: wms-sheet-fallback` and `fallback: true`. Those values are not proof
  that CMS invoice acquisition recovered.
- The latest main deployment (GitHub run 33940035459) failed because Vitest
  collected `e2e/dashboard.spec.ts`. The default Vitest configuration was deleted
  from main, allowing Playwright specs into the unit-test run.
- The separate private Sheets mirror (run 33931652319) failed with
  `SERVICE_DISABLED` for the OAuth client's project 1072944905499. Its
  authenticated GViz/export fallbacks also failed. This is a separate path from
  the main Worker's Apps Script refresh, which is still updating D1.
- The live `PIPELINE LOG` contains repeated V7 Gmail runs with zero errors, XPO
  updates/noops and successful subsequent D1 refreshes. However, repeated Gmail
  runs selecting 12 threads with zero new messages led to a code-level coverage
  defect: the first query's initial page crowds out the second query, and neither
  query advances past its initial page.
- The same log contains intermittent fulfillment-source HTTP 302/404 failures,
  long fulfillment runs and lock skips. Those remain a separate investigation;
  successful Gmail runs do not clear them.

## Changes

- Restore unit-test discovery to `tests/**/*.test.ts`, excluding live diagnostic
  tests and browser suites.
- Interleave Gmail query groups, revisit their recent threads every run, and
  advance a bounded backlog cursor only after its page is inspected. Preserve
  the V7 message-level seen/retry keys, four-day lookback, replay cutoff, source
  identity validation, and approval rules. No historical replay reset is part
  of this change.
- Replace the CMS deploy check that accepted any non-404 sales response with a
  verifier requiring HTTP 200, `ok: true`, the requested Pacific month and valid
  aggregate rows. Logs contain safe verification metadata, not upstream bodies.

## Remaining acceptance checks

1. Local installation, typecheck, all 462 unit tests (62 files), and the static
   production build passed on September 4. Follow with canonical deployment and
   live verification; prepared code alone is not a production repair.
2. Verify Gmail `scanOffsets` advance across scheduled runs, each new message is
   committed at most once, ambiguous records still enter review, and any changed
   source rows reach D1. Preserve the existing trigger cadence and deployment ID.
3. Complete CMS credential setup through the approved secret stores. GitHub
   secret names include username/password and a bootstrap cookie, but not
   `CMS_TOTP_SECRET`; the inspected gateway currently lists only the bootstrap
   cookie secret. Do not put credentials in this document or public configuration.
   The authenticator setup seed is distinct from a current six-digit code.
4. Provision the required CMS secrets to the actual gateway and require a real
   sales-summary success, then verify the site's KPI source reports
   `siliconii-cms-invoices` without the WMS fallback.
5. Resolve the separate private Sheets OAuth/API configuration. Local Google
   Cloud CLI authentication requires the user's reauthentication before account
   authority can be checked. Avoid blind reruns of `SERVICE_DISABLED` failures.
6. Investigate fulfillment source failures and long lock occupancy using the
   actual source endpoint and bounded execution/cursor behavior.

The CMS browser session was signed in by the user for inspecting account
settings. No credential or authenticator reset was performed.

## Finding the existing Google Authenticator setup key

The signed-in CMS account's visible menus do not expose MFA enrollment settings.
For the existing Google Authenticator entry:

1. On the phone, open Google Authenticator and choose **Menu → Transfer accounts
   → Export accounts**. Unlock when prompted.
2. Select **only the CMS entry** and continue to its export QR code. Keep the
   existing authenticator entry active.
3. The export QR contains the authentication secret. Do not post it in chat,
   commit it, or upload it to an online decoder. If you can save a copy privately
   on this computer, provide only its local file path so the single CMS entry
   can be decoded locally into the approved secret store. Some phones block
   screenshots of the export screen; do not disable device security to bypass
   that restriction.
4. The required destination is the `CMS_TOTP_SECRET` GitHub Actions secret for
   `bobo61480/logistics`, provisioned to the CMS gateway by its existing workflow.
   A rotating six-digit code cannot replace this setup seed.

If a private export is unavailable, ask the CMS administrator for the supported
authenticator re-enrollment procedure; changing MFA requires the account owner
to complete that enrollment.

Source: [Google Authenticator transfer instructions](https://support.google.com/accounts/answer/1066447).
