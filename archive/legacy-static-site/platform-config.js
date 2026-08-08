"use strict";

/* Central integration manifest.
 * Authenticated providers MUST use a private server-side endpoint.
 * Never place credentials in this public file.
 */

// ---------------------------------------------------------------------------
// Types (JSDoc only — no runtime cost)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ label: string, access: string }} Provider
 *
 * @typedef {{
 *   id:       string,
 *   tab:      string,
 *   range:    string,
 *   kind:     "inbound" | "outbound" | "filter" | "kpi",
 *   provider: string,
 *   gid:      number
 * }} SourceEntry
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REFRESH_MS = 10 * 60 * 1000; // 10 min

/**
 * Creates a frozen Google-Sheets source entry (injects provider automatically).
 * @param {Omit<SourceEntry, "provider">} entry
 * @returns {Readonly<SourceEntry>}
 */
function gSheet(entry) {
  return Object.freeze({ ...entry, provider: "googleSheets" });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STYLEKOREAN_PLATFORM = Object.freeze({
  version: "1.3.0",

  /** How often the UI should re-fetch live data. */
  refreshMs: REFRESH_MS,

  /** Registered data providers. */
  providers: Object.freeze({
    googleSheets: Object.freeze({ label: "Google Sheets",  access: "Public read-only"       }),
    secureApi:    Object.freeze({ label: "Secure API",     access: "Server-side credentials" }),
  }),

  /** Source workbook. */
  workbook: Object.freeze({
    id:    "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc",
    label: "LOGISTICS MASTER 2026",
  }),

  /** Statuses that indicate a shipment is no longer in-flight. */
  finishedStatuses: Object.freeze(["Shipped", "Delivered", "Received", "Completed", "Cancelled"]),

  /** Manual status overrides keyed by tracking/parcel number. */
  parcelStatusOverrides: Object.freeze({
    "4634189291": "Delivered",
  }),

  /** All sheet sources consumed by the platform.
   *  Each entry is individually frozen so callers cannot mutate source objects.
   *  @type {ReadonlyArray<Readonly<SourceEntry>>}
   */
  sources: Object.freeze([
    // — Inbound ——————————————————————————————————————————————————
    gSheet({ id: "imports",            tab: "IMPORTS",                      range: "A:AF", kind: "inbound",  gid: 1497250700 }),

    // — Outbound —————————————————————————————————————————————————
    gSheet({ id: "transfers",          tab: "TRANSFERS",                    range: "A:N",  kind: "outbound", gid: 1834454901 }),
    gSheet({ id: "ulta",               tab: "ULTA",                         range: "A:N",  kind: "outbound", gid:  360479919 }),
    gSheet({ id: "iherb",              tab: "IHERB",                        range: "A:M",  kind: "outbound", gid:  955532469 }),
    gSheet({ id: "b2b",                tab: "B2B/E-COM TRUCKING",           range: "A:R",  kind: "outbound", gid: 1971553563 }),
    gSheet({ id: "wh-trucking",        tab: "WH Trucking Request",          range: "A2:U", kind: "outbound", gid:  852802817 }),
    gSheet({ id: "national-orders",    tab: "NATIONAL ORDER PROGRESS",      range: "A:U",  kind: "outbound", gid: 2026071601 }),
    gSheet({ id: "outbound-schedule",  tab: "Outbound Shipping Schedule",   range: "A3:U", kind: "outbound", gid:   20260708 }),
    gSheet({ id: "tjx-ross",           tab: "TJX/ROSS",                     range: "A:R",  kind: "outbound", gid: 1110009873 }),

    // — Filters ——————————————————————————————————————————————————
    gSheet({ id: "website-exclusions", tab: "OUTBOUND WEBSITE EXCLUSIONS",  range: "A:C",  kind: "filter",   gid: 2026071701 }),
  ]),

  /** KPI slice of the outbound-schedule sheet.
   *  NOTE: shares gid 20260708 with the "outbound-schedule" source above. */
  kpiSource: gSheet({ id: "outbound-kpis", tab: "Outbound Shipping Schedule", range: "Z1:AA5", kind: "kpi", gid: 20260708 }),
});

// Attach to window only when running in a browser context.
if (typeof window !== "undefined") {
  window.STYLEKOREAN_PLATFORM = STYLEKOREAN_PLATFORM;
}
