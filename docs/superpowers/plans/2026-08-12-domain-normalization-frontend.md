# Domain Normalization and Frontend Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract status, identity, carrier, source-adapter, and loading logic from the monolithic dashboard so one canonical domain model powers every appearance route.

**Architecture:** Introduce pure TypeScript domain helpers and source adapters under `lib/`, then refactor `app/page.tsx` to consume them without changing source ownership. Static production stops attempting nonexistent same-origin APIs unless an explicit snapshot endpoint is configured.

**Tech Stack:** Next.js 16 static export, React 19, TypeScript 5.9, Vitest.

## Global Constraints

- One canonical data/write implementation shared by all appearance routes.
- External WMS remains read-only.
- Strong tracking evidence may override a conflicting source carrier; ambiguous numbers preserve the source carrier.
- Static production must not depend on absent `/api/*` routes.

---

### Task 1: Add pure domain status helpers

**Files:**
- Create: `lib/domain/status.ts`
- Test: `tests/domain-status.test.ts`
- Modify: `app/page.tsx`

**Interfaces:**

```ts
export type LogisticsStatus =
  | "Scheduled" | "Work in Progress" | "Pending" | "Shipping" | "Shipped"
  | "Delivered" | "Received" | "Cancelled" | "Completed"
  | "Customs Clearance" | "FDA Review / Hold" | "FWS Review / Hold"
  | "FDA Detained" | "AQI Examination" | "Delayed";

export function normalizeLogisticsStatus(value: unknown): LogisticsStatus | "";
export function isTerminalLogisticsStatus(value: unknown): boolean;
export function canAutoTransitionStatus(current: unknown, next: unknown): boolean;
```

- [ ] Write tests for aliases, empty input, and terminal non-regression.
- [ ] Run `npm test -- tests/domain-status.test.ts` and confirm failure.
- [ ] Implement the exact alias map used by Apps Script.
- [ ] Replace duplicate `finished`/status normalization logic in `page.tsx` where compatible.
- [ ] Run full tests and commit `refactor: centralize logistics status rules`.

### Task 2: Add tracking-number carrier resolver

**Files:**
- Create: `lib/domain/carriers.ts`
- Test: `tests/carriers.test.ts`
- Modify: `app/page.tsx`

**Interfaces:**

```ts
export type CarrierResolution = {
  sourceCarrier: string;
  detectedCarrier: string;
  effectiveCarrier: string;
  confidence: "strong" | "source" | "unknown";
};

export function detectStrongCarrier(tracking: unknown): string;
export function resolveCarrier(sourceCarrier: unknown, tracking: unknown): CarrierResolution;
```

- [ ] Add failing tests:

```ts
expect(resolveCarrier("FedEx", "1ZR08J349024359054").effectiveCarrier).toBe("UPS");
expect(resolveCarrier("FedEx", "4035336068715417909").effectiveCarrier).toBe("FedEx");
expect(resolveCarrier("DHL", "").effectiveCarrier).toBe("DHL");
expect(resolveCarrier("", "TBA123456789").effectiveCarrier).toBe("AMAZON");
```

- [ ] Implement high-confidence patterns for UPS, Amazon, DHL, and strong USPS formats; do not infer FedEx solely from arbitrary long numeric values.
- [ ] Update inbound parcel candidate selection to inspect relevant B/C/K cells before choosing the tracking value, preferring strong carrier-shaped values over ambiguous numeric candidates.
- [ ] Use `effectiveCarrier` for tracking URLs/source badges while retaining source/detected values on the normalized item where practical.
- [ ] Run tests and commit `fix: resolve parcel carriers from strong tracking evidence`.

### Task 3: Add shipment identity helpers

**Files:**
- Create: `lib/domain/identity.ts`
- Test: `tests/identity.test.ts`
- Modify: `app/page.tsx`

**Interfaces:**

```ts
export function normalizeIdentifier(value: unknown): string;
export function truckingGroupKey(customer: unknown, dateKey: unknown): string;
export function exactReferenceMatch(a: unknown, b: unknown): boolean;
```

