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

## Existing Gmail automation verified on August 3, 2026

- The active `sk-logistics` mailbox scanner runs every 15 minutes and labels processed messages `sk-logistics/processed`.
- The inventory aggregator runs hourly and refreshes the `INVENTORY` tab.
- `PIPELINE LOG` showed successful mailbox runs through 12:55 AM and successful inventory syncs through 12:33 AM.
- Gmail showed 62 processed messages across 34 threads, including recent `출고` and `ARRIVAL NOTICE` messages.

The repository's WMS trigger installer now replaces only its own `scanAndImportWmsTruckingOrders` trigger. It no longer deletes unrelated Gmail or inventory triggers.

## Known scanner follow-up

Older rows in `PENDING VERIFICATION` record attachment-conversion failures using the retired `Drive.Files.insert` method. The live scanner source is deployed in a separate Apps Script project and is not contained in this repository; change that call to the Drive API v3 `Drive.Files.create` method in that project, then reprocess the pending rows.

## Verification

- `npm run build` must produce `out/index.html` and `out/CNAME`.
- `npx tsc --noEmit` must pass.
- `node --check < google-apps-script/Code.gs` validates Apps Script JavaScript syntax.
- Test receipt posting with one non-production `SKW_Inbound` row before using a live shipment.
