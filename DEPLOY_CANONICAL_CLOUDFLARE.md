# Canonical production deployment

`bobo61480/logistics` is the canonical source for the StyleKorean logistics web app.

Production hostname: `stylekorean.dpdns.org`
Cloudflare Worker: `stylekorean-logistics-planner`

The canonical Next.js app is built as a static export (`out/`) and deployed to the Worker with Workers Static Assets using `wrangler.toml`.

`.github/workflows/deploy-cloudflare.yml` deploys from `main` after typecheck, unit tests, and static-export validation. The workflow then smoke-tests the live custom domain for canonical build markers.

Do not deploy production UI code for `stylekorean.dpdns.org` from another repository.
