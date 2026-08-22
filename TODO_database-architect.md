# Database architecture review

- [x] DB-001 Use immutable snapshot metadata plus chunk rows to stay within D1 row limits.
- [x] DB-002 Use prepared statements for all values and an atomic D1 batch for publication.
- [x] DB-003 Index generated time and snapshot-part access paths.
- [x] DB-004 Keep the current pointer separate so incomplete snapshots are never served.
- [x] DB-005 Bound storage with four-snapshot retention while preserving the active snapshot.
- [ ] DB-006 Provision the real database UUID and apply tracked migrations remotely.
