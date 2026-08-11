# Fulfillment TK Source Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `Fulfillment TK Orders` dashboard card visually match the source `sales.html` design while preserving its existing TK-only data behavior, source link, filtering, and dashboard integration.

**Architecture:** Keep the existing `FulfillmentTkPanel` data flow unchanged and add source-inspired presentation classes only inside the fulfillment card. Use narrowly scoped CSS under `.fulfillment-tk-panel` so Default, Light, and Fulfillment dashboard variants retain their page-level themes while the embedded TK module remains visually recognizable as the fulfillment source.

**Tech Stack:** Next.js/React, TypeScript, CSS, Vitest.

## Global Constraints

- Do not change the fulfillment API URL or the `method === "TK"` filter.
- Do not change Google Sheets, Apps Script, WMS, KPI, or status write-back behavior in this feature.
- Scope source-style overrides to `.fulfillment-tk-panel` and descendants only.
- Preserve the existing `Open source ↗` link and search behavior.
- Preserve USD formatting for money fields.
- Reuse source visual semantics: dark near-black/navy surfaces, blue-gray borders, amber TK treatment, green/red/blue/purple status accents, compact table density, mono-heavy table metadata.
- Do not duplicate the page-level Default/Light/Fulfillment variant implementations.

---

### Task 1: Add Regression Tests for Source-Style Fulfillment Card

**Files:**
- Modify: `tests/style-variants.test.ts`
- Test: `tests/style-variants.test.ts`

**Interfaces:**
- Consumes: existing `.fulfillment-tk-panel`, `.fulfillment-tk-table`, and `FulfillmentTkPanel` component markup.
- Produces: regression assertions that require fulfillment-specific source-style tokens/classes without constraining unrelated dashboard styling.

- [ ] **Step 1: Write failing tests for scoped fulfillment styling**

Add a test that reads `app/globals.css` and verifies the source-inspired fulfillment selectors/tokens exist:

```ts
test("Fulfillment TK card carries source-style dark and amber treatment", () => {
  const css = read("app/globals.css");
  expect(css).toContain(".fulfillment-tk-panel");
  expect(css).toContain("--fulfillment-source-bg");
  expect(css).toContain("--fulfillment-source-surface");
  expect(css).toContain("--fulfillment-source-border");
  expect(css).toContain("--fulfillment-source-amber");
  expect(css).toContain(".fulfillment-tk-method");
  expect(css).toContain(".fulfillment-tk-status");
  expect(css).toContain(".fulfillment-tk-source-link");
});
```

Add a second test that reads the component and requires semantic cell classes rather than styling via fragile column positions:

```ts
test("Fulfillment TK rows expose semantic classes for method, status, and money", () => {
  const source = read("app/fulfillment-tk-panel.tsx");
  expect(source).toContain("function fulfillmentCellClass");
  expect(source).toContain('"fulfillment-tk-method"');
  expect(source).toContain('"fulfillment-tk-status"');
  expect(source).toContain('"fulfillment-tk-money"');
  expect(source).toContain('className="fulfillment-tk-source-link"');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npm test -- tests/style-variants.test.ts
```

Expected: the new tests fail because the fulfillment source-style tokens and semantic classes are not present yet.

- [ ] **Step 3: Commit the red tests**

```bash
git add tests/style-variants.test.ts
git commit -m "test: define fulfillment TK source styling"
```

---

### Task 2: Add Semantic Fulfillment Cell Classes

**Files:**
- Modify: `app/fulfillment-tk-panel.tsx`
- Test: `tests/style-variants.test.ts`

**Interfaces:**
- Consumes: `formatFulfillmentValue(key, value)` and the existing dynamic `columns` array.
- Produces: `fulfillmentCellClass(key: string, rawValue: string): string` and stable classes for method/status/inspection/money cells.

- [ ] **Step 1: Add a semantic class resolver**

Add this helper next to the existing formatting helpers:

```ts
function fulfillmentCellClass(key: string, rawValue: string) {
  const normalizedKey = key.toLowerCase();
  const normalizedValue = rawValue.trim().toLowerCase();
  const classes = ["fulfillment-tk-cell"];

  if (normalizedKey === "method") classes.push("fulfillment-tk-method");
  if (/status|inspection|inspend/.test(normalizedKey)) {
    classes.push("fulfillment-tk-status");
    if (/deliver|complete|approved|pass|ready/.test(normalizedValue)) classes.push("is-success");
    else if (/delay|issue|fail|hold|error/.test(normalizedValue)) classes.push("is-danger");
    else if (/pending|wait/.test(normalizedValue)) classes.push("is-warning");
    else if (/transit|shipping|active|progress/.test(normalizedValue)) classes.push("is-active");
    else if (/pick/.test(normalizedValue)) classes.push("is-picked");
  }
  if (isMoneyField(key)) classes.push("fulfillment-tk-money");
  return classes.join(" ");
}
```

