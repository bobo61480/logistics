# CMS → IMPORTS tab field mapping (prototype)

**Status:** prototype / reference. Verified against the live CMS on 2026-08-26
using all 30 invoice numbers in `app/inbound-invoice-links.ts` — every one
resolved, so the CMS can pre-fill or reconcile the IMPORTS columns that are
currently maintained by hand.

**Runner:** `node scripts/cms-imports-map.mjs` (CSV to stdout; `--json` for JSON).

## Where the data lives

The company CMS is reachable read-only through the cms-mcp-server at
`https://cms.mcp.siliconii.com/mcp/` (MCP over streamable HTTP, SELECT-only,
RBAC + audit-logged — every call must carry the requesting user's question in
a `prompt` argument). Two MSSQL tables cover an import shipment end to end:

- `CSMS.dbo.TB_INVC` — invoice header. Our `IN########` numbers are its
  primary key (`invc_no`). The Imports invoices are `biz_type='SELF'`
  (intercompany) shipments from HQ `CO000001` to Stylekorean Inc.
  (`CU000731`), destination warehouse `WH000095` (미주 창고), amounts in USD
  (`biz_curr=2`).
- `CSMS.dbo.TB_PNFM` — 정산/도착 confirmation, joined on `invc_no`. Carries
  the **actual** arrival date (`arrv_dt`) and inbound receipt (`iw_yn`,
  `iw_qtot`), which the sheet does not track anywhere today.

## Column mapping

IMPORTS columns as read by `importSourceRecords` (`app/page.tsx`), 0-indexed
letters per the live sheet layout:

| IMPORTS col | Meaning | CMS source | Notes |
|---|---|---|---|
| A | SHIPMENT NO (`OSL…`) | — | Manual numbering; no CMS equivalent. Invoices sharing `TB_INVC.carrier` (vessel+voyage) sail together, so carrier is the natural grouping key when assigning one. |
| C | INVOICE | `TB_INVC.invc_no` | **Join key.** Same values as the keys of `INBOUND_INVOICE_LINKS`. |
| D | MBL | `TB_INVC.airway_bill` | Populated for air only; null on the ocean shipments checked. Ocean MBL is not in the CMS header tables. |
| E | HBL | — | Not in `TB_INVC`/`TB_PNFM`. |
| H | CONTAINER | — | Not in `TB_INVC`/`TB_PNFM`. |
| M | VESSEL | `TB_INVC.carrier` | e.g. `MAERSK BOSTON 626E`, `HANSA EUROPE 627E`. Free text — formatting varies (`/` between vessel and voyage on some rows). |
| N | ETD | `TB_INVC.sailing_dt` | 출항일 (sailing date from load port). `TB_INVC.ship_dt` is the earlier ex-warehouse ship date, not ETD. |
| O | ETA | `TB_INVC.eta_dt` | The app treats column O as the authoritative schedule date. **Caveat below.** |
| Q | DELIVERY EXPECTED | `TB_PNFM.arrv_dt` | Actual arrival (실제도착). Once present it is ground truth for the receiving date. |
| AB | STATUS | derived | `TB_PNFM.iw_yn='Y'` → `RECEIVED`; else `arrv_dt` in the past → `DELIVERED`; else `TB_INVC.ow_yn='Y'` → `SHIPPING`; else `SCHEDULED`. All values exist in `INBOUND_STATUS` (Code.gs). |

Useful CMS fields with no IMPORTS column (emitted by the script for
reference): `invc_qtot` (shipped qty), `iw_qtot` (received qty — matched
shipped exactly on all 30), `invc_icnt` (SKU count), `invc_atot` (amount,
USD), `ship_port`/`arrv_port`, `ow_dt` (warehouse outbound date),
`pallet_height`, `pnfm_no` (confirmation number).

## Caveats

- **`eta_dt` is optimistic.** On the Jun–Jul 2026 shipments every ocean ETA
  was missed by ~1–2 weeks (e.g. MAERSK BOSTON 626E: ETA 07-18, actual
  arrivals 07-28…07-30). Treat `eta_dt` as the carrier plan and
  `TB_PNFM.arrv_dt` as ground truth; don't overwrite a manually corrected
  column O with a stale `eta_dt`.
- **One invoice per row.** IMPORTS keys rows by shipment (column A) but the
  invoice in column C is 1:1 with `TB_INVC` in the rows checked. If a sheet
  row ever aggregates several invoices, the join needs to go through the
  packing-list level instead.
- **CMS query rules** (enforced server-side): no `SELECT *` (PII columns get
  the whole query blocked), verify names via the server's knowledge base
  rather than guessing, `TOP n` not `LIMIT`. `TB_PNFM` has no `iw_dt` — the
  inbound *date* would come from `TB_IW.iw_dt` via `po_no` if ever needed.
- The script is a standalone analysis tool (like the rest of `scripts/`) and
  is not part of the Next.js build or the Worker. Wiring CMS data into the
  live snapshot path would be a separate decision — the Worker currently only
  talks to Google Sheets.
