# Dashboard Style Variants and Repo Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two fully live visual variants of the StyleKorean logistics dashboard and mirror the complete canonical repository into `bobo61480/sklogistics`.

**Architecture:** Keep `app/page.tsx` as the canonical production dashboard and create two route-level copies that preserve identical source IDs, 1-minute polling, and Apps Script writebacks. Scope visual differences through route-specific root classes in `app/globals.css`, and move the TK fulfillment panel directly after the outbound trucking schedule in both variants. The target `sklogistics` repository is populated by a one-time GitHub Actions mirror job that copies the full source tree from `bobo61480/logistics`.

**Tech Stack:** Next.js App Router, React/TypeScript, CSS, GitHub Actions, Google Sheets/GViz/CSV, Google Apps Script writebacks, Cloudflare Wrangler.

## Global Constraints

- Preserve all current live source IDs and the production Apps Script writeback endpoint.
- Preserve source-first writeback verification and 1-minute auto refresh.
- Do not alter the existing root production page styling while creating the two new variants.
- Variant 2 uses the approved light pastel dashboard preview direction.
- Variant 3 uses a compact SK Fulfillment Sales Lookup-inspired light table/status style; public source CSS could not be reliably fetched, so it must be an original approximation rather than a claimed pixel copy.
- Currency values must render with a leading `$` and US currency formatting in the styled variants.
- Fulfillment TK Orders must appear immediately after the main outbound schedule in both styled variants.
- The final `bobo61480/sklogistics` mirror must contain the complete canonical repository contents.

---

### Task 1: Add route behavior tests

**Files:**
- Create: `tests/style-variants.test.ts`

**Interfaces:**
- Consumes: repository files under `app/`.
- Produces: assertions for `/light` and `/fulfillment-style` routes, route root classes, TK panel placement, and dollar-formatting helper behavior.

- [ ] **Step 1: Write failing tests** that assert both new route files exist, each contains `AUTO_REFRESH_MS = 60 * 1000`, the shared `WRITE_ENDPOINT`, a route-specific `site-shell` class, and `FulfillmentTkPanel` occurs after the outbound `ScheduleBoard` call but before outbound `SmallParcelSchedule`.
- [ ] **Step 2: Run `npm test -- tests/style-variants.test.ts`** and confirm the tests fail because the routes do not yet exist.
- [ ] **Step 3: Keep the failing test output in the workflow log** as TDD evidence.

### Task 2: Create the light pastel dashboard variant

**Files:**
- Create: `app/light/page.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: the same Google Sheets IDs, fulfillment API, KPI loader, inventory mapping, and `WRITE_ENDPOINT` as `app/page.tsx`.
- Produces: `/light`, a live dashboard variant with class `site-shell variant-light`.

- [ ] **Step 1: Copy the canonical page** and adjust relative imports for the nested route.
- [ ] **Step 2: Change only the root class and panel placement** so the TK panel sits directly after the outbound trucking `ScheduleBoard`.
- [ ] **Step 3: Add scoped `.variant-light` CSS** using pale blue, mint, lavender, amber, and rose surfaces with soft borders while retaining operational contrast and sticky tables.
- [ ] **Step 4: Add scoped currency styling/formatting** so recognized monetary values show `$` and two decimals where source precision is available.

### Task 3: Create the SK Fulfillment Sales Lookup-inspired variant

**Files:**
- Create: `app/fulfillment-style/page.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: identical live data and writeback interfaces as the canonical page.
- Produces: `/fulfillment-style`, a compact fulfillment-focused dashboard with class `site-shell variant-fulfillment-sales`.

- [ ] **Step 1: Copy the canonical page** and adjust nested relative imports.
- [ ] **Step 2: Move TK panel** directly after outbound trucking schedule.
- [ ] **Step 3: Add scoped fulfillment-style CSS** with clean white surfaces, green primary accents, soft status pills, compact table rows, light gray dividers, and pale blue/green/amber/red semantic states.
- [ ] **Step 4: Ensure all recognized money fields display a `$` prefix** and preserve source links/search/writeback controls.

### Task 4: Verify variants

**Files:**
- Test: `tests/style-variants.test.ts`

**Interfaces:**
- Consumes: both new route files and scoped CSS.
- Produces: passing typecheck, tests, and static build.

- [ ] **Step 1: Run `npm test -- tests/style-variants.test.ts`** and confirm PASS.
- [ ] **Step 2: Run `npm run typecheck`** and confirm PASS.
- [ ] **Step 3: Run `npm test`** and confirm the full suite passes.
- [ ] **Step 4: Run `npm run build`** and confirm Next.js emits `/light` and `/fulfillment-style` static routes.
- [ ] **Step 5: Commit the implementation** with a feature commit.

### Task 5: Mirror the complete source repository

**Files:**
- Create temporarily in target: `.github/workflows/mirror-logistics.yml`
- Final target: complete copy of `bobo61480/logistics` tree.

**Interfaces:**
- Consumes: public canonical repo `bobo61480/logistics` main branch.
- Produces: `bobo61480/sklogistics` main branch containing the complete canonical tree and history snapshot commit.

- [ ] **Step 1: Add a one-time target workflow** with `contents: write` that clones the canonical source, removes all target working-tree files except `.git`, copies the full source tree, commits, and pushes using `GITHUB_TOKEN`.
- [ ] **Step 2: Verify the target commit** contains `app/page.tsx`, `app/light/page.tsx`, `app/fulfillment-style/page.tsx`, `google-apps-script/`, workflows, tests, config, and documentation.
- [ ] **Step 3: Confirm source and mirror key file blob contents match** for `app/page.tsx`, `app/globals.css`, and `google-apps-script/Code.gs`.

### Task 6: Production deployment safety

**Files:**
- Modify only if needed: `.github/workflows/deploy-cloudflare.yml`

**Interfaces:**
- Consumes: existing Cloudflare deployment secrets and Wrangler config.
- Produces: production root remains unchanged while static variant routes are included in the deployed artifact.

- [ ] **Step 1: Verify the existing build/deploy workflow builds all routes** without changing the root route marker checks.
- [ ] **Step 2: Verify the Cloudflare job succeeds** for the feature commit.
- [ ] **Step 3: Confirm the custom domain serves the canonical root and the two new route paths from the same build artifact.**