- [ ] **Step 2: Apply classes to dynamic cells and source link**

Replace the plain dynamic table cell with:

```tsx
<td
  className={fulfillmentCellClass(key, rawValue)}
  key={key}
  title={value || undefined}
>
  {value || "—"}
</td>
```

Update the existing source anchor to:

```tsx
<a
  className="fulfillment-tk-source-link"
  href={SOURCE_URL}
  target="_blank"
  rel="noreferrer"
>
  Open source ↗
</a>
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm test -- tests/style-variants.test.ts
```

Expected: semantic-class assertions pass; CSS-token test remains failing until Task 3.

- [ ] **Step 4: Commit semantic markup**

```bash
git add app/fulfillment-tk-panel.tsx tests/style-variants.test.ts
git commit -m "feat: add semantic fulfillment TK cell classes"
```

---

### Task 3: Apply the Source `sales.html` Visual System to the Card

**Files:**
- Modify: `app/globals.css`
- Test: `tests/style-variants.test.ts`

**Interfaces:**
- Consumes: classes produced by `FulfillmentTkPanel` in Task 2.
- Produces: a fully scoped visual treatment under `.fulfillment-tk-panel`.

- [ ] **Step 1: Add source palette tokens scoped to the fulfillment card**

Add these declarations to `.fulfillment-tk-panel`:

```css
.fulfillment-tk-panel {
  --fulfillment-source-bg: #05070d;
  --fulfillment-source-surface: #0d1220;
  --fulfillment-source-surface-2: #131b30;
  --fulfillment-source-border: #212b45;
  --fulfillment-source-border-2: #2a3555;
  --fulfillment-source-text: #edf1f9;
  --fulfillment-source-muted: #aab3cc;
  --fulfillment-source-amber: #f59e0b;
  --fulfillment-source-green: #10d97e;
  --fulfillment-source-red: #ef4444;
  --fulfillment-source-blue: #3b82f6;
  --fulfillment-source-purple: #8b5cf6;
  color: var(--fulfillment-source-text);
  background: var(--fulfillment-source-bg);
  border-color: var(--fulfillment-source-border);
  box-shadow: inset 0 3px 0 var(--fulfillment-source-amber);
}
```

- [ ] **Step 2: Restyle the card heading, count block, toolbar, and source link**

Add scoped rules equivalent to:

```css
.fulfillment-tk-panel .panel-heading,
.fulfillment-tk-panel .inventory-toolbar {
  background: var(--fulfillment-source-surface);
  border-color: var(--fulfillment-source-border);
}
.fulfillment-tk-panel .eyebrow {
  color: var(--fulfillment-source-amber);
  font-family: "IBM Plex Mono", monospace;
}
.fulfillment-tk-panel h2,
.fulfillment-tk-panel .inventory-total strong {
  color: var(--fulfillment-source-text);
}
.fulfillment-tk-panel .inventory-total span,
.fulfillment-tk-panel .inventory-toolbar span {
  color: var(--fulfillment-source-muted);
}
.fulfillment-tk-panel .inventory-toolbar input {
  border-color: var(--fulfillment-source-border);
  background: var(--fulfillment-source-surface-2);
  color: var(--fulfillment-source-text);
}
.fulfillment-tk-panel .inventory-toolbar input::placeholder {
  color: var(--fulfillment-source-muted);
}
.fulfillment-tk-panel .inventory-toolbar input:focus {
  border-color: var(--fulfillment-source-blue);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, .18);
}
.fulfillment-tk-source-link {
  color: #93c1ff;
  font-family: "IBM Plex Mono", monospace;
  font-weight: 700;
  text-decoration: none;
  border-bottom: 1px dashed var(--fulfillment-source-blue);
}
.fulfillment-tk-source-link:hover { color: #c3d8ff; }
```

- [ ] **Step 3: Restyle the table without affecting other inventory tables**

Add:

