import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

/**
 * End-to-end tests for the logistics dashboard.
 *
 * The static export is served by e2e/static-server.mjs; every Google
 * Sheets/Apps Script request the page makes is intercepted and answered with
 * fixtures, so the tests are deterministic and never touch live workbooks.
 */

const NATIONAL_SHEET_ID = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";
const WMS_SHEET_ID = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";
const LOGISTICS_SHEET_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";

// The app derives "today" from the real clock in America/Los_Angeles, so the
// fixtures do the same and place their dates relative to it.
function laToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return new Date(value.year, value.month - 1, value.day);
}

function formatDate(date: Date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

function daysFromToday(offset: number) {
  const date = laToday();
  date.setDate(date.getDate() + offset);
  return formatDate(date);
}

function isoDaysFromToday(offset: number) {
  const date = laToday();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Builds one row with `width` columns, filling only the given indexes.
function rowArray(width: number, cells: Record<number, string>) {
  const row = new Array<string>(width).fill("");
  for (const [index, value] of Object.entries(cells)) row[Number(index)] = value;
  return row;
}

function toCsv(rows: string[][]) {
  return rows
    .map((row) => row.map((value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(","))
    .join("\n");
}

// Builds one CSV line with `width` columns, filling only the given indexes.
function csvRow(width: number, cells: Record<number, string>) {
  return toCsv([rowArray(width, cells)]);
}

// IMPORTS tab (gid 1497250700): data starts at sheet row 3.
// Columns: 0 shipment, 2 invoice, 3 MBL, 4 HBL, 7 container, 12 vessel,
// 13 ETD, 14 ETA, 16 delivery expected, 27 WEBSITE STATUS.
const importsRows = () => [
  rowArray(28, { 0: "IMPORTS" }),
  rowArray(28, { 0: "SHIPMENT" }),
  rowArray(28, {
    0: "HJ99 - 2026",
    2: "IN00777",
    3: "MBL777",
    7: "MSKU1234567",
    12: "EVER GIVEN",
    14: daysFromToday(2),
    27: "SHIPPING",
  }),
];
const importsCsv = () => toCsv(importsRows());

// Outbound Shipping Schedule (gid 20260708): single header row.
// Columns: 0 customer, 1 invoice, 3 ship date, 16 carrier, 23 website status.
const outboundRows = () => [
  rowArray(24, { 0: "CUSTOMER", 1: "INVOICE NO.", 3: "SHIP DATE" }),
  rowArray(24, {
    0: "ULTA BEAUTY",
    1: "IN12345",
    3: daysFromToday(1),
    16: "ABC TRUCKING",
    23: "SCHEDULED",
  }),
];
const outboundCsv = () => toCsv(outboundRows());

// KPI workbooks — every row dated today so MTD and YTD are identical and the
// expected card values below hold on any day the suite runs.
const nationalKpiCsv = () =>
  [
    csvRow(8, { 0: "STATUS", 4: "AMOUNT", 6: "ORDER DATE" }),
    csvRow(8, { 0: "active", 4: "1500", 6: daysFromToday(0) }),
    csvRow(8, { 0: "cancelled", 4: "999", 6: daysFromToday(0) }),
  ].join("\n");

const wmsKpiCsv = () =>
  [
    csvRow(7, { 0: "WMS" }),
    csvRow(7, { 0: "DATE", 6: "INVOICE AMOUNT" }),
    csvRow(7, { 0: daysFromToday(0), 6: "2000" }),
  ].join("\n");

// Trucking tab: 2 header rows; 2 dest, 3 date, 4 load, 16 carrier, 17 rate, 21 invoice.
const truckingKpiCsv = () =>
  [
    csvRow(22, {}),
    csvRow(22, {}),
    csvRow(22, { 2: "Buena Park, CA", 3: daysFromToday(0), 4: "2 PLTS", 16: "ABC TRUCKING", 21: "$1,200" }),
    csvRow(22, { 2: "Edison, NJ", 3: daysFromToday(0), 4: "FTL", 16: "XYZ FREIGHT", 17: "$3,400" }),
  ].join("\n");

// Transfers tab: 1 header row; 1 load, 4 dest, 5 date, 6 carrier, 9 invoice.
const transferKpiCsv = () =>
  [
    csvRow(10, {}),
    csvRow(10, { 1: "FTL", 4: "Edison, NJ", 5: daysFromToday(0), 6: "TRANSFER CO", 9: "$5,000" }),
  ].join("\n");

const EMPTY_GVIZ =
  'google.visualization.Query.setResponse({"version":"0.6","table":{"cols":[],"rows":[]}});';

function gvizStatus(status: string) {
  return `google.visualization.Query.setResponse({"version":"0.6","table":{"cols":[{"label":""}],"rows":[{"c":[{"v":${JSON.stringify(status)}}]}]}});`;
}

const fulfill = (route: Route, body: string, contentType = "text/plain") =>
  route.fulfill({
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    contentType,
    body,
  });

// Feed rendered by the Shipment Notices card, served inside the Worker snapshot.
const gmailIngestionEvents = () => [
  {
    status: "needsReview",
    kind: "inbound",
    shipmentId: "IN00778",
    customer: "ACME KOREA",
    invoice: "IN00778",
    blOrPro: "",
    container: "",
    shipDateOrEta: "",
    carrierOrVessel: "EVER GIVEN",
    note: "",
    issues: "No ETA or ship date found.",
    sourceEmailUrl: "https://mail.google.com/mail/u/0/#all/pending1",
    driveFileUrl: "",
    timestamp: "2026-08-17 09:15",
  },
  {
    status: "committed",
    kind: "inbound",
    shipmentId: "IN00777",
    customer: "",
    invoice: "IN00777",
    blOrPro: "MBL777",
    container: "MSKU1234567",
    shipDateOrEta: "",
    carrierOrVessel: "EVER GIVEN",
    note: "Received: IN00777 · MSKU1234567 · ETA 8/30",
    issues: "",
    sourceEmailUrl: "https://mail.google.com/mail/u/0/#all/abc123",
    driveFileUrl: "",
    timestamp: "",
  },
];

// KPI payload the Worker computes server-side and embeds in every snapshot.
// Providing it here keeps the fixture faithful to production (the Worker
// always ships computed KPIs) and, critically, keeps the browser off the
// `snapshot.kpis ?? fetchLiveKpis()` path — which would read Google Sheets
// directly and violate the D1-only frontend contract. The render test asserts
// no docs.google.com traffic to guard that boundary. Every field is dated
// "today" in spirit, so MTD and YTD are identical.
const workerKpis = () => ({
  shippingMtd: 9600,
  shippingYtd: 9600,
  transfersMtd: 5000,
  transfersYtd: 5000,
  njTransferMtd: 5000,
  njTransferYtd: 5000,
  nationalsSalesMtd: 1500,
  nationalsSalesYtd: 1500,
  wmsSalesMtd: 2000,
  wmsSalesYtd: 2000,
  topCarriers: [
    { name: "TRANSFER CO", earnings: 5000, moves: 1, shipmentPercent: 33.3 },
    { name: "XYZ FREIGHT", earnings: 3400, moves: 1, shipmentPercent: 33.3 },
    { name: "ABC TRUCKING", earnings: 1200, moves: 1, shipmentPercent: 33.3 },
  ],
  ltlPercent: 33,
  ftlPercent: 67,
  truckingMtd: 4600,
  truckingYtd: 4600,
  totalLocal: 0,
  totalCalifornia: 1200,
  totalOutOfState: 3400,
  totalLocalMtd: 0,
  totalCaliforniaMtd: 1200,
  totalOutOfStateMtd: 3400,
});

// Same shape the Worker's /api/logistics/snapshot returns. The canonical
// frontend path is D1-only (the Worker persists to and serves from D1, so
// `storage` is always "d1" — there is no browser-side direct-Sheets fallback),
// and the Worker embeds the computed KPI payload so the browser never reads
// workbooks itself.
const workerSnapshot = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  generatedAt: new Date().toISOString(),
  storage: "d1",
  stale: false,
  version: "worker-e2e",
  sourceHealth: [],
  sources: {
    imports: importsRows(),
    outbound: outboundRows(),
    outboundMeta: { sheetName: "Outbound Shipping Schedule", headerRow: 1, rowCount: 1, fallback: false },
    nationalOutbound: { cols: [], rows: [] },
    salesOutbound: { cols: [], rows: [] },
    inventoryDashboardTable: null,
    skwInboundTable: null,
    skwStockTable: null,
    gmailIngestion: gmailIngestionEvents(),
  },
  kpis: workerKpis(),
  ...overrides,
});

type MockState = {
  /** Status most recently POSTed to the status write endpoint. */
  postedStatus: string;
  /** Full payload of the last write, for asserting what would hit the sheet. */
  postedPayload: Record<string, unknown> | null;
};

async function mockWorkbooks(page: Page): Promise<MockState> {
  const state: MockState = { postedStatus: "", postedPayload: null };

  // Same-origin Worker API. The static export has no Worker behind it, so
  // these routes stand in for /api/logistics/* in the e2e environment.
  await page.route("**/api/logistics/health**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        version: "worker-e2e",
        dataStore: "sheets",
        databaseConfigured: false,
        databaseReady: false,
        statusWriteConfigured: true,
        statusWriteMode: "apps-script",
      }),
    }),
  );

  await page.route("**/api/logistics/snapshot**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workerSnapshot()) }),
  );

  await page.route("**/api/logistics/status**", async (route) => {
    const payload = JSON.parse(route.request().postData() ?? "{}");
    state.postedPayload = payload;
    state.postedStatus = String(payload.status ?? "");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, status: payload.status }),
    });
  });

  await page.route("https://docs.google.com/**", async (route) => {
    const url = new URL(route.request().url());
    const gid = url.searchParams.get("gid");
    const sheet = url.searchParams.get("sheet");
    const range = url.searchParams.get("range") ?? "";

    if (url.pathname.includes("/export")) {
      if (url.pathname.includes(NATIONAL_SHEET_ID)) return fulfill(route, nationalKpiCsv(), "text/csv");
      if (url.pathname.includes(WMS_SHEET_ID)) return fulfill(route, wmsKpiCsv(), "text/csv");
      // WH Trucking Request (KPI freight source) — gid 1418033635; the old
      // 852802817 tab no longer exists in the workbook.
      if (gid === "1418033635") return fulfill(route, truckingKpiCsv(), "text/csv");
      if (gid === "1834454901") return fulfill(route, transferKpiCsv(), "text/csv");
      if (gid === "1497250700") return fulfill(route, importsCsv(), "text/csv");
      if (gid === "20260708") return fulfill(route, outboundCsv(), "text/csv");
      return fulfill(route, "", "text/csv");
    }

    if (url.pathname.includes("/gviz/")) {
      // postStatus verifies the write by re-reading the edited status cell.
      if (range.startsWith("AB") || range.startsWith("U")) {
        return fulfill(route, gvizStatus(state.postedStatus));
      }
      // Optional inventory tabs are absent in the fixture workbook.
      if (sheet) return route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "" });
      return fulfill(route, EMPTY_GVIZ);
    }

    return route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "" });
  });

  await page.route("https://script.google.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("op") === "getSalesOverview") {
      return fulfill(
        route,
        JSON.stringify({
          ok: true,
          jobs: [
            {
              invoice: "INTK001",
              remarks: "TK TEST CUSTOMER",
              shipDate: isoDaysFromToday(3),
              method: "TK",
              amount: "1250.50",
              pickStart: "08:15",
              pickComplete: false,
              inspection: "",
              movedToPacking: false,
              dimsCount: 0,
            },
            {
              invoice: "INUPS001",
              remarks: "UPS SHOULD NOT IMPORT",
              shipDate: isoDaysFromToday(4),
              method: "UPS",
              amount: "99.00",
            },
          ],
        }),
        "application/json",
      );
    }
    const payload = JSON.parse(route.request().postData() ?? "{}");
    state.postedPayload = payload;
    state.postedStatus = String(payload.status ?? "");
    return fulfill(
      route,
      JSON.stringify({ ok: true, row: payload.sourceRow }),
      "application/json",
    );
  });

  return state;
}

