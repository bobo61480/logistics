# Inventory cards and received-stock rollout

## Live data contract

The web application reads the existing relational tabs in `LOGISTICS MASTER 2026`:

- `INVENTORY` — canonical warehouse/inbound summary. The inbound card uses `Remaining To Receive`; the matching-stock card uses `On Hand (Actual)`, `Locations`, `Barcode`, and `Nearest Expiry` for those inbound SKUs.
- `SKW_Inbound` — product-level inbound rows created by the installed Gmail ingestion backend.
- `SKW_Stock` — idempotent ledger of product quantities posted when an inbound shipment is received.

The frontend intentionally does not create parallel `INBOUND INVENTORY` or `WAREHOUSE STOCK` tabs.

## Receive-to-stock behavior

After the deployed status-write Apps Script is updated from `google-apps-script/Code.gs`, changing an inbound shipment to `Delivered`, `Received`, or `Completed` will:

1. Match the shipment, invoice, container, MBL, or HBL against `SKW_Inbound`.
2. Append each unposted product quantity to `SKW_Stock` with SKU, UPC, product description, batch, expiration date, and location.
3. Stamp `Received_Date`, change the product row status to `Received`, and set `Stock_Posted`.
4. Use a composite source key so retries cannot double-post stock.

Rows without a warehouse location are posted as `UNASSIGNED` and can be relocated later.

## Gmail and inventory automation

The complete operational Apps Script source is now versioned in `google-apps-script/`:

- `GmailPipeline.gs` — 15-minute Gmail scan, Drive archive, attachment extraction, validation, and schedule upsert.
- `Validation.gs` — pending-review queue and approval processing.
- `InventorySync.gs` — hourly WMS/allocation aggregation into `INVENTORY` and `KPI DASHBOARD`.
- `Triggers.gs` — trigger provisioning and the `bobo61480/logistics` redeploy hook.

The Gmail query covers `출고`, `해상`, `항공`, `선적`, `입고`, `ARRIVAL NOTICE`, BOL, entry summaries, shipping documents, ISF, delivery orders, and POD messages with attachments.

## Existing automation verified on August 3, 2026

- The active `sk-logistics` mailbox scanner runs every 15 minutes and labels processed messages `sk-logistics/processed`.
- The inventory aggregator runs hourly and refreshes the `INVENTORY` tab.
- `PIPELINE LOG` showed successful mailbox runs through 1:10 AM and successful inventory syncs through 12:33 AM.
- Gmail showed 62 processed messages across 34 threads, including recent `출고` and `ARRIVAL NOTICE` messages.

The repository's WMS trigger installer now replaces only its own `scanAndImportWmsTruckingOrders` trigger. It no longer deletes unrelated Gmail or inventory triggers.

## Apps Script deployment follow-up

Older rows in `PENDING VERIFICATION` record attachment-conversion failures from the retired `Drive.Files.insert` method. `GmailPipeline.gs` now uses Drive API v3 `Drive.Files.create` for XLSX/PDF conversion and `Drive.Files.remove` for temporary-file cleanup.

GitHub Pages deploys the frontend only. To activate the receive-to-stock handler and the Drive v3 scanner fix, update the separate production Apps Script project with the files in `google-apps-script/`, redeploy its web app, run `setupAllTriggers()` once, and then reprocess or approve the pending rows. Keep the Advanced Drive service enabled as Drive API v3.

## Verification

- `npm run build` must produce `out/index.html` and `out/CNAME`.
- `npx tsc --noEmit` must pass.
- Run `node --check` against every file in `google-apps-script/` to validate Apps Script JavaScript syntax.
- Test receipt posting with one non-production `SKW_Inbound` row before using a live shipment.
