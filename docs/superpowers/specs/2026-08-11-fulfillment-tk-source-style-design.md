# Fulfillment TK Source Style Design

## Goal

Restyle the existing **Fulfillment TK Orders** dashboard card so it visually matches the source fulfillment page at `https://sk-b2b-mobile.github.io/fulfillment/sales.html` while preserving the current dashboard layout, TK-only filtering, data loading, links, synchronization, and write-back architecture.

## Scope

This change is presentation-only for the Fulfillment TK module. It must not alter the source API, shipment parsing, status write-back behavior, KPI logic, or the master-workbook write path.

## Source visual language

The dashboard card should reuse the source page's visual system:

- Near-black page/card background family (`#05070D` / dark navy surfaces).
- Dark navy secondary surfaces (`#0D1220`, `#131B30`).
- Blue-gray borders (`#212B45`, `#2A3555`).
- Primary text in a bright cool off-white and secondary text in muted blue-gray.
- Inter for general UI text and JetBrains Mono for compact data/status/meta text.
- TK method accents in amber.
- Green for successful/completed/pass states.
- Red for issue/error states.
- Blue for links and informational states.
- Purple only where the source page uses it; do not introduce decorative color outside the source system.

## Component behavior

`app/fulfillment-tk-panel.tsx` remains the data/rendering component. It continues to:

- Filter incoming jobs to `method === "TK"`.
- Preserve the current search box and count/total summary.
- Preserve the source-link behavior.
- Preserve currency formatting.
- Preserve loading, empty, and error states.

Only semantic class names needed for source-style badges/cells may be added.

## Styling boundary

All fulfillment-specific styling must be scoped beneath `.fulfillment-tk-panel` (or a child class) in `app/globals.css` so Default and Light dashboard variants do not unintentionally inherit fulfillment colors elsewhere.

The card should look like a recognizable embedded module from the fulfillment source even when the surrounding dashboard is using another site theme.

## Table styling

The Fulfillment TK table should follow the source page's table treatment:

- Dark surface background.
- Compact row height and padding.
- Mono uppercase header labels with muted bright text.
- Subtle row separators.
- Very light hover lift/background change.
- No green-tinted column backgrounds.
- Amounts remain formatted as USD.

## Status and method styling

- `TK` method values use the same amber treatment as the source page's trucking/TK badge.
- Successful/completed/pass-like values use green.
- Issue/error/problem values use red.
- Pending/waiting/in-progress values use muted/amber treatment appropriate to the source.
- Informational links use source-style blue.
- Unknown values remain neutral; do not infer new business state from color alone.

## Toolbar and source link

The search field, counts, and `Open source ↗` link should match the source page's compact dark-toolbar presentation. The source link stays external and opens in a new tab.

## Accessibility

- Maintain readable contrast in all three dashboard variants.
- Preserve visible focus states for the search input and source link.
- Do not encode shipment state by color alone; text remains visible.

## Non-goals

This change does **not**:

- Change the fulfillment API endpoint.
- Change TK filtering rules.
- Change the dashboard's shipment carrier inference logic.
- Change Google Sheets structure or formulas.
- Change write-back routing.
- Rebuild the entire dashboard in the fulfillment theme.

## Verification

The implementation is complete when:

1. The Fulfillment TK card visually matches the source page's dark/amber/green/blue system.
2. TK filtering and search return the same records as before.
3. Amount formatting remains correct.
4. Loading/error/empty states remain functional.
5. The scoped styles do not recolor other dashboard cards.
6. Existing tests pass and a focused UI regression test confirms the fulfillment-specific class/styling hooks.