test("renders live schedules and KPI cards from the D1 snapshot", async ({ page }) => {
  // The frontend is D1-only: everything on the page must come from the Worker
  // snapshot, never a direct browser read of Google Sheets. Record any such
  // read so the assertion at the end fails loudly if the D1 boundary regresses
  // (e.g. an omitted KPI payload falling back to fetchLiveKpis()).
  const directSheetReads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("docs.google.com")) directSheetReads.push(request.url());
  });

  await mockWorkbooks(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /StyleKorean\s*Logistics Hub/ })).toBeVisible();
  await expect(page.getByText("D1 snapshot · Sheets fallback ready")).toBeVisible();

  // Import Schedules table row from the IMPORTS fixture.
  const importTable = page.locator(".import-table");
  await expect(importTable).toContainText("HJ99 - 2026");
  await expect(importTable).toContainText("MSKU1234567");
  await expect(importTable).toContainText("EVER GIVEN");
  // Container prefix MSKU must deep-link to Maersk tracking.
  await expect(importTable.locator('a[href*="maersk.com/tracking"]')).toHaveCount(1);
  // An ocean SCAC-style container number classifies the shipment as Ocean.
  await expect(page.locator(".import-totals")).toContainText("1 Ocean");

  // Outbound trucking board shows the Outbound Shipping Schedule fixture.
  await expect(page.locator(".outbound-panel")).toContainText("ULTA BEAUTY");

  // Fulfillment Orders panel lists the live WMS jobs across all methods.
  const fulfillment = page.locator(".fulfillment-tk-panel");
  await expect(fulfillment).toContainText("INTK001");
  await expect(fulfillment).toContainText("TK TEST CUSTOMER");
  await expect(fulfillment).toContainText("UPS SHOULD NOT IMPORT");
  await expect(fulfillment).toContainText("$1,349.50"); // $1,250.50 + $99.00 header total
  await expect(fulfillment.getByRole("link", { name: "View Source ↗" })).toHaveAttribute(
    "href",
    "https://sk-b2b-mobile.github.io/fulfillment/sales.html",
  );

  // KPI cards: values derived from the fixture workbooks (all dated today,
  // so MTD === YTD): trucking $1,200 + $3,400 + transfer $5,000.
  const kpiCard = (title: string) => page.locator(".kpi-card", { hasText: title });
  await expect(kpiCard("SHIPPING COSTS")).toContainText("$9,600");
  await expect(kpiCard("TRANSFER SHIPPING")).toContainText("$5,000");
  await expect(kpiCard("TRUCKING TRANSFERS TO NJ")).toContainText("$5,000");
  await expect(kpiCard("SALES · NATIONALS")).toContainText("$1,500.00");
  await expect(kpiCard("SALES · WMS WHOLESALE")).toContainText("$2,000.00");

  // Carrier ranking: 3 named carriers with one move each → 33.3% share.
  const carriers = page.locator(".carrier-ranking li");
  await expect(carriers).toHaveCount(3);
  await expect(carriers.first()).toContainText("TRANSFER CO");
  await expect(carriers.first()).toContainText("$5,000");
  await expect(carriers.first()).toContainText("33.3%");

  // Truckload mix: 1 LTL vs 2 FTL.
  await expect(kpiCard("TRUCKLOAD MIX")).toContainText("33%");
  await expect(kpiCard("TRUCKLOAD MIX")).toContainText("67%");

  // Total trucking cost (transfers excluded): all trucking $4,600, with the
  // California lane $1,200 and the out-of-state lane $3,400.
  await expect(kpiCard("TOTAL TRUCKING COST")).toContainText("$4,600");
  await expect(kpiCard("TOTAL TRUCKING COST")).toContainText("$1,200");
  await expect(kpiCard("TOTAL TRUCKING COST")).toContainText("$3,400");

  // Shipment Notices card renders the snapshot's ingestion feed. The same
  // ingestion events also surface in the event tracker and as derived import
  // rows, so scope these assertions to the Shipment Notices card itself.
  await expect(page.getByRole("heading", { name: "Shipment Notices" })).toBeVisible();
  const notices = page.locator("section", { has: page.getByRole("heading", { name: "Shipment Notices" }) });
  await expect(notices.getByRole("button", { name: "Needs review (1)" })).toBeVisible();
  await expect(notices.getByText("IN00778")).toBeVisible();
  await expect(notices.getByText("No ETA or ship date found.")).toBeVisible();
  // A silently-committed row surfaces its "Received: ..." summary prominently.
  await expect(notices.getByText("Received: IN00777 · MSKU1234567 · ETA 8/30")).toBeVisible();
  await expect(notices.getByRole("link", { name: "Source email" }).first()).toHaveAttribute(
    "href",
    "https://mail.google.com/mail/u/0/#all/pending1",
  );

  // Drive Archive card offers the document quick links.
  await expect(page.getByRole("heading", { name: "Document Folders" })).toBeVisible();
  await expect(page.getByRole("link", { name: /SK Logistics Email Archive/ })).toBeVisible();

  // D1 boundary: the fully rendered page must not have read Google Sheets
  // directly. Any docs.google.com request means a component bypassed the
  // Worker snapshot (the KPI fallback being the most likely culprit).
  expect(directSheetReads, `unexpected direct Sheets reads: ${directSheetReads.join(", ")}`).toEqual([]);
});

