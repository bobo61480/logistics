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

- [ ] Add failing route/switcher tests.
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
- [ ] Verify no duplicate data hooks/endpoints appear in the route file.
- [ ] Commit `feat: add control tower light skin`.

### Task 3: Upgrade `/light` to Control Tower shell

**Files:**
- Modify: `app/light/page.tsx`
- Create: `app/components/control-tower/light-shell.tsx`
- Modify/Create: `app/control-tower-light.module.css`
- Test: `tests/style-variants.test.ts`

**Interface:**

```tsx
export function LightControlTowerShell({ children }: { children: React.ReactNode })
```

- [ ] Add a slim left navigation rail with anchor links to Overview, Exceptions, Imports, Inventory, Outbound, Fulfillment, and KPIs.
- [ ] Add compact branded top header/status region.
- [ ] Wrap the canonical `<Home />` once; use CSS anchors/section IDs rather than duplicated section components.
- [ ] Ensure mobile view collapses the rail into a horizontal/compact navigation strip.
- [ ] Commit `feat: build light control tower shell`.

### Task 4: Add full recomposition route

**Files:**
- Create: `app/light-full/page.tsx`
- Create: `app/components/control-tower/full-layout.tsx`
- Modify: `app/page.tsx` only to expose reusable section anchors/classes/data if necessary.
- Create: `app/control-tower-full.module.css`
- Test: `tests/style-variants.test.ts`

**Boundary:** Do not duplicate source fetching or mutations. Full layout may reorder canonical sections with CSS/grid/composition wrappers but must consume the same Home/state boundary.

- [ ] Create route wrapper.
- [ ] Recompose hierarchy: health -> exceptions -> summary -> inbound/receiving -> outbound/parcels -> fulfillment -> inventory -> KPIs.
- [ ] Use responsive grid areas and consistent panel headers.
- [ ] Commit `feat: add full light control tower composition`.

### Task 5: Add automation health strip

**Files:**
- Create: `app/components/automation-health/automation-health.tsx`
- Create: `app/components/automation-health/automation-health.module.css`
- Modify: `app/page.tsx`
- Test: `tests/automation-health.test.tsx` or source-level fixture test according to current test setup.

**Interfaces:**

```ts
export type AutomationHealthItem = {
  name: string;
  status: "healthy" | "warning" | "error" | "unknown";
  lastSuccess?: string;
  detail?: string;
};
```

- [ ] Render Gmail, WMS trucking, parcel tracking, inventory sync, snapshot/API, and database/reconciliation state.
- [ ] Show stale age/error count, not just green/red decoration.
- [ ] Provide source/review links when available.
- [ ] Commit `feat: surface automation health`.

### Task 6: Add exception/action summary

**Files:**
- Create: `app/components/control-tower/exception-queue.tsx`
- Modify: `app/page.tsx`
- Test: `tests/exception-queue.test.tsx` or source-level test.

**Interface:** Inputs are already normalized visible items plus pending/reconciliation counts.

- [ ] Group actionable exceptions by delayed/hold/review, overdue receiving, missing tracking, pending verification, and automation errors.
- [ ] Limit the summary to actionable records with links into corresponding sections/source rows.
- [ ] Never invent status; derive from normalized data/health only.
- [ ] Commit `feat: add control tower action queue`.

### Task 7: Improve panel/table consistency

**Files:**
- Modify: `app/globals.css`
- Modify: Light/Fulfillment CSS modules as needed.

- [ ] Standardize minimum text size, row padding, focus rings, sticky headers where useful, empty/error states, and responsive table overflow.
- [ ] Remove duplicated legends where contextual badges already explain mode/department.
- [ ] Preserve source links and status controls.
- [ ] Commit `style: improve control tower readability`.

### Task 8: Correct KPI presentation language

**Files:**
- Modify: `app/page.tsx`
- Test: `tests/sales-kpis.test.ts`, `tests/style-variants.test.ts`

- [ ] Rename `TOP 3 CARRIERS · YTD` earnings column to `Freight spend`/`Cost`.
- [ ] Relabel distance heuristic unless a true distance function has been introduced.
- [ ] Keep explanatory KPI method text aligned with actual implementation.
- [ ] Commit `fix: align KPI labels with calculations`.

### Task 9: Accessibility/responsive verification

- [ ] Keyboard-test style switcher, section navigation, details accordions, status selects, fulfillment modal, and refresh button.
- [ ] Verify 375px, 768px, 1280px, and wide desktop layouts via Playwright screenshots if available.
- [ ] Run `npm run test:e2e`.
- [ ] Run full test/type/build gates.
