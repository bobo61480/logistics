# StyleKorean Logistics Control Tower — Phased Hybrid Redesign Design

## Goal

Turn the existing `stylekorean.dpdns.org` application and `bobo61480/logistics` repository into a reliable operational logistics control tower that continuously combines inbound freight, warehouse receiving, outbound trucking, small parcels, fulfillment/TK, inventory, shipment documents, carrier tracking, Gmail-derived status updates, and logistics KPIs without allowing overlapping automations or weak matching rules to corrupt source data.

The redesign must preserve a safe rollback path and must not write directly to the external WMS workbook. `LOGISTICS MASTER 2026` remains the operational write target during stabilization. A normalized database/read model is introduced behind the application, then individual domains may migrate to database authority only after bidirectional reconciliation is proven.

## Confirmed current-state intent

The production application is intended to provide a 14-day operational view of:

- inbound ocean and air shipments;
- warehouse receiving appointments;
- outbound trucking;
- inbound and outbound small parcels;
- Fulfillment TK orders and packing dimensions;
- inbound inventory, stock on hand, and low-stock visibility;
- shipment/status exceptions;
- live status edits that persist back to operational data;
- MTD/YTD logistics costs, sales, transfers, trucking mix, and carrier metrics;
- automation-fed updates from Gmail, tracking services, WMS source rows, and inventory sync jobs.

The application therefore behaves as an operational system, not a passive reporting page.

## Non-negotiable constraints

1. External WMS / Stylekorean workbook remains read-only.
2. During stabilization, writes go only to the approved Logistics Master / Apps Script paths or to the Fulfillment source where that existing integration is authoritative.
3. No automation may merge shipments across different exact ship dates merely because an invoice/customer token overlaps.
4. Terminal states must not be automatically moved backward without an explicit operator override.
5. Low-confidence parsing or matching must go to review/exception state, not overwrite operational data.
6. Every automated write must be idempotent and auditable.
7. Production changes must retain a rollback point and pass unit, type, build, deployment, and live-behavior verification.

## Target architecture

### Operational source layer

Initial authoritative operational sources remain:

- `LOGISTICS MASTER 2026` for imports, trucking requests, schedules, inventory support tabs, review queues, and logs;
- WMS `Stylekorean` sheet as read-only outbound/wholesale source;
- Nationals workbook as read-only national-order source;
- Fulfillment GAS endpoint as the existing authoritative Fulfillment/TK source until that domain is migrated intentionally;
- Gmail as an observation/input source, never an authority by itself;
- carrier/container tracking as observation/input sources.

### Ingestion/adapters

Each source gets a narrow adapter that converts raw source data into canonical records. Adapters must not contain UI logic and must not directly merge unrelated records. Expected adapters:

- Imports adapter
- WMS outbound adapter
- Nationals outbound adapter
- WH Trucking adapter
- Inventory adapter
- Fulfillment TK adapter
- Gmail logistics parser
- Parcel/freight tracking adapter
- Ocean/container tracking adapter

### Normalization and identity

Canonical entity identities are required before deduplication.

#### Shipment

Primary identity is domain-specific and evidence-ranked:

- inbound ocean/air: explicit shipment number, container, MBL/HBL, filing number;
- WMS trucking: canonical customer + exact normalized ship date, with invoices as members of that exact group;
- parcel: normalized tracking number;
- fulfillment: invoice/order identifier.

Weak substring matches never create identity by themselves.

#### Product inventory

Identity preference:

1. SKU
2. UPC/barcode
3. normalized product name only as a fallback requiring review when ambiguous.

#### Status

One canonical vocabulary must be shared by UI, Apps Script, data validation, database, tests, and tracking/Gmail normalization. Canonical states include:

- Scheduled
- Work in Progress
- Pending
- Shipping
- Shipped
- Delivered
- Received
- Cancelled
- Completed
- Customs Clearance
- FDA Review / Hold
- FWS Review / Hold
- FDA Detained
- AQI Examination
- Delayed

Aliases such as `FDA HOLD`, `FDA Review/Hold`, `FDA REVIEW`, and `FDA Review / Hold` normalize to `FDA Review / Hold` before validation or write.

