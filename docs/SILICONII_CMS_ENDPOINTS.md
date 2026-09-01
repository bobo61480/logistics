# Siliconii CMS endpoint record

Captured from the authenticated CMS session and `/home/bobo/siliconii-cms.har` on 2026-08-30. This is an endpoint/schema record only: credentials, cookies, API-key values, and row-level customer/product data are intentionally excluded.

## Inventory and stock

| Method | Endpoint | Safe query fields | UI result fields observed |
| --- | --- | --- | --- |
| GET | `https://ims.siliconii.com/api/get/report/stock/stocks` | `comp_cd`, `whouse_cd`, `wh_cds`, `brand_cd`, `brand_nm`, `barcode`, `dept_cd`, `prod_cd`, `prod_nm`, `biz_gbn`, `sales_rate`, `sdt`, `edt`, `qty`, `qty_ob`, `amt`, `amt_ob`, `biz_curr`, `xrate`, `s_crdt_rate`, `sku_status`, `curr_lang` | `prod_cd`, `prod_nm`, `barcode`, `brand_nm`, `stock_qty`, `hold_qty`, `avail_qty`, `ow_qty`, `pnfm_qty`, `iw_dt`, plus amount/rate/status fields |
| GET | `https://ims.siliconii.com/api/get/report/stock/expdate` | `curr_lang`, `comp_cd`, `exp_date_fr`, `exp_date_to`, `prod_cd`, `prod_nm`, `brand_cd`, `brand_nm`, `hide_null_cost` | `prod_cd`, `prod_nm`, `brand_nm`, `barcode`, `exp_date`, `stock_qty`, `avg_ucost`, `stock_amt` |

The stock APIs are served from `ims.siliconii.com` and require the browser’s `x-api-key` request header. The expiration report returned `ResultCode`, `ResultMessage`, and `Data`; the supplied capture contained 19,231 `Data` rows. The key is not stored in this repository. Production integration uses the Cloudflare Worker secret `CMS_IMS_API_KEY`, never a public `NEXT_PUBLIC_*` variable.

The CMS stock report UI also exposes warehouse, product, barcode, department, business type, date, quantity, amount, and SKU-status filters. The response is large (approximately 3.7–5.6 MB in the supplied HAR), so the Worker should bound response bytes and persist a reduced `{productName, sku, upc, expirationDate, quantity}` projection in D1.

## Invoices and products

| Method | Endpoint | Safe query/body fields | Result fields observed |
| --- | --- | --- | --- |
| GET | `/SalesProcess/INVCList` | `mode`, `key_val`, `appr_yn`, `block_gbn`, `block_pages`, `page_rows`, `curr_block`, `curr_page`, `base_key`, `sdt`, `edt`, `comp_cd`, `whouse_cd`, `invc_user`, `dept_cd`, `cust_cd`, `cust_nm`, `prod_cd`, `prod_nm`, `biz_type`, `biz_curr`, `pay_curr`, `pkng_gbn`, `ow_yn`, `ow_sdt`, `ow_edt`, `invc_no`, `curr_lang` | `invc_no`, `invc_dt`, `whouse_snm`, `cust_cd`, `cust_nm`, `invc_icnt`, `invc_qtot`, `invc_atot`, `appr_yn`, `pkng_gbn`, `cnfm_yn`, `ow_yn`, `ow_dt`, `epay_dt`, `remk` |
| POST | `/SalesProcess/INVCList` | JSON body key `data`; fields include invoice, date, customer, warehouse, shipping method/date, airway bill, container, ports, reference, and language | Invoice operation response; treat as write-capable and do not call from the public dashboard |
| GET | `/ProdProcess/List` | `mode`, paging fields, `brand_cd`, `brand_nm`, `class1`, `prod_cd`, `prod_nm`, `prod_gbn`, `use_yn`, `mprod_cd`, `mprod_nm`, `bar_code`, `prod_cd_master`, `cnts_yn`, `set_prod_yn`, `labeling_yn`, `rgst_dt`, `biz_gbn`, `curr_lang` | `prod_cd`, `prod_nm`, `prod_gbn`, `mnuf_nm`, `bar_code`, `bar_code_ht`, `brand_nm`, `line_nm`, function/category fields, price, use/status fields |

## Shared metadata routes

The UI also calls `/Sys/GetAlramList`, `/Sys/GetSessionValue`, `/Sys/GetGlobalCurrWithComp`, `/Sys/GetList`, `/Scripts/jsonDatas/cmsCode.json`, and `/Sys/Resources`. These are supporting menu/code/session resources, not authoritative inventory datasets. `/Sys/GetList` is parameterized by stored-procedure name/mode and should not be exposed as a general public proxy.

## Integration guidance

- Use the direct IMS stock route for the inventory comparison when `CMS_IMS_API_KEY` is configured; retain the MCP adapter as a fallback for environments where only MCP is permitted.
- Keep invoice/product reads server-side and reduced to allowlisted fields. Do not replay the POST invoice operation from the dashboard.
- Preserve Google Sheets as the operational write authority; CMS data is comparison/enrichment input only.
- The supplied HAR contains authenticated traffic. Treat it as sensitive evidence and do not commit it, its headers, or response bodies.
