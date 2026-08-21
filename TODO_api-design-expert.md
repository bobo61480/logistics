# API design review

- [x] API-001 Keep the existing same-origin `/api/logistics/snapshot` contract backward compatible.
- [x] API-002 Add `storage`, `storedAt`, and truthful stale metadata without breaking consumers.
- [x] API-003 Add read-only `/api/logistics/reconciliation` with explicit configured/ready states.
- [x] API-004 Preserve method validation and no-store semantics for health and reconciliation.
- [x] API-005 Keep database failures internal and fall back to the source-of-record path.