### Decision pipeline

Every automation follows the same stages:

`Observe -> Extract -> Normalize -> Match -> Validate -> Decide -> Write -> Verify -> Audit`

The Decide stage yields exactly one of:

1. high-confidence automatic commit;
2. pending verification;
3. rejected/exception without operational mutation.

### Event/audit ledger

Introduce an append-only event shape for all automatic and manual mutations:

- event id
- source
- entity type
- stable entity id
- source record/message/tracking id
- previous value
- proposed/new value
- confidence
- decision
- actor/automation
- timestamp
- attempt count
- last error
- next retry time
- correlation id
- verification result

Initially this can be materialized in Logistics Master logging/review tabs and mirrored into the normalized database. The long-term database ledger becomes the primary observability mechanism.

## Phased hybrid database/read model

The database is introduced first as a normalized read model and audit store, not immediately as the master write store.

Suggested normalized tables/entities:

- `shipments`
- `shipment_references`
- `shipment_status_events`
- `shipment_documents`
- `shipment_tracking_events`
- `trucking_moves`
- `parcel_shipments`
- `fulfillment_orders`
- `fulfillment_dimensions`
- `inventory_products`
- `inventory_lots`
- `inventory_movements`
- `source_records`
- `automation_runs`
- `automation_events`
- `review_queue`
- `kpi_snapshots`

Every normalized record stores source provenance and source revision/update metadata so reconciliation can compare database state with Sheets without guessing.

### Reconciliation rules

During hybrid operation:

1. Sheets remain authoritative for operational fields that operators currently edit.
2. Database ingest records the observed source value and source revision/hash.
3. Web writes are validated, written through the approved source path, reread/confirmed, then reflected in the database.
4. Database-versus-source differences that were not produced by a known event are surfaced as reconciliation exceptions.
5. No database record overwrites a newer Sheet value solely because it is older/newer by timestamp; source ownership decides authority.
6. A domain migrates to database authority only after read parity, write parity, replay safety, and rollback are proven for that domain.

## Immediate production stabilization

### Gmail failure loop

Current Gmail V2 runs repeatedly fail when parsed status text does not exactly match strict IMPORTS column AB validation. The immediate repair must:

- normalize inbound status before calling `setValue`;
- keep the spreadsheet validation strict;
- ensure `FDA Review / Hold` and other allowed canonical values match the Sheet vocabulary exactly;
- record deterministic validation failures once in review/error state instead of retrying the same mutation every 15 minutes indefinitely;
- replay the currently failing ES18/ES19/ES27 messages after the fix;
- mark messages seen only after their intended disposition is safely recorded;
- keep legal/disclaimer text from causing false terminal status detection.

### WH Trucking / Korheim duplicate class

Complete the approved repair design:

- preserve the valid `KORHEIM (CERRITOS)` / `IN00464263` / `08/13/2026` row;
- retain exactly one legitimate `IN00462238` / `08/07/2026` row at `$5,129.20`;
- delete only confirmed malformed duplicates;
- remove the unsafe competing legacy importer implementation;
- enforce canonical customer + exact ship date identity;
- clean both legacy and V2 installed triggers before installing one V2 trigger;
- guarantee repeated-run idempotency.

### Trigger ownership

`setupAllTriggers()` becomes the only production time-trigger provisioner.

Modules may expose health checks but may not silently create duplicate schedule triggers. Provisioning removes obsolete handler names before creating the desired plan.

The daily `requestSiteRedeploy()` job is removed unless the Cloudflare production workflow intentionally supports the repository-dispatch contract. Live operational data should not require a code redeploy.

### Retry behavior

Automation events use bounded retry with classification:

- transient network/provider errors: retry with backoff;
- deterministic validation/matching errors: move to review immediately;
- terminal/conflicting source states: do not retry destructive mutation;
- already-applied/idempotent result: record noop success.

## Web application architecture

The current monolithic `app/page.tsx` should be decomposed by responsibility while preserving one canonical data/write implementation shared by visual variants.