test("saves a status edit through the Apps Script endpoint and confirms it", async ({ page }) => {
  const state = await mockWorkbooks(page);
  await page.goto("/");

  // The same shipment also renders as a board card with an identically
  // labelled select, so scope to the Import Schedules table.
  const statusSelect = page.locator(".import-table").getByLabel("Update HJ99 - 2026 status");
  await expect(statusSelect).toBeVisible();
  await expect(statusSelect).toHaveValue("Shipping");

  await statusSelect.selectOption("Customs Clearance");

  // The card only updates after the endpoint confirms AND the re-read of the
  // status cell returns the new value (mocked via state.postedStatus).
  await expect(page.locator(".toast")).toContainText("HJ99 - 2026 updated to Customs Clearance.");
  await expect(statusSelect).toHaveValue("Customs Clearance");

  // The write payload targets the exact source row with full identifiers.
  expect(state.postedPayload).toMatchObject({
    kind: "inbound",
    sourceSheet: "IMPORTS",
    sourceRow: 3,
    shipmentNo: "HJ99 - 2026",
    container: "MSKU1234567",
    currentStatus: "Shipping",
    status: "Customs Clearance",
  });

  // Marking the shipment Delivered counts as finished, so the row leaves the
  // "current + upcoming" Import Schedules table entirely.
  await statusSelect.selectOption("Delivered");
  await expect(page.locator(".import-table")).not.toContainText("HJ99 - 2026");
  expect(state.postedStatus).toBe("Delivered");
});

