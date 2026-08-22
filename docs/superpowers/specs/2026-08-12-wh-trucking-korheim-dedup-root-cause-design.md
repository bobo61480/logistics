# WH Trucking Request Korheim Duplicate Root-Cause Repair Design

## Goal

Repair `LOGISTICS MASTER 2026` → `WH Trucking Request` so the repeated `KORHEIM (CERRITOS)` rows are removed, the two legitimate WMS trucking shipments remain separated by exact ship date, and the importer can no longer recreate the corruption on subsequent scheduled runs.

## Confirmed incident

The WMS source contains two distinct Cerritos trucking shipments:

- `IN00462238` — ship date `08/07/2026` — invoice amount `$5,129.20`
- `IN00464263` — ship date `08/13/2026` — invoice amount `$22,954.72`

The target sheet currently contains one valid `IN00464263` row on `08/13/2026`, plus a long duplicate region beginning at row 687 where `IN00464263` and `IN00462238` were merged together and assigned to `08/07/2026` with the `$5,129.20` value.

## Root cause

The legacy WMS importer in `google-apps-script/Code.gs` can select an existing row by invoice number without first requiring the same exact customer/date group. After that match, it merges invoice numbers and computes the target ship date from the earliest source date among the merged invoices. This allows a later shipment to be pulled into an older shipment row.

The Apps Script source also exposes duplicate global entry points named `scanAndImportWmsTruckingOrders()`: one legacy implementation in `Code.gs` and one compatibility wrapper in `zz_WmsTruckingCompatibility.gs`. Although the current trigger plan calls `scanAndImportWmsTruckingOrdersV2()` directly, keeping two global implementations of the legacy name makes execution dependent on Apps Script source resolution and leaves room for an older installed trigger to invoke the unsafe path.

## Repair scope

### 1. Live sheet repair

Repair only `LOGISTICS MASTER 2026`; do not write to the external WMS workbook.

For the corrupted Cerritos incident:

- preserve the valid `KORHEIM (CERRITOS)` / `IN00464263` / `08/13/2026` shipment row;
- reduce the repeated `08/07/2026` duplicate region to exactly one legitimate shipment for `IN00462238`;
- ensure the retained `08/07/2026` row contains only `IN00462238` and `$5,129.20`;
- preserve the existing Cerritos address and standard row formulas, formatting, and data validation;
- remove the other repeated corrupted copies from the sheet.

The cleanup must target the confirmed duplicate signature rather than deleting arbitrary nearby rows.

### 2. Remove the unsafe legacy importer path

In `google-apps-script/Code.gs`, remove or rename the legacy `scanAndImportWmsTruckingOrders()` implementation so it cannot be invoked as a production entry point.

Keep a single backward-compatible `scanAndImportWmsTruckingOrders()` wrapper in `google-apps-script/zz_WmsTruckingCompatibility.gs` that delegates to `scanAndImportWmsTruckingOrdersV2()`.

### 3. Harden V2 matching

`scanAndImportWmsTruckingOrdersV2()` must treat the canonical key as:

`canonical customer + exact normalized ship date`

Rules:

- an invoice match may select a target row only when that row already has the same exact canonical customer/date key;
- an invoice found on a different ship date must never authorize reuse or merging;
- invoice retention/repair must remove source-known invoices that belong to another exact source group;
- completed/terminal rows remain untouched;
- repeated runs with unchanged source data must be idempotent and append zero additional rows.

### 4. Trigger hygiene

Trigger provisioning must remove installed triggers for both the legacy handler name and the V2 handler name before creating one current V2 trigger.

The intended steady state is one WMS trucking sync trigger path, executing `scanAndImportWmsTruckingOrdersV2()` every 15 minutes.

## Data-flow constraints

- External WMS workbook: read-only.
- Logistics Master: permitted repair/write target.
- Existing canonical customer normalization remains in use.
- No nearby-date merging is permitted.
- No broad deletion or reordering of unrelated `WH Trucking Request` rows.

## Verification

The repair is complete only when all of these pass:

1. `IN00462238` appears once for `KORHEIM (CERRITOS)` on `08/07/2026` with `$5,129.20`.
2. `IN00464263` appears once for `KORHEIM (CERRITOS)` on `08/13/2026` and is not combined with `IN00462238`.
3. The confirmed repeated malformed Cerritos rows are gone.
4. The legacy importer body is no longer callable as a competing global implementation.
5. Trigger provisioning produces one V2 WMS trucking trigger.
6. A second importer run against unchanged source data imports zero new Cerritos rows and does not alter either shipment date.
7. Regression tests cover the exact 08/07 versus 08/13 split and repeated-run idempotency.

## Out of scope

This repair does not change unrelated trucking rows, WMS source data, dashboard styling, parcel logic, inventory logic, or Gmail ingestion.