Recommended modules:

- `lib/domain/status.ts` — status vocabulary, normalization, transitions
- `lib/domain/identity.ts` — shipment/tracking/product identity helpers
- `lib/domain/carriers.ts` — tracking-number-first carrier inference with source fallback
- `lib/adapters/*` — source-specific parsing
- `lib/kpis/*` — KPI calculation and labels
- `lib/api/*` — snapshot/write client
- `app/components/control-tower/*` — dashboard visual components
- `app/components/automation-health/*` — pipeline health
- `app/components/schedules/*` — inbound/outbound/parcel boards
- `app/components/inventory/*` — inbound/stock/low-stock

No route should duplicate business logic. Appearance routes wrap/recompose the same data components.

### Operational snapshot

The web app should consume one coherent operational snapshot containing:

- generation timestamp
- source freshness/health
- shipments
- parcel shipments
- fulfillment data
- inventory
- KPIs
- automation health
- exceptions/review counts

Until a server/API deployment path is introduced, the static site may use a single Apps Script/edge endpoint for this snapshot. The existing static export must not pretend same-origin `/api/*` routes exist when they are absent.

### Write path

Status/dimension/manual commands require:

- explicit entity/source identity;
- expected current status/revision when available;
- canonical validation;
- source write;
- post-write readback/confirmation;
- audit event;
- user-facing conflict/error response.

Legacy fallback is allowed only for transport/unavailability errors, never validation or concurrency conflicts.

## Carrier and tracking logic

Use tracking-number-first detection only for high-confidence patterns, then preserve the source carrier when the number is ambiguous.

Examples:

- `1Z...` -> UPS
- `TBA...` -> Amazon
- `JD/JJD...` -> DHL
- strong USPS formats -> USPS
- ambiguous generic numeric -> retain supplied source carrier

Store `sourceCarrier`, `detectedCarrier`, and `effectiveCarrier` when practical. A strong tracking pattern may override a conflicting source carrier; ambiguous detection never does.

Outbound parcel/PRO tracking from the existing open PR should be reconciled into this shared carrier/status layer instead of merged blindly.

## KPI corrections

KPI names and formulas must communicate what is actually calculated.

Required corrections/audit:

- WMS wholesale MTD/YTD includes all valid numeric invoice amounts across shipping methods;
- `Carrier earnings` is renamed to carrier spend/cost unless there is a real revenue basis;
- `local <=50 mi` should either use a real distance model or be relabeled as the current city/ZIP heuristic;
- LTL/FTL classification should prefer explicit source classification before heuristic inference;
- cost calculations keep invoice-first/rate-fallback semantics only where the freight source columns actually represent those concepts;
- every KPI has a test fixture with date boundaries and invalid text/FOC/sample handling.

## Fulfillment TK integration

Fulfillment remains a first-class operational domain. Existing functions for picking, inspection, moved-to-packing, dimensions, and source detail remain supported.

Changes:

- reuse common error/freshness/health display conventions;
- surface last sync and endpoint failure state in automation health;
- route mutations through a typed command boundary where possible;
- keep source-specific details/dimensions without duplicating the logistics dashboard state model;
- preserve the source-inspired visual card/table semantics already implemented.

## Control Tower UI redesign

The redesigned primary interface should prioritize action rather than raw data density.

Top hierarchy:

1. global header + appearance selector;
2. source/automation health strip;
3. current 14-day operational summary;
4. exception/action queue;
5. inbound arrivals and receiving;
6. outbound trucking and parcels;
7. Fulfillment TK progress;
8. inventory + low-stock/incoming coverage;
9. KPIs and analytical detail;
10. audit/review links.

The existing Original and Fulfillment appearances remain available while a new Control Tower light experience is built. The three requested light treatments may remain comparison routes until the preferred one is selected.

The visual system should favor:

- clear hierarchy;
- compact but readable tables;
- consistent status chips;
- fewer duplicated legends;
- sticky/contextual filters where useful;
- explicit stale/error states;
- responsive layouts;
- accessible controls and focus states;
- minimal decorative chrome that competes with operational exceptions.