```css
.fulfillment-tk-panel .inventory-table-wrap {
  border-top-color: var(--fulfillment-source-border);
  background: var(--fulfillment-source-surface);
}
.fulfillment-tk-table th {
  background: var(--fulfillment-source-surface-2);
  color: #c3cbde;
  border-bottom: 1px solid var(--fulfillment-source-border);
  font-family: "IBM Plex Mono", monospace;
}
.fulfillment-tk-table td {
  color: var(--fulfillment-source-text);
  background: var(--fulfillment-source-surface);
  border-bottom-color: var(--fulfillment-source-border);
}
.fulfillment-tk-table tbody tr:hover td {
  background: rgba(255, 255, 255, .025);
}
.fulfillment-tk-table .import-empty {
  color: var(--fulfillment-source-muted);
}
```

- [ ] **Step 4: Add TK and status badge semantics**

Add:

```css
.fulfillment-tk-method,
.fulfillment-tk-status {
  font-family: "IBM Plex Mono", monospace;
  font-weight: 800;
}
.fulfillment-tk-method {
  color: var(--fulfillment-source-amber) !important;
}
.fulfillment-tk-method::before {
  content: "TK";
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 2px 8px;
  border: 1px solid rgba(245, 158, 11, .4);
  border-radius: 6px;
  background: rgba(245, 158, 11, .12);
}
.fulfillment-tk-method {
  font-size: 0;
}
.fulfillment-tk-status.is-success { color: var(--fulfillment-source-green); }
.fulfillment-tk-status.is-danger { color: #ff7a7a; }
.fulfillment-tk-status.is-warning { color: var(--fulfillment-source-amber); }
.fulfillment-tk-status.is-active { color: #8fbbff; }
.fulfillment-tk-status.is-picked { color: #c4b0ff; }
.fulfillment-tk-money {
  color: var(--fulfillment-source-green) !important;
  font-family: "IBM Plex Mono", monospace;
  font-weight: 800;
}
```

If the pseudo-element approach obscures accessibility or copied text during implementation, render a `<span className="fulfillment-tk-method-badge">TK</span>` inside the method cell instead and keep the raw `TK` text available to assistive technology.

- [ ] **Step 5: Add responsive behavior**

Ensure the toolbar can wrap on narrow screens without overflowing:

```css
@media (max-width: 760px) {
  .fulfillment-tk-panel .inventory-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .fulfillment-tk-panel .inventory-toolbar span {
    white-space: normal;
  }
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm test -- tests/style-variants.test.ts
```

Expected: all style-variant and fulfillment source-style tests pass.

- [ ] **Step 7: Commit the visual implementation**

```bash
git add app/globals.css tests/style-variants.test.ts
git commit -m "feat: match fulfillment TK card to source style"
```

---

### Task 4: Verify Existing Data Behavior and Production Build

**Files:**
- Verify: `app/fulfillment-tk-panel.tsx`
- Verify: `app/globals.css`
- Verify: `tests/style-variants.test.ts`

**Interfaces:**
- Consumes: completed component and CSS changes.
- Produces: evidence that the styling change did not alter TK filtering, currency formatting, or variant routes.

- [ ] **Step 1: Run all unit tests**

Run:

```bash
npm test
```

Expected: all Vitest tests pass.

- [ ] **Step 2: Run TypeScript verification**

Run:

```bash
npm run typecheck
```

Expected: exit code 0 with no type errors.

- [ ] **Step 3: Run the production build**

Run:

```bash
npm run build
```

Expected: Next.js production build completes successfully.

- [ ] **Step 4: Verify all three existing dashboard routes**

Start the app and check:

```bash
npm run dev
```

Verify `/`, `/light`, and `/fulfillment-style` all render the same TK data and the Fulfillment TK card retains the source-inspired dark/amber module styling inside each page theme.

- [ ] **Step 5: Verify functional behaviors manually**

Confirm:

```text
1. Only method=TK rows appear in Fulfillment TK Orders.
2. Search still filters rows.
3. Open source ↗ still opens sales.html.
4. Money values still render as USD.
5. Loading, empty, and error states remain readable on the dark card.
6. Other inventory, parcel, KPI, and schedule cards are visually unchanged by the scoped CSS.
```

- [ ] **Step 6: Commit any verification-only adjustment if needed**

If verification requires a narrowly scoped correction, commit only that correction:

```bash
git add app/fulfillment-tk-panel.tsx app/globals.css tests/style-variants.test.ts
git commit -m "fix: harden fulfillment TK source styling"
```

If no correction is needed, do not create an empty commit.
