# StyleKorean Logistics Hub — Template Package

Self-contained dashboard template with full deployment configs.
Drop this into any repository to get a working logistics dashboard.

## What's Inside

```
index.html                    ← Full dashboard (open in any browser)
.node-version                 ← Node 22 for build systems
deploy/
  gcp/
    cloudbuild.yaml           ← Google Cloud Build pipeline
    firebase.json             ← Firebase Hosting config
  cloudflare/
    wrangler.toml             ← Cloudflare Workers config (reference)
  docker/
    Dockerfile.cloudrun       ← Cloud Run / any Docker host
    nginx-cloudrun.conf       ← nginx with security headers
```

## Quick Start

### 1. Open Locally
Just open `index.html` in a browser. Everything works standalone.

### 2. Deploy to Firebase Hosting (Recommended)
```bash
# In your repo root:
cp deploy/gcp/firebase.json .
mkdir -p out && cp index.html out/
firebase init hosting    # select your project
firebase deploy
```

### 3. Deploy with Google Cloud Build
```bash
cp deploy/gcp/cloudbuild.yaml .
cp deploy/gcp/firebase.json .
mkdir -p out && cp index.html out/

# One-time: create a build trigger
gcloud builds triggers create github \
  --repo-name=YOUR_REPO --repo-owner=YOUR_ORG \
  --branch-pattern='^main$' \
  --build-config=cloudbuild.yaml

# Manual deploy
gcloud builds submit . --config=cloudbuild.yaml
```

Change targets via substitution:
```bash
# Cloud Storage
gcloud builds submit . --substitutions=_DEPLOY_TARGET=cloud-storage,_GCS_BUCKET=my-bucket

# Cloud Run (containerized)
cp deploy/docker/* .
gcloud builds submit . --substitutions=_DEPLOY_TARGET=cloud-run
```

### 4. Deploy to Any Docker Host
```bash
cp deploy/docker/* .
mkdir -p out && cp index.html out/
docker build -t stylekorean-logistics -f Dockerfile.cloudrun .
docker run -p 8080:8080 stylekorean-logistics
```

### 5. Deploy to Cloudflare Workers
Reference config in `deploy/cloudflare/wrangler.toml`. Update the
route pattern, zone ID, and database ID for your account.

## Customizing the Template

### CSS Tokens
All colors are CSS custom properties on `:root`. Change the palette by
editing the token block at the top of the `<style>` section:
```css
--ink: #0f2430;        /* Primary text */
--orange: #e4572e;     /* Brand accent */
--teal: #2a8f84;       /* Secondary accent */
--paper: #ecf0f1;      /* Background */
```

### Sections
Each dashboard section is marked with `===== SECTION NAME =====` comments.
Copy individual sections into your own pages.

### Data Sources
The `<script>` block contains `STYLEKOREAN_CONFIG` and `STYLEKOREAN_DATA`
objects. Replace the Google Sheets IDs or swap in your own API endpoints.

| Source | Sheet ID |
|--------|----------|
| LOGISTICS MASTER 2026 | `1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc` |
| Nationals | `12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8` |
| WMS/Sales | `14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I` |

### Dark Mode
Three-state theme toggle (light / dark / system) is built in.
The `toggleTheme()` function cycles through states.

## Importing Into an Existing Web App

### React / Next.js
1. Copy the CSS tokens into your global stylesheet
2. Use the HTML sections as JSX component templates
3. Import `STYLEKOREAN_CONFIG` and `STYLEKOREAN_DATA` as JSON modules

### Vue / Svelte / Plain JS
1. Copy `<style>` into your CSS
2. Copy any `<section>` as a component template
3. Import the data objects from the `<script>` block

### As an iframe
```html
<iframe src="/template.html" style="width:100%;height:100vh;border:none"></iframe>
```