## Performance design

- avoid re-fetching the same Sheet multiple times for schedules and KPIs;
- build KPIs from the same normalized snapshot when possible;
- centralize polling rather than letting components independently poll overlapping sources;
- retain a visible refresh control;
- use freshness timestamps per source;
- do not redeploy the static site to refresh live operational data;
- split large client components and memoize derived views around stable normalized records;
- keep fulfillment polling isolated to its source until incorporated into the central snapshot.

## Backup and rollback

Before production implementation:

1. create a Git branch `backup/pre-control-tower-hybrid-20260812` pointing to the pre-redesign `main` state;
2. create a full Drive copy of `LOGISTICS MASTER 2026` before destructive live-sheet cleanup;
3. keep the existing production deployment available until the new implementation passes live checks;
4. isolate development on a feature/audit branch;
5. record any live-sheet cleanup ranges and retained canonical rows in the audit log/spec;
6. never delete the backup branch during this project.

Rollback consists of restoring the backup Git state/deployment and, only if required for data recovery, copying confirmed affected sheet rows from the Drive backup rather than blindly replacing the whole workbook.

## Verification strategy

### Automated code verification

- unit tests for normalization, identity, carrier classification, KPI boundaries, and status transitions;
- regression tests for Korheim 08/07 vs 08/13 separation and second-run idempotency;
- Gmail regression for `FDA Review/Hold` -> `FDA Review / Hold` without validation failure;
- typecheck;
- production static build;
- E2E smoke tests for `/`, light routes, fulfillment route, search/filter, status UI, and key panels.

### Live production verification

After deployment verify:

- `/`, `/light`, `/fulfillment-style`, and any new comparison routes return successfully;
- the style selector works;
- operational data loads rather than only static HTML;
- source freshness timestamps advance;
- one safe test/noop status readback path succeeds where possible;
- Gmail error count stops increasing for the known deterministic validation failure;
- WMS trucking sync does not append new Korheim duplicates;
- imports beyond the previous 08/14 issue remain visible according to ETA rules;
- parcel `1Z` tracking resolves UPS;
- Fulfillment TK loads and dimensions/details remain accessible;
- inventory panels load;
- KPI values are non-error and derived from current sources.

## Implementation order

### Wave 0 — Preserve

- Git backup branch
- Drive copy of Logistics Master
- current config/source inventory

### Wave 1 — Stop active failures

- canonical status module/helper for Apps Script and web vocabulary
- Gmail validation-loop repair and safe replay
- Korheim live cleanup + importer/trigger repair
- trigger ownership cleanup
- remove stale temporary sheet and dead redeploy contract only after confirming they are unused

### Wave 2 — Normalize current application

- shared carrier/identity/status modules
- reconcile outbound tracking PR
- split source adapters from `page.tsx`
- remove impossible static `/api` assumptions or introduce a real reachable snapshot endpoint
- consolidate data loading and KPI reads

### Wave 3 — Hybrid read model

- add database schema/read model and event ledger
- ingest normalized snapshots
- reconciliation reporting
- application reads normalized snapshot with Sheets fallback during parity period

### Wave 4 — Control Tower redesign

- automation-health and exception queue
- Control Tower light layouts
- improved navigation/responsiveness/accessibility
- maintain Original/Fulfillment comparison routes

### Wave 5 — Production hardening

- CI/E2E/live verification
- deployment observability
- compare with backup
- document rollback

## Definition of done

The project is complete when:

- active deterministic Gmail failures are fixed and no longer repeat;
- the Korheim duplicate class is removed from live data and cannot reproduce under unchanged source input;
- production trigger ownership is singular and documented;
- stale/dead deployment contracts and temporary artifacts are removed or explicitly quarantined;
- carrier inference uses strong tracking evidence with source fallback;
- KPIs are labeled and tested according to real formulas;
- the frontend uses clear module boundaries and a coherent operational snapshot strategy;
- automation health and exceptions are visible;
- requested visual variants remain usable;
- full test/type/build verification passes;
- production deployment is independently checked;
- Git and Drive rollback points are retained for user review.
