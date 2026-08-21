# StyleKorean Control Tower — Rollback Runbook

Date: 2026-08-12

Use this runbook if the completed Control Tower redesign is rejected during operator review or if a production regression appears after release.

## Source rollback anchor

Pre-redesign Git backup branch:

`backup/pre-control-tower-hybrid-20260812`

Pre-redesign commit:

`5a0b6fb568d68e1a430d2ef697adb4f5da832cb8`

Do not delete this branch while the redesigned production version is under review.

## Workbook rollback anchor

Full Google Sheets backup:

`LOGISTICS MASTER 2026 - PRE CONTROL TOWER HYBRID 2026-08-12`

Drive file ID:

`1soRX5LofqTxApLvpTfcTYdCvp4d2h-vowLpMQIseZco`

Prefer targeted data repair over replacing the entire live workbook. The backup is the emergency full-state reference.

## Legacy Apps Script rollback anchor

Legacy project quarantined during duplicate-writer remediation:

`1VeeQiOxQab6vXn9cYfMebRT9awPh1f9Zzq77f15PD241OE2ZaAicVWW5`

Immutable pre-quarantine version:

`Version 1 — PRE-QUARANTINE WH TRUCKING 2026-08-12`

Do **not** restore this project merely to restore the website. Restoring that version also restores obsolete WH Trucking writers and can recreate duplicate rows. Only restore it if the legacy automation itself is intentionally being reinstated and its trigger plan has first been redesigned to prevent duplicate ownership.

## Safe application rollback sequence

1. Capture the current production `main` SHA and current Logistics Master revision before changing anything.
2. Revert the relevant merged PRs or move `main` back through a normal reviewed GitHub change; do not force-push over the audit history unless there is an emergency and repository policy explicitly permits it.
3. Keep the canonical WMS trucking sync disabled unless the rollback specifically requires reintroducing it and there is exactly one writer owner.
4. Allow the standard Cloudflare production workflow to build, test, deploy, and verify the reverted SHA.
5. Run `npm run verify:production` against `https://stylekorean.dpdns.org`.
6. Recheck `WH Trucking Request` for `IN00462238` and `IN00464263` after at least one full legacy 30-minute window. Each invoice should still appear exactly once.
7. Recheck Gmail ingestion logs for deterministic retry loops and validation errors before declaring rollback stable.

## Data-protection constraints

- External WMS source workbooks are read-only from the web application.
- Do not directly rewrite the StyleKorean/WMS workbook as part of rollback.
- Preserve the Logistics Master as the approved write target/registry.
- Do not restore fuzzy multi-invoice grouping logic.
- Do not restore duplicate WMS trucking writers or multiple trigger owners.
- Do not convert the optional D1 binding into a hard runtime dependency during rollback.

## Post-rollback acceptance

A rollback is complete only when:

- unit tests pass;
- TypeScript passes;
- production build passes;
- Cloudflare deploy succeeds;
- all five appearance routes respond;
- `/api/logistics/health` returns `ok: true`;
- `/api/logistics/snapshot` returns `ok: true` with healthy `IMPORTS` and `Outbound Shipping Schedule` sources;
- the two Hayejin invoices remain unique after the automation observation window.
