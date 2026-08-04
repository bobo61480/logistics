# Legacy static site (archived)

This was the original vanilla-JS dashboard, served from the repo root before
the Next.js rewrite in `app/page.tsx`. It's why stylekorean.dpdns.org was
stuck showing "0/0 sources online" with none of the newer inventory/sales
features: **GitHub Pages was never switched to "Deploy via GitHub Actions,"**
so it was silently serving these root files (which never got far enough to
run -- see repo root README/DEPLOY notes) instead of building and publishing
the Next.js app.

Kept here for reference only. It is not part of the Next.js build --
`next build` only bundles `app/`, `lib/`, and `public/`, so nothing in this
folder ships to production. Safe to delete once you've confirmed the Next.js
app is live and working.

`google-apps-script/Code.gs.old-backup` was an earlier version of the write-back
endpoint (no SKW_Inbound -> SKW_Stock transfer, no stale-write "SCHEDULED"
fallback). The current one, `google-apps-script/Code.gs` at the repo root,
is the active version -- redeploy that one, not this backup.
