# StyleKorean Logistics Planner — Agent Instructions

**What this is:** A static Next.js app that displays live inbound/outbound shipment schedules, inventory panels, and sales KPIs for StyleKorean. It reads Google Sheets via client-side CSV fetches and writes status updates back through a Google Apps Script endpoint.

Live site: `stylekorean.dpdns.org`

## Build & Validation

```bash
npm run typecheck   # TypeScript check — run after any .ts/.tsx change
npm run build       # Full static export (out/) — catches layout/render errors
npm run dev         # Local dev server at localhost:3000
```

Run `typecheck` before every commit. The project uses `"strict": true`.

## Architecture

- **`output: "export"`** — fully static. No server components, no API routes. All data is fetched **client-side**.
- Data source: Google Sheets via `docs.google.com/spreadsheets/.../gviz/tq?tqx=out:csv` (CORS-enabled).
- Status writes: `WRITE_ENDPOINT` in `app/page.tsx` → Apps Script `/exec` (doPost). **This URL must be updated manually** whenever `google-apps-script/Code.gs` is redeployed — Apps Script generates a new URL each time.
- Auto-refresh: every 30 minutes (`AUTO_REFRESH_MS`).

## Key Files

| File | Purpose |
|------|---------|
| `app/page.tsx` | Main UI — schedule view, filters, KPI panels, status editor |
| `app/inventory-panels.tsx` | Reads `SKW_Inbound` and `SKW_Stock` tabs via gviz CSV |
| `lib/sales-kpis.ts` | Client-side CSV parser for KPI data |
| `app/inbound-pallets.ts` | Static SKU→pallet mapping (from packing list spreadsheets) |
| `app/inbound-links.ts` | Packing list link lookup table |
| `app/inbound-invoice-links.ts` | Invoice link lookup table |
| `google-apps-script/Code.gs` | Apps Script bound to LOGISTICS MASTER 2026; handles `doPost` |
| `scripts/` | Standalone `.mjs` analysis scripts — not part of the Next.js build |
| `archive/legacy-static-site/` | Old static site — reference only, not live code |

## Google Sheets IDs

| Sheet | ID |
|-------|-----|
| LOGISTICS MASTER 2026 (main) | `1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc` |
| Nationals | `12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8` |
| WMS/Sales | `14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I` |

Tabs written by Apps Script: `WH Trucking Request`, `B2B/E-COM TRUCKING`, `TRANSFERS`, `ULTA`, `IHERB`, `IMPORTS`, `NATIONAL ORDER PROGRESS`, `Outbound Shipping Schedule`, `TJX/ROSS`.

## Status Values

Outbound: `"" | "SCHEDULED" | "WORK IN PROGRESS" | "PENDING" | "SHIPPING" | "SHIPPED" | "DELIVERED" | "RECEIVED" | "CANCELLED" | "COMPLETED"`

Inbound adds: `"N/A" | "Customs Clearance" | "FDA Review/Hold" | "FWS Review/Hold" | "Delayed"`

## Deployment

Push to `main` → `.github/workflows/deploy-planner.yml` runs automatically:
1. Deploys `google-apps-script/` via clasp (only when `.gs` files changed). Requires `CLASP_ACCESS_TOKEN` repo secret.
2. Runs `npm run build` and publishes `out/` to GitHub Pages.

**One-time setup required:** GitHub repo Settings → Pages → Source must be set to **"GitHub Actions"** (not "Deploy from a branch").

## Common Pitfalls

- **`WRITE_ENDPOINT`** in `app/page.tsx` becomes stale after every Apps Script redeploy. Always verify the URL matches the current deployment in the Apps Script editor.
- Do **not** add `export const runtime = "edge"` or any server-side constructs — `output: "export"` will break the build.
- The root `CNAME` file is unused; `public/CNAME` (`stylekorean.dpdns.org`) is the one that matters.
- `archive/legacy-static-site/` contains the old `app.js`, `index.html`, etc. Do not edit these — they are not deployed.
- `inbound-pallets.ts` is manually maintained from packing list spreadsheets. When new shipments arrive, pallet data must be added here by hand.

## Migration Notes

See [CANONICAL_NEXTJS_MIGRATION.md](./CANONICAL_NEXTJS_MIGRATION.md) for the history of migrating from the legacy static site to this Next.js app.