test("shows the failure banner when the Worker snapshot endpoint fails", async ({ page }) => {
  // The frontend reads only the same-origin Worker snapshot endpoint (no
  // direct-Sheets fallback), so a total outage surfaces as a failed
  // /api/logistics/snapshot response. A body without an `error` field makes
  // the app fall back to its "(status)" message.
  await page.route("**/api/logistics/snapshot**", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false }) }),
  );
  // Keep all external traffic isolated: the Fulfillment card independently
  // calls the Apps Script getSalesOverview endpoint, which must not escape to
  // the live network (and would otherwise stall on its 25s timeout).
  await page.route("https://script.google.com/**", (route) => route.abort());
  await page.route("https://docs.google.com/**", (route) => route.abort());

  await page.goto("/");

  // Not getByRole("alert"): Next.js adds its own role=alert route announcer.
  const alert = page.locator(".alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Schedule unavailable.");
  await expect(alert).toContainText("(500)");
  await expect(page.getByText("Workbook connection needs attention")).toBeVisible();
});

test("serves the last good D1 snapshot with a continuity marker during a source outage", async ({ page }) => {
  // When Google Sheets / Apps Script refreshes fail but D1 still holds the
  // last good snapshot, the Worker serves that snapshot with stale: true.
  // D1 remains the authority — the schedule stays visible and the sync strip
  // switches to the continuity marker rather than a failure banner.
  await mockWorkbooks(page);
  await page.unroute("**/api/logistics/snapshot**");
  await page.route("**/api/logistics/snapshot**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        workerSnapshot({
          stale: true,
          staleReason: "The durable snapshot is refreshing in the background",
        }),
      ),
    }),
  );

  await page.goto("/");

  // Continuity, not failure: the D1 schedule still renders, the sync strip
  // shows the continuity marker, and the continuity banner (a status, not an
  // error) explains the state — while the "Schedule unavailable" failure
  // banner stays absent.
  await expect(page.getByText("Last good snapshot · live sources reconnecting")).toBeVisible();
  await expect(page.locator(".import-table")).toContainText("HJ99 - 2026");
  await expect(page.locator(".alert.warning")).toContainText("Continuity mode.");
  await expect(page.getByText("Schedule unavailable.")).toHaveCount(0);
});

test("degrades KPIs without reading Sheets when the Worker ships no KPI payload", async ({ page }) => {
  // The Worker persists kpis: null when its KPI computation fails. The browser
  // must degrade to empty KPIs — never fall back to reading Google Sheets
  // directly — so the D1 boundary holds even on the KPI-failure path.
  const directSheetReads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("docs.google.com")) directSheetReads.push(request.url());
  });

  await mockWorkbooks(page);
  await page.unroute("**/api/logistics/snapshot**");
  await page.route("**/api/logistics/snapshot**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(workerSnapshot({ kpis: null })),
    }),
  );

  await page.goto("/");

  // The rest of the D1 snapshot still renders, and the carrier KPI card
  // degrades to its unavailable state instead of triggering a workbook read.
  await expect(page.locator(".import-table")).toContainText("HJ99 - 2026");
  await expect(page.locator(".carrier-ranking")).toContainText("Carrier data unavailable");
  expect(directSheetReads, `unexpected direct Sheets reads: ${directSheetReads.join(", ")}`).toEqual([]);
});
