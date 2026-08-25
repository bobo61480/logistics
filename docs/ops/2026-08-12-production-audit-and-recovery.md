# Production Audit and Recovery Plan — 2026-08-12

## Executive finding

The application is an operations control tower for StyleKorean US logistics. It combines inbound shipment documents and statuses, outbound trucking and parcel work, inventory visibility, and invoice-first sales KPIs. Google Sheets are the operational system of record; Gmail and Drive feed the Apps Script ingestion pipeline; the Cloudflare Worker is the canonical read/write gateway and static-site host.

The primary production outage was routing, not an application build failure. The most recent Cloudflare workflow uploaded the Worker successfully but reported `No targets deployed`. The hostname later resolved to a 195-byte OpenResty `Site Unavailable` page, so `/`, appearance routes, and `/api/logistics/*` no longer reached the Worker. `wrangler.toml` had `workers_dev = false` but did not declare a route or custom domain.

## Evidence reviewed

- Production root, appearance routes, health API, and snapshot API.
- GitHub source, deployment workflows, successful/failed Actions runs, Pages settings, and the exact `main` revision.
- Cloudflare Worker routing, source fetches, status-write proxy, generated runtime types, and current Cloudflare configuration guidance.
- `LOGISTICS MASTER 2026`, Nationals, and WMS workbook metadata and bounded live ranges.
- Recent Gmail logistics traffic and attachment-bearing arrival, shipment, packing-list, and invoice threads.
- Apps Script trigger ownership, Gmail V2 ingestion, pipeline logs, inventory synchronization, deployment workflow, and disabled WMS trucking importer.

## Operational conclusions

1. Gmail automation is active. `PIPELINE LOG` showed 15-minute Gmail V2 runs with zero recent errors, plus a current inventory sync.
2. Inbound and inventory data are present. Current IMPORTS rows include August 14 records, and INVENTORY contains thousands of current SKU rows.
3. `Outbound Shipping Schedule` is presently header-only. This is a source-data state, not a frontend parsing failure.
4. Historical WMS import notes explicitly say records were grouped or combined. The WMS importer is disabled, but the frontend still consolidated trucking rows by normalized customer and date. That could hide distinct operational moves and was removed.
5. GitHub Pages, a one-time style-variant generator, and a standalone WMS grouping script duplicated or contradicted the canonical architecture. They were removed from the deployable source.
6. Status writes were functional but accepted oversized input, arbitrary source-sheet names, and unbounded upstream waits. The Worker now validates same-origin browser writes, body and field sizes, editable sheet/kind pairs, and applies an upstream timeout.

## Recovery changes

- Declare `stylekorean.dpdns.org` as the Worker custom domain in Wrangler.
- Use a current compatibility date, `nodejs_compat`, generated Worker types, and sampled observability.
- Keep the Apps Script deployment URL in one configuration location.
- Cache successful operational snapshots at the edge for 60 seconds to reduce nine-sheet fan-out under concurrent use.
- Reject unknown API paths and non-GET health/snapshot requests.
- Preserve every source shipment row as its own UI card; no customer/date consolidation.
- Remove duplicate GitHub Pages deployment, stale Pages CNAME, failed one-time style workflow, and obsolete standalone WMS merge script.
- Update repository operations documentation and add regression assertions for canonical hosting and non-consolidation.

## Validation

- `npm run typecheck`: passed.
- `npm test`: 92 tests passed across 16 files.
- `npm run build`: passed; all six static routes exported.
- Generated Worker runtime/binding types from `wrangler.toml`: passed.
- `npm run verify:production`: expected failure before deployment because the hostname still returns OpenResty rather than the app.

## Deployment caveat

The repository fix makes Cloudflare the hostname source of truth, but the Cloudflare account must own an active zone capable of creating the custom domain. If deployment rejects the hostname because an existing CNAME is managed by the dynamic-DNS provider, remove or replace that conflicting DNS record in the provider/Cloudflare dashboard and rerun the canonical deploy. GitHub Pages should also be disabled in repository settings; deleting its workflow prevents future Actions deployments but does not change the existing repository setting by itself.

## Intentionally not changed

- No live workbook cells were mutated during this audit.
- No Gmail messages, Drive files, or Apps Script triggers were changed.
- The disabled WMS importer remains disabled.
- The direct-Sheets browser path remains as a read-only continuity fallback; status writes still require the same-origin Worker.
