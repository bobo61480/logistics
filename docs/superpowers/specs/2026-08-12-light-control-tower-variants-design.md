# Three Control Tower Light Variants — Design

## Goal

Create three distinct Light-mode presentation variants for the StyleKorean logistics dashboard, all inspired by the visual language of the StyleKorean Control Tower reference, while preserving one canonical data, KPI, shipment, tracking, and writeback implementation.

The three variants must differ only in presentation and layout composition. They must not duplicate business logic or change the operational behavior of the production dashboard.

## Approved Routes

- `/` — Original production dashboard
- `/light-skin` — Control Tower visual skin on the existing full-width dashboard structure
- `/light` — Control Tower shell with a top header and left navigation rail
- `/light-full` — Full Control Tower-inspired recomposition of the existing dashboard content
- `/fulfillment-style` — existing Fulfillment presentation

The global appearance switcher will expose all five destinations.

## Source Visual Direction

The three Light variants should share the core StyleKorean Control Tower visual language already established in the project reference:

- bright white / very light neutral canvas
- soft pastel KPI cards
- rounded white content panels
- blue and green operational accents
- compact status chips
- restrained shadows and thin borders
- clean, readable data tables
- compact top-level status/header treatment
- strong information hierarchy with less visual density than the Original theme

The Light variants should feel like members of one visual family, not three unrelated themes.

## Architecture

The canonical dashboard remains the only source of operational data and behavior. The existing `Home` dashboard continues to own:

- Google Sheets reads
- KPI calculations
- inbound/outbound schedule parsing
- Fulfillment TK data
- parcel carrier detection
- Gmail / Apps Script-backed updates
- writeback actions
- auto-refresh behavior
- tracking status behavior
- inventory logic

The three Light routes are presentation wrappers only. They may apply route-specific container classes, layout wrappers, and presentational components, but must reuse the canonical dashboard data and interactive behavior.

No route may fork or copy the data-fetching, tracking, KPI, inventory, or writeback logic.

## Variant 1 — `/light-skin`

### Purpose

Provide the lowest-risk Control Tower interpretation by keeping the existing full-width content order and structure while applying the Control Tower visual system.

### Layout

- no persistent sidebar
- no major section reordering
- same canonical dashboard hierarchy as Original
- full-width responsive shell

### Styling

- white background with soft gray-blue page chrome
- pastel KPI surfaces
- rounded panels with subtle shadows
- softer table headers
- blue/green status accents
- compact modern buttons and filters
- reduced border contrast

### Success Criteria

A user should immediately recognize the Control Tower visual language without needing to learn a new dashboard layout.

## Variant 2 — `/light`

### Purpose

Serve as the primary Light experience and most direct adaptation of the Control Tower shell.

### Layout

- compact branded top header
- left navigation rail on desktop
- collapsible / non-obstructive sidebar behavior on narrow screens
- canonical dashboard content shown in the main workspace
- KPI strip positioned prominently near the top
- consistent content-card spacing

### Sidebar

The sidebar is navigation and orientation only. It must not create a second application state or duplicate controls already present in the canonical dashboard.

It may provide anchor-style navigation to major dashboard sections such as:

- Overview
- Inbound
- Outbound
- Small Parcels
- Fulfillment TK
- Inventory
- Sources / Controls

On mobile or narrow widths, the sidebar must collapse or move above content rather than reducing the dashboard to an unusable width.

### Success Criteria

This route should feel closest to the Control Tower reference while preserving the current dashboard's operational content and behavior.

## Variant 3 — `/light-full`

### Purpose

Provide the most complete Control Tower-inspired visual recomposition using the same operational content.

### Layout Composition

The canonical sections may be visually reorganized into a Control Tower hierarchy, for example:

1. top command/status header
2. KPI overview row
3. primary inbound / outbound operational boards
4. exception and arriving-soon surfaces
5. small-parcel panels
6. Fulfillment TK panel
7. inventory panels
8. sources, controls, and supporting details

The layout may use CSS Grid, route-level wrappers, and `display: contents` where appropriate so sections can be visually repositioned without duplicating their implementation.

### Constraints

- no duplicated live components with separate state
- no duplicated writeback buttons
- no duplicated API/data calls solely for layout purposes
- responsive order must remain understandable on tablets and phones

### Success Criteria

This route should look like a purpose-built Control Tower dashboard rather than a themed version of the Original layout while still behaving identically underneath.

## Shared Appearance Switcher

The shared appearance control must expose:

- Original
- Light Skin
- Light Control Tower
- Light Full
- Fulfillment

Requirements:

- available on every route
- active route visibly highlighted
- semantic navigation with accessible labeling
- links should use stable route URLs rather than local-only theme state
- no duplicated theme switchers inside route wrappers

## Shared Component Strategy

Presentation-only reusable components may be added for the Light family, such as:

- `LightControlTowerShell`
- `LightSidebar`
- `LightHeader`
- route-specific section wrapper classes

These components must not own business logic. They should accept children or render navigational / decorative structure only.

## Styling Strategy

Extend the existing route-scoped style system rather than globally rewriting `globals.css`.

Recommended separation:

- shared Light-family tokens for background, borders, radii, shadows, pastel cards, status accents
- `.lightSkin` route class for `/light-skin`
- `.light` route class for `/light`
- `.lightFull` route class for `/light-full`

Existing Original and Fulfillment styles must remain unaffected.

## Responsive Behavior

All three variants must preserve the production dashboard's ability to display wide tables and dense operational data.

Requirements:

- horizontal scrolling remains available for wide tables
- KPI cards wrap cleanly
- desktop sidebar collapses or relocates on smaller viewports
- full recomposition becomes a single readable column where necessary
- no hidden operational actions due to layout changes

## Accessibility

- appearance navigation uses proper links and `aria-current`
- sidebar navigation is keyboard accessible
- color is not the sole signal for shipment/status meaning
- focus states remain visible
- text and interactive controls maintain usable contrast

## Data and Writeback Constraints

This design changes presentation only.

It must not alter:

- Google Sheets source mappings
- Logistics Master writeback destination
- WMS read behavior
- Apps Script endpoints
- Gmail ingestion behavior
- KPI formulas
- shipment filtering
- tracking-number carrier inference
- Fulfillment TK filtering
- inventory state transitions

The existing hard constraint remains: do not write directly to the StyleKorean/WMS workbook; retain the Logistics Master write path.

## Testing

Add or update tests to verify:

- all five appearance routes exist
- each Light route reuses the canonical Home dashboard
- the shared switcher contains all five destinations
- the active route can be determined from pathname
- route CSS contains the three distinct Light variant classes
- Light Control Tower includes the shell/sidebar presentation layer
- Light Full applies visual section reordering without duplicating data logic
- Original and Fulfillment routes remain unchanged functionally

Verification before deployment must include:

- unit tests
- TypeScript typecheck
- production build
- static generation of all appearance routes
- production deployment workflow
- live HTTP verification of `/`, `/light-skin`, `/light`, `/light-full`, and `/fulfillment-style`

## Non-Goals

This work does not redesign or replace:

- underlying logistics data model
- database / Google Sheets integrations
- Apps Script automation logic
- KPI computation rules
- shipment tracking logic
- inventory movement logic
- Fulfillment source integration

It also does not remove the Original or Fulfillment themes.

## Definition of Done

The work is complete when all three Control Tower-inspired Light variants are available from the shared appearance switcher, each route has a clearly distinct presentation level, all reuse the same canonical operational implementation, tests/typecheck/build pass, and all five production routes are verified live after deployment.
