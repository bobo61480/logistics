# Production D1 transition

- [x] TASK-001 Audit the Worker, Sheets, Apps Script, deployment, and dormant schema paths.
- [x] TASK-002 Add a bounded, chunked D1 snapshot schema that respects the 1 MB row limit.
- [x] TASK-003 Add atomic snapshot persistence, current-pointer reads, retention, and health queries.
- [x] TASK-004 Add D1-first reads, a scheduled handler, reconciliation status, and Sheets/cache fallback.
- [x] TASK-005 Expose truthful snapshot storage and database configuration in the operator UI.
- [x] TASK-006 Add database serialization, schema, routing, and regression tests.
- [ ] TASK-007 Activate the production binding, migrations, and 15-minute cron after the Cloudflare token has D1 access.
- [ ] TASK-008 Verify D1-backed production reads and scheduled refresh telemetry.

Current blocker: Cloudflare rejected the GitHub Actions token for D1 list/create with API code `10000`. The existing production Worker remains on the validated Sheets path until the credential gains D1 Edit permission.
