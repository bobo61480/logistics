# StyleKorean Control Tower — Completion Audit

Date: 2026-08-12
Production: `https://stylekorean.dpdns.org`
Repository: `bobo61480/logistics`

## Completed architecture

- Canonical Next.js dashboard remains the single UI implementation.
- Five appearance routes share the same operational data and behavior:
  - `/`
  - `/light-skin`
  - `/light`
  - `/light-full`
  - `/fulfillment-style`
- Cloudflare Worker owns the same-origin operational API:
  - `/api/logistics/health`
  - `/api/logistics/snapshot`
  - `/api/logistics/status`
- External WMS workbooks remain read-only from the web application.
- Approved writes are proxied through the existing Apps Script write endpoint and are source-confirmed.
- KPI calculation is performed inside the coherent Worker snapshot so schedules and KPI values describe one refresh window.
- Parcel carrier resolution uses strong tracking-number evidence first and preserves the source-sheet carrier when the tracking number is ambiguous.
- D1 schema support exists in the repository as an optional audit/read-model layer. Production remains intentionally operational without a D1 binding until the deployment credential has D1 account permission.

## Production automation stabilization

- Gmail ingestion uses the canonical status vocabulary and bounded retry behavior.
- Deterministic spreadsheet validation failures no longer loop indefinitely.
- WMS trucking synchronization is intentionally stopped in the canonical trigger plan.
- `scanAndImportWmsTruckingOrders` and `scanAndImportWmsTruckingOrdersV2` are cleanup-only handlers, not scheduled jobs.
- Small parcel tracking, inventory synchronization, Gmail ingestion, approval processing, and container-log enrichment remain in the canonical trigger plan.

## Duplicate-writer root cause and verification

A second legacy Apps Script project was found writing independently to `WH Trucking Request`:

`1VeeQiOxQab6vXn9cYfMebRT9awPh1f9Zzq77f15PD241OE2ZaAicVWW5`

Before quarantine, an immutable Apps Script rollback version was created:

`Version 1 — PRE-QUARANTINE WH TRUCKING 2026-08-12`

Obsolete WH Trucking append/trigger entry points in that legacy project were replaced with no-op compatibility shims. Customer normalization utilities were left intact.

The authoritative WMS records and the live Logistics Master now agree on:

- `HAYEJIN(CERRITOS)` / `IN00462238` / `08/07/2026` / `$5,129.20`
- `HAYEJIN(CERRITOS)` / `IN00464263` / `08/13/2026` / `$22,954.72`

A delayed verification after both the old 30-minute writer window and the current automation window found exactly one matching row for each invoice. The prior duplicate regeneration did not recur.

The Hayejin address is left blank when no authoritative matching customer/address row exists; the system does not substitute Korheim's address.

## Security and dependency hardening

Unused direct dependencies `build@0.1.4` and `typecheck` were removed. The regenerated dependency graph passed:

- `npm audit --audit-level=moderate`
- unit tests
- TypeScript typecheck
- production Next.js build

## Operator-visible health

The global production-health strip reads `/api/logistics/health` and reports:

- API availability
- write-proxy readiness
- database state

The database state explicitly reports `OPTIONAL / UNBOUND` when D1 is not configured rather than implying a database connection exists.

## KPI presentation accuracy

The UI describes carrier totals as **Freight Spend**, not earnings. The local/regional average bucket is labeled as a heuristic because its implementation uses destination city/ZIP classification and is not a measured mileage radius.

## Production acceptance gate

A release is not considered complete until the exact merged `main` SHA passes the repository production deployment workflow and the live verification checks all five routes plus the Worker health and snapshot APIs. The reusable manual verifier is:

```bash
npm run verify:production
```

Core live snapshot sources that must be healthy are `IMPORTS` and `Outbound Shipping Schedule`.