- [ ] Test case/whitespace normalization and exact trucking group separation.
- [ ] Replace local duplicate identifier helpers where semantics match.
- [ ] Keep inbound evidence-ranked source resolution separate from trucking exact-date grouping.
- [ ] Run full tests and commit `refactor: centralize shipment identity rules`.

### Task 4: Separate source adapters from rendering

**Files:**
- Create: `lib/adapters/imports.ts`
- Create: `lib/adapters/wms-outbound.ts`
- Create: `lib/adapters/nationals-outbound.ts`
- Create: `lib/adapters/inventory.ts`
- Modify: `app/page.tsx`
- Test: `tests/source-adapters.test.ts`

**Interfaces:**
- Each adapter consumes already-fetched raw rows/table payload and returns normalized domain records without fetching or rendering.

- [ ] Move import parsing/boundary logic and parcel extraction to `imports.ts`.
- [ ] Move WMS outbound row mapping to `wms-outbound.ts`.
- [ ] Move National outbound mapping to `nationals-outbound.ts`.
- [ ] Move inventory table normalization/deduplication to `inventory.ts`.
- [ ] Preserve all current source row numbers/URLs and schedule semantics with fixture tests.
- [ ] Run `npm test`, `npm run typecheck`, and commit `refactor: isolate logistics source adapters`.

### Task 5: Remove impossible static `/api` defaults

**Files:**
- Modify: `app/page.tsx`
- Create: `lib/api/operational-client.ts`
- Test: `tests/operational-client.test.ts`

**Interfaces:**

```ts
export function configuredSnapshotEndpoint(): string;
export function configuredStatusEndpoint(): string;
```

Rules:

- `NEXT_PUBLIC_LOGISTICS_SNAPSHOT_URL` empty => skip database/API attempt and read Sheets directly.
- `NEXT_PUBLIC_LOGISTICS_STATUS_URL` empty => use the approved Apps Script write endpoint when configured/defaulted.
- Never fetch `/api/logistics/snapshot` or `/api/logistics/status` in static production unless those URLs are explicitly configured to a reachable absolute endpoint.

- [ ] Add failing tests asserting empty env does not return `/api/...` defaults.
- [ ] Implement endpoint selection.
- [ ] Refactor `fetchOperationalSnapshot()` to attempt a configured snapshot only when non-empty.
- [ ] Set the current canonical Apps Script write deployment as the temporary static write endpoint until the command API replaces it.
- [ ] Run tests/typecheck/build and commit `fix: align data client with static production`.

### Task 6: Reconcile outbound tracking PR behavior

**Files:**
- Review: PR #26
- Modify: `app/page.tsx` or extracted WMS adapter
- Modify: `google-apps-script/InventorySync.gs`
- Test: `tests/carriers.test.ts`, `tests/apps-script-integrity.test.ts`

- [ ] Port only the customer fallback for outbound parcel cards and the useful AUTO TRACK behavior that passes canonical status/identity rules.
- [ ] Replace PR #26's generic numeric FedEx assumption with shared strong-pattern/source-fallback logic.
- [ ] Ensure tracking mutations preserve user issue notes and write a replaceable automation marker/event.
- [ ] Run full tests and commit `feat: reconcile outbound parcel tracking safely`.

### Task 7: Reduce duplicate data fetches

**Files:**
- Modify: `lib/sales-kpis.ts`
- Modify: `app/page.tsx`
- Optionally create: `lib/data/sheet-snapshot.ts`
- Test: `tests/sales-kpis.test.ts`

- [ ] Refactor KPI calculation so it can accept prefetched rows:

```ts
export function computeKpisFromRows(input: {
  nationalRows: string[][];
  wmsRows: string[][];
  truckingRows: string[][];
  transferRows: string[][];
  today?: { year: number; month: number; day: number; code: number };
}): KpiSnapshot;
```

- [ ] Keep `computeLiveKpis()` as a thin fetch wrapper for compatibility.
- [ ] Reuse already fetched WMS data where possible in the eventual snapshot builder.
- [ ] Add deterministic date-fixture tests.
- [ ] Commit `perf: compute KPIs from shared source rows`.

### Task 8: Verify module refactor

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `npm run test:e2e` if the environment supports the browser runtime.
- [ ] Compare `/`, `/light`, `/fulfillment-style` output behavior against pre-refactor fixtures.
