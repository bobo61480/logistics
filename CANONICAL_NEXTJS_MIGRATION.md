# Making the Next.js app canonical — what changed and what you need to do

## What I changed in the repo

1. **`app/page.tsx`** — `WRITE_ENDPOINT` no longer points at the third-party
   `chatgpt.site` domain. It now points at the Apps Script `/exec` URL that
   was already sitting in the legacy site's `site-config.js`, which is bound
   to the same LOGISTICS MASTER 2026 spreadsheet and matches the exact
   payload shape `postStatus()` sends (`kind`, `sourceSheet`, `sourceRow`,
   `shipmentNo`, `container`, `mbl`, `hbl`, `pro`, `invoice`, `customer`,
   `shipDate`, `currentStatus`, `status`).

   **You need to verify this yourself** — I can't confirm server-side which
   version of `Code.gs` is actually bound to that deployment. Open
   `google-apps-script/Code.gs` in the Apps Script editor for this
   spreadsheet, confirm it matches the file at the repo root (has the
   `SKW_Inbound` → `SKW_Stock` transfer logic, `WMS_SPREADSHEET_ID`, the
   `SCHEDULED` stale-write fallback), redeploy if it doesn't, and update
   `WRITE_ENDPOINT` if redeploying gives you a new URL.

2. **Archived the legacy static site** (`index.html`, `app.js`, `styles.css`,
   `site-config.js`, `platform-config.js`, `database-config.js`,
   `database-client.js`, the old `backup/Code.gs`) into
   `archive/legacy-static-site/`. These were never part of the Next.js build
   and are now clearly marked as reference-only, so nobody mistakes them for
   live code again.

3. **Removed the duplicate root `CNAME`.** `public/CNAME` (already correctly
   set to `stylekorean.dpdns.org`) is the one that matters — `next build`
   copies everything in `public/` into the exported `out/` directory, which
   is what actually gets deployed.

## What only you can do: the GitHub Pages setting

This is the actual root cause and it's a one-time manual toggle:

1. Go to the repo on GitHub → **Settings → Pages**.
2. Under **Build and deployment → Source**, change it from whatever it's
   currently set to (**"Deploy from a branch"**) to **"GitHub Actions."**
3. Push these changes to `main`. `.github/workflows/deploy-planner.yml` will
   run automatically, build the Next.js static export, and publish it.
4. Watch the **Actions** tab for the run to go green, then hard-refresh
   `stylekorean.dpdns.org`.

Once that's flipped, every future push to `main` redeploys the Next.js app
automatically — no more silent fallback to stale root files.

## Push instructions

```bash
git checkout main
git pull
# copy the contents of this zip's logistics-main/ over your local working copy
git add -A
git commit -m "Point write endpoint at Apps Script, archive legacy static site"
git push origin main
```

Then do the Settings → Pages step above (order doesn't matter, but the site
won't reflect any of this until that toggle is flipped).
