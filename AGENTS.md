# StyleKorean Logistics Planner — Agent Instructions

**What this is:** A static Next.js app served by a Cloudflare Worker. The Worker reads Google Sheets, exposes the same-origin snapshot/status APIs, serves the static export, and proxies approved status updates to Google Apps Script.

Live site: `stylekorean.dpdns.org`

## Build & Validation

```bash
npm run typecheck   # TypeScript check — run after any .ts/.tsx change
npm run build       # Full static export (out/) — catches layout/render errors
npm run dev         # Local dev server at localhost:3000
npm test            # Unit tests (vitest) — lib/sales-kpis.ts parsers & KPI math
npm run test:e2e    # Playwright e2e — builds out/ and drives it in Chromium
```

Run `typecheck` and `npm test` before every commit. The project uses `"strict": true`.

## Tests

- **Unit** (`tests/`, vitest): cover the CSV/date/money parsers and the full
  `computeLiveKpis` pipeline in `lib/sales-kpis.ts` against fixture workbooks
  with a frozen clock. Helpers there are exported specifically so tests can
  reach them.
- **E2E** (`e2e/`, Playwright): serve the real static export
  (`e2e/static-server.mjs`) and intercept ALL `docs.google.com` /
  `script.google.com` traffic with fixtures — tests never touch live
  workbooks. Covers first render + KPI cards, the status-write round trip
  (POST payload, confirmation re-read, finished-row removal), and the
  failure banner. In sandboxes with a pre-installed Chromium, run with
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`; CI uses
  `npx playwright install chromium`.
- CI: `.github/workflows/ci-pr.yml` runs unit tests, type checking, and the
  production build on pull requests. `.github/workflows/deploy-cloudflare.yml`
  repeats those checks before the canonical production deploy.

## Architecture

- **`output: "export"`** — the UI is a static export. Cloudflare handles server-side API routes and assets; do not add Next.js API routes.
- Primary data path: browser → same-origin Worker snapshot API → Google Sheets. The browser has a read-only direct-Sheets fallback for routing incidents.
- Status writes: browser → same-origin Worker status API → approved Apps Script deployment. The canonical deployment URL is configured once in `wrangler.toml`.
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

Push to `main` → `.github/workflows/deploy-cloudflare.yml` validates and deploys the Worker plus static export to the custom domain configured in `wrangler.toml`. Changes under `google-apps-script/` independently run `.github/workflows/deploy-apps-script.yml`.

GitHub Pages is not a production target. Keep the repository's Pages feature disabled so it cannot contend for the Cloudflare hostname.

## Common Pitfalls

- Update `APPS_SCRIPT_WRITE_URL` in `wrangler.toml` only if the Apps Script deployment ID is intentionally replaced. Normal clasp deployments update the existing ID.
- Do **not** add `export const runtime = "edge"` or any server-side constructs — `output: "export"` will break the build.
- Do not add a Pages `CNAME`; `wrangler.toml` is the production hostname source of truth.
- `archive/legacy-static-site/` contains the old `app.js`, `index.html`, etc. Do not edit these — they are not deployed.
- `inbound-pallets.ts` is manually maintained from packing list spreadsheets. When new shipments arrive, pallet data must be added here by hand.

## Migration Notes

See [CANONICAL_NEXTJS_MIGRATION.md](./CANONICAL_NEXTJS_MIGRATION.md) for the history of migrating from the legacy static site to this Next.js app.
