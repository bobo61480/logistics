# Control Tower UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the operational priorities, automation health, exceptions, schedules, fulfillment, and inventory easier to scan while retaining Original, Fulfillment, and three Control-Tower-derived Light comparisons.

**Architecture:** Keep one canonical `Home` data implementation and compose presentation-only shells/routes around reusable sections. Add automation-health and exception-summary components from the normalized snapshot; do not duplicate fetching/write logic across routes.

**Tech Stack:** React 19, Next.js 16 static/Worker-served assets, CSS Modules/global dashboard CSS, accessible semantic HTML.

## Global Constraints

- Existing operational functionality remains available.
- `/` remains Original during comparison.
- `/fulfillment-style` remains Fulfillment.
- `/light`, `/light-skin`, `/light-full` are presentation variants of the same underlying data.
- Style switcher exposes every supported comparison route and highlights the active route.

---

### Task 1: Expand the shared appearance switcher

**Files:**
- Modify: `app/style-switcher.tsx`
- Modify: `app/style-variants.module.css`
- Test: `tests/style-variants.test.ts`

**Interface:**

```ts
const options = [
  { href: "/", label: "Original" },
  { href: "/light-skin", label: "Light Skin" },
  { href: "/light", label: "Light Control Tower" },
  { href: "/light-full", label: "Light Full" },
  { href: "/fulfillment-style", label: "Fulfillment" },
] as const;
```

- [ ] Add failing route/switcher tests for all five exact href/label pairs.
- [ ] Implement options and responsive overflow behavior.
- [ ] Keep `aria-current="page"` on active route.
- [ ] Commit `feat: expose all control tower appearance variants`.

### Task 2: Add Light Skin route

**Files:**
- Create: `app/light-skin/page.tsx`
- Modify: `app/style-variants.module.css`
- Test: `tests/style-variants.test.ts`

**Interface:** Presentation-only wrapper around `<Home />`.

- [ ] Create route using `${styles.variantPage} ${styles.lightSkin}`.
- [ ] Implement white/pastel cards, clearer typography, compact tables, blue/green accents, soft shadows, and status chips without changing document order.
- [ ] Test that `app/light-skin/page.tsx` imports `Home` and contains no fetch/useEffect/data endpoint logic.
- [ ] Commit `feat: add control tower light skin`.

### Task 3: Upgrade `/light` to Control Tower shell

**Files:**
- Modify: `app/light/page.tsx`
- Create: `app/components/control-tower/light-shell.tsx`
- Create: `app/control-tower-light.module.css`
- Test: `tests/control-tower-ui.test.ts`

**Interface:**

```tsx
export function LightControlTowerShell({ children }: { children: React.ReactNode })
```

- [ ] Add source-level failing tests requiring anchor links `#overview`, `#exceptions`, `#imports`, `#inventory`, `#outbound`, `#fulfillment`, and `#kpis`.
- [ ] Add a slim left navigation rail with those exact anchors.
- [ ] Add compact branded top header/status region.
- [ ] Wrap the canonical `<Home />` once; navigation targets IDs exposed by canonical sections.
- [ ] Add a max-width 900px CSS rule that changes the rail to a top horizontal/scrolling navigation strip.
- [ ] Commit `feat: build light control tower shell`.

### Task 4: Add full recomposition route

**Files:**
- Create: `app/light-full/page.tsx`
- Create: `app/components/control-tower/full-layout.tsx`
- Modify: `app/page.tsx` to add stable section IDs/classes used by composition CSS.
- Create: `app/control-tower-full.module.css`
- Test: `tests/control-tower-ui.test.ts`

**Boundary:** Do not duplicate source fetching or mutations. Full layout reorders the same canonical sections using CSS order/grid rules and stable section classes exposed by `Home`.

- [ ] Add failing tests requiring `LightFullLayout` and one `<Home />` child.
- [ ] Create route wrapper.
- [ ] Implement order: health -> exceptions -> summary -> inbound/receiving -> outbound/parcels -> fulfillment -> inventory -> KPIs.
- [ ] Use responsive grid/order rules with a single-column layout below 900px.
- [ ] Commit `feat: add full light control tower composition`.

### Task 5: Add automation health strip

**Files:**
- Create: `app/components/automation-health/automation-health.tsx`
- Create: `app/components/automation-health/automation-health.module.css`
- Modify: `app/page.tsx`
- Test: `tests/control-tower-ui.test.ts`

**Interfaces:**

```ts
export type AutomationHealthItem = {
  name: string;
  status: "healthy" | "warning" | "error" | "unknown";
  lastSuccess?: string;
  detail?: string;
};
```

- [ ] Add source-level tests requiring labels `Gmail`, `WMS Trucking`, `Parcel Tracking`, `Inventory Sync`, `Snapshot API`, and `Database`.
- [ ] Render those health domains from snapshot health; missing data is `unknown`, never assumed healthy.
- [ ] Show last-success/stale age/error detail text.
- [ ] Provide source/review links when the snapshot exposes them.
- [ ] Commit `feat: surface automation health`.

### Task 6: Add exception/action summary

**Files:**
- Create: `app/components/control-tower/exception-queue.tsx`
- Modify: `app/page.tsx`
- Test: `tests/control-tower-ui.test.ts`

**Interface:** Component inputs are normalized visible items plus pending/reconciliation counts.

- [ ] Add tests for categories `Delayed / Hold / Review`, `Overdue receiving`, `Tracking missing`, `Pending verification`, and `Automation errors`.
- [ ] Group only records whose normalized data satisfies those conditions.
- [ ] Link queue items to the corresponding section/source row when an href exists.
- [ ] Never invent status; derive from normalized data/health only.
- [ ] Commit `feat: add control tower action queue`.

### Task 7: Improve panel/table consistency

**Files:**
- Modify: `app/globals.css`
- Modify: `app/style-variants.module.css`
- Modify: `app/fulfillment-tk-orders.module.css`
- Test: `tests/control-tower-ui.test.ts`

- [ ] Add tests for visible `:focus-visible` rules and responsive overflow/sticky header selectors.
- [ ] Standardize minimum 12px operational table text, row padding, focus rings, sticky table headers, empty/error states, and horizontal overflow behavior.
- [ ] Remove duplicated legend blocks only when the same context is present on every affected row/card; otherwise retain them.
- [ ] Preserve source links and status controls.
- [ ] Commit `style: improve control tower readability`.

### Task 8: Correct KPI presentation language

**Files:**
- Modify: `app/page.tsx`
- Test: `tests/sales-kpis.test.ts`, `tests/style-variants.test.ts`

- [ ] Rename the carrier KPI value header from `Earnings` to `Freight spend`.
- [ ] Change `LOCAL <=50 MI` wording to `LOCAL HEURISTIC` unless a real distance function has been introduced in the KPI task.
- [ ] Keep explanatory KPI method text aligned with actual implementation.
- [ ] Commit `fix: align KPI labels with calculations`.

### Task 9: Accessibility/responsive verification

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `npm run test:e2e` and require the dashboard route smoke tests to pass.
- [ ] Add Playwright assertions in `e2e/dashboard.spec.ts` that each appearance route renders the shared appearance navigation and primary dashboard heading at desktop and mobile viewport sizes.
