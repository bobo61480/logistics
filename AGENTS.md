# StyleKorean Logistics Planner — Agent Instructions

**What this is:** A static Next.js app served by a Cloudflare Worker. Google Sheets remain the synchronized operational source, while Cloudflare D1 is the exclusive frontend/read-model source. The Worker refreshes and deduplicates approved Sheet/App Script data into D1, exposes same-origin APIs, serves the static export, and coordinates approved status updates across Google Sheets and D1.

Live site: `stylekorean.dpdns.org`

## Build & Validation

```bash
npm run typecheck   # TypeScript check — run after any .ts/.tsx change
npm run build       # Full static export (out/) — catches layout/render errors
npm run dev         # Local dev server at localhost:3000
npm test            # Unit tests (vitest)
npm run test:e2e    # Playwright e2e — builds out/ and drives it in Chromium
```

Run `typecheck` and `npm test` before every commit. The project uses `"strict": true`.

## Tests

- **Unit** (`tests/`, vitest): cover domain/status rules, source normalization, deduplication, KPI math, Worker routing, carrier adapters, and production hardening.
- **E2E** (`e2e/`, Playwright): serve the real static export (`e2e/static-server.mjs`) and intercept external source traffic with fixtures. Tests never mutate live workbooks.
- CI: `.github/workflows/ci-pr.yml` runs unit tests, type checking, and the production build on pull requests. `.github/workflows/deploy-cloudflare.yml` repeats those checks before the canonical production deploy and verifies the live custom domain/D1 APIs afterward.

## Architecture

- **`output: "export"`** — the UI is a static export. Cloudflare handles server-side API routes and assets; do not add Next.js API routes.
- **Frontend authority:** browser → same-origin Worker snapshot API → Cloudflare D1. The browser must never bypass D1 by reading Google Sheets as an operational fallback.
- **Source refresh:** Worker → approved Apps Script/Google Sheets sources → normalization/deduplication → D1. During a short source outage, serve the last good D1 snapshot with an explicit stale marker rather than changing data authority.
- **D1 shape:** every grid-shaped sheet source is stored row-by-row in `sheet_rows`, keyed by `(source_key, row_index)` and fingerprinted by a content hash, so a refresh writes only the rows that changed. The non-grid remainder (source health, KPIs, GViz tables, ingestion events, CMS projections) stays in the chunked `operational_snapshot*` tables behind the atomic `current_snapshot` pointer. Reads merge the two, with relational rows winning.
- **Status writes:** browser → same-origin Worker status API → Google Sheets → confirmed D1 update → edge-cache invalidation. The D1 half is a single-row `UPDATE` in `sheet_rows`, not a snapshot republish. A successful response means both stores were reconciled; do not add a D1-only or Sheet-only success path.
- **Tracking:** carrier credentials remain server-side. UPS, FedEx, USPS, and DHL Unified are supported adapters. Amazon Shipping tracking is not live until purchased-shipment `trackingId` and required `carrierId` are stored together.
- **Siliconii CMS:** only approved reduced inventory projections may enter the public snapshot. Do not expose raw CMS outbound/order records without an authenticated surface and an explicit allowed-field contract.
- Auto-refresh: every 30 minutes (`AUTO_REFRESH_MS`), with D1 refresh handled independently by the Worker/cron.

## Key Files

| File | Purpose |
|------|---------|
| `app/page.tsx` | Main UI — D1-backed schedules, filters, KPI panels, status editor |
| `app/live-map.tsx` | Shared carrier tracking poll + shipment map |
| `app/inventory-reconciliation-card.tsx` | Warehouse vs Siliconii inventory comparison |
| `worker/index.ts` | D1 snapshot/health/reconciliation router and scheduled refresh |
| `worker/sheet-store.ts` | Relational `sheet_rows` mirror: delta sync, row reads, single-row writeback |
| `worker/snapshot-cache.ts` | Edge cache in front of the D1 snapshot (put / read / invalidate) |
| `worker/database.ts` | Chunked snapshot metadata, health, confirmed status writeback, audit events |
| `worker/sources.ts` | Server-side source acquisition and normalization |
| `worker/status-command.ts` | Strict Google Sheets + D1 status write path |
| `worker/carrier-tracking.ts` | UPS/FedEx/USPS/DHL provider adapters |
| `worker/cms-inventory.ts` | Restricted Siliconii inventory projection |
| `lib/sales-kpis.ts` | KPI parsing and calculation |
| `google-apps-script/Code.gs` | Apps Script bound to LOGISTICS MASTER 2026; handles approved operations |
| `archive/legacy-static-site/` | Historical reference only; never deploy from here |

## Google Sheets IDs

| Sheet | ID |
|-------|-----|
| LOGISTICS MASTER 2026 (main) | `1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc` |
| Nationals | `12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8` |
| WMS/Sales | `14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I` |

Tabs written by Apps Script include `WH Trucking Request`, `B2B/E-COM TRUCKING`, `TRANSFERS`, `ULTA`, `IHERB`, `IMPORTS`, `NATIONAL ORDER PROGRESS`, `Outbound Shipping Schedule`, `TJX/ROSS`, and `TRUCKING`. Preserve source-row identity for writes and check canonical keys before appending.

## Status Values

Outbound: `"" | "SCHEDULED" | "WORK IN PROGRESS" | "PENDING" | "SHIPPING" | "SHIPPED" | "DELIVERED" | "RECEIVED" | "CANCELLED" | "COMPLETED"`

Inbound adds: `"N/A" | "Customs Clearance" | "FDA Review/Hold" | "FWS Review/Hold" | "Delayed"`

## Deployment

Push to `main` → `.github/workflows/deploy-cloudflare.yml` validates and deploys the Worker plus static export to the custom domain configured in `wrangler.toml`. Changes under `google-apps-script/` independently run `.github/workflows/deploy-apps-script.yml`.

GitHub Pages is not a production target. Keep the repository's Pages feature disabled so it cannot contend for the Cloudflare hostname.

## Common Pitfalls

- Do not create backup/copy sheets, nested repository copies, parallel data stores, or duplicate event feeds. Use version history, audit logs, and deterministic deduplication instead. A second Worker entry point or a second D1 schema is a parallel data store — `worker/` and `migrations/` are the only ones.
- Do not republish the whole snapshot to record a single change. Writebacks target one relational row.
- Update `APPS_SCRIPT_WRITE_URL` in `wrangler.toml` only if the Apps Script deployment ID is intentionally replaced. Normal clasp deployments update the existing ID.
- Do **not** add `export const runtime = "edge"` or other server-side Next.js constructs — `output: "export"` will break the build.
- Do not add a Pages `CNAME`; `wrangler.toml` is the production hostname source of truth.
- Do not reintroduce browser direct-Sheets fallback. D1 is the frontend authority even during source outages.
- Do not treat carrier proof-of-delivery/photo fields alone as delivery confirmation; use authoritative provider status/events.
- Do not send arbitrary Amazon `TBA...` values to Shipping v2. Its tracking contract requires the purchased shipment's matching `carrierId`.
- `archive/legacy-static-site/` is reference-only.

## Migration Notes

See [CANONICAL_NEXTJS_MIGRATION.md](./CANONICAL_NEXTJS_MIGRATION.md) for migration history. Historical plans may describe superseded architectures; current runtime code, tests, this file, and production verification take precedence.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
