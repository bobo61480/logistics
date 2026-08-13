# Backend architecture review

- [x] BACKEND-001 Separate source acquisition, database persistence, routing, and status writes.
- [x] BACKEND-002 Make D1 the preferred read model only when its binding exists.
- [x] BACKEND-003 Refresh on a 15-minute schedule and avoid blocking stale snapshot responses.
- [x] BACKEND-004 Retain four immutable snapshots and update the current pointer atomically.
- [x] BACKEND-005 Preserve Cache API and direct Sheets continuity paths.
- [ ] BACKEND-006 Activate D1 after the Cloudflare credential is corrected.
