# Apply and deploy — full session
(appearance links · source-health isolation · Gmail ingestion review card ·
colorful folder icons · live shipment map + UPS/FedEx/USPS tracking)

Consolidated, cumulative patch of everything from this whole session.

## What's new in this pass: Live Shipment Map

**`app/live-map.tsx`** — a new dashboard card rendering an interactive map
(Leaflet + OpenStreetMap tiles, loaded from CDN — no npm dependency added,
no Google Maps API key needed):
- **Inbound ocean/air shipments** get a milestone pin at the destination port
  (LAX or LGB, based on the existing `pod` field) with a dashed line back to
  an approximate Korea origin (Incheon for air, Busan for ocean) — these are
  **not live-tracked**, just origin→destination milestones, per your
  clarification that ocean/air containers don't have a real GPS feed.
- **Small-parcel shipments** (inbound or outbound, wherever `carrierFromTrackingNumber()`
  already detects UPS/FedEx/USPS) get a pin at their **last known carrier scan
  location** — this is the real "GPS" data source, but it's last-scan, not
  truly live (confirmed as your choice in the earlier Q&A).

**`worker/carrier-tracking.ts`** — OAuth2 + tracking calls for all three
carriers, built to the field names/endpoints verified via research this
session (not guessed from memory):
- UPS: `activity[0].location.address.{city,stateProvince,countryCode}`
- FedEx: `scanEvents[0].scanLocation.{city,stateOrProvinceCode,countryCode}`
  (deliberately NOT `latestStatusDetail.scanLocation`, which is usually empty)
- USPS: `trackingEvents[0].{eventCity,eventState,eventCountry}` (v3 REST —
  the legacy XML Web Tools API was retired Jan 25, 2026)

**`worker/tracking-command.ts`** — new `/api/logistics/tracking` POST route:
batches up to 25 lookups, caches successful results 15 min via the Cloudflare
Cache API (no KV needed), same origin/rate-limit checks as the other write
routes. Reports which carriers are configured so the map can show a "not
connected" hint instead of silently showing nothing.

**`app/geo.ts`** — small static coordinate table (US state centroids + your
warehouses + LA/LB port + common Asia-Pacific origin cities). None of the
three carrier APIs return lat/lng, only city/state/country text, so this
converts that to an approximate map position. It's intentionally coarse —
good enough for a shipment overview map, not turn-by-turn.

## ⚠️ Required before this does anything live: carrier API credentials

**I cannot obtain these for you** — each carrier requires you to register a
free developer account:

| Carrier | Register at | Secrets to set |
|---|---|---|
| UPS | developer.ups.com → My Apps → add Tracking product | `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET` |
| FedEx | developer.fedex.com → Organization → Project | `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET` |
| USPS | developers.usps.com / Business Customer Gateway | `USPS_CLIENT_ID`, `USPS_CLIENT_SECRET` |

All three are free for read-only tracking. Set each with:
```bash
wrangler secret put UPS_CLIENT_ID
wrangler secret put UPS_CLIENT_SECRET
# ...repeat for FEDEX_ and USPS_
```
Until you do, the map still shows inbound ocean/air milestones — it just
shows a "no carrier tracking connected" hint instead of parcel pins, rather
than erroring.

## 1. Apply

```bash
cd /path/to/logistics
git checkout main && git pull
patch -p1 < logistics-live-map-and-tracking.patch
# or copy files directly from logistics-changed-files.zip, then:
git rm -f app/style-switcher.tsx

npm ci
npm run typecheck                              # clean
npm test                                       # 109/110 (1 pre-existing unrelated failure)
npm run build                                   # ./out
npx wrangler deploy --dry-run                    # confirms Worker bundles, incl. new routes
```

## 2. Commit, add secrets, push

```bash
git add app/ google-apps-script/ worker/ worker-configuration.d.ts tests/
git commit -m "Add live shipment map (UPS/FedEx/USPS tracking + inbound port milestones), Gmail ingestion review card, colorful folder icons, appearance links, source-health isolation"
git push
```
Add the six carrier secrets (above) via `wrangler secret put` whenever
you've registered — no redeploy needed after, Workers picks them up on the
next request.

## 3. Redeploy Code.gs (manual, same as always)

Same step as last time — paste the updated `Code.gs`/`Validation.gs` into
the Apps Script editor and Deploy → New version. This turn didn't touch
Code.gs further, so if you already did this step for the Gmail review card,
you're done here.

## Notes on scope / honesty

- I verified the UPS/FedEx/USPS field names against current official docs
  before writing this — I did not have working credentials to test live
  calls end-to-end, so the very first real request against each carrier is
  worth watching for a 401/403 in case something in your specific account
  setup (scopes, sandbox vs prod) differs from the general docs.
- Tracking data source is explicitly **last-known scan location**, not
  continuous GPS — that's the real behavior of these APIs, and matches what
  you confirmed earlier in this session.
- Inbound ocean/air origin points (Busan/Incheon) are a reasonable default
  based on your Korea-sourced import business, not parsed from actual origin
  data in the IMPORTS sheet (no origin-city column exists there today). If
  you want per-shipment real origins, that needs a new column in IMPORTS.
