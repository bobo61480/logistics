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

// Builds one CSV line with `width` columns, filling only the given indexes.
function csvRow(width: number, cells: Record<number, string>) {
  const row = new Array<string>(width).fill("");
  for (const [index, value] of Object.entries(cells)) row[Number(index)] = value;
  return row
    .map((value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value))
    .join(",");
}

// IMPORTS tab (gid 1497250700): data starts at sheet row 3.
// Columns: 0 shipment, 2 invoice, 3 MBL, 4 HBL, 7 container, 12 vessel,
// 13 ETD, 14 ETA, 16 delivery expected, 27 WEBSITE STATUS.
const importsCsv = () =>
  [
    csvRow(28, { 0: "IMPORTS" }),
    csvRow(28, { 0: "SHIPMENT" }),
    csvRow(28, {
      0: "HJ99 - 2026",
      2: "IN00777",
      3: "MBL777",
      7: "MSKU1234567",
      12: "EVER GIVEN",
      14: daysFromToday(2),
      27: "SHIPPING",
    }),
  ].join("\n");

// Outbound Shipping Schedule (gid 20260708): single header row.
// Columns: 0 customer, 1 invoice, 3 ship date, 16 carrier, 23 website status.
const outboundCsv = () =>
  [
    csvRow(24, { 0: "CUSTOMER", 1: "INVOICE NO.", 3: "SHIP DATE" }),
    csvRow(24, {
      0: "ULTA BEAUTY",
      1: "IN12345",
      3: daysFromToday(1),
      16: "ABC TRUCKING",
      23: "SCHEDULED",
    }),
  ].join("\n");

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

type MockState = {
  /** Status most recently POSTed to the Apps Script write endpoint. */
  postedStatus: string;
  /** Full payload of the last write, for asserting what would hit the sheet. */
  postedPayload: Record<string, unknown> | null;
};

async function mockWorkbooks(page: Page): Promise<MockState> {
  const state: MockState = { postedStatus: "", postedPayload: null };

  await page.route("https://docs.google.com/**", async (route) => {
    const url = new URL(route.request().url());
    const gid = url.searchParams.get("gid");
    const sheet = url.searchParams.get("sheet");
    const range = url.searchParams.get("range") ?? "";

    if (url.pathname.includes("/export")) {
      if (url.pathname.includes(NATIONAL_SHEET_ID)) return fulfill(route, nationalKpiCsv(), "text/csv");
      if (url.pathname.includes(WMS_SHEET_ID)) return fulfill(route, wmsKpiCsv(), "text/csv");
      if (gid === "852802817") return fulfill(route, truckingKpiCsv(), "text/csv");
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

test("renders live schedules and KPI cards computed from the workbooks", async ({ page }) => {
  await mockWorkbooks(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /StyleKorean\s*Logistics Hub/ })).toBeVisible();
  await expect(page.getByText("3 live workbooks connected")).toBeVisible();

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

  // Lane averages (transfers excluded): local $1,200, out of state $3,400.
  await expect(kpiCard("AVG TRUCKING COST")).toContainText("$1,200");
  await expect(kpiCard("AVG TRUCKING COST")).toContainText("$3,400");
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

test("shows the failure banner when the workbooks are unreachable", async ({ page }) => {
  await page.route("https://docs.google.com/**", (route) =>
    route.fulfill({ status: 500, headers: { "Access-Control-Allow-Origin": "*" }, body: "error" }),
  );
  await page.route("https://script.google.com/**", (route) => route.abort());

  await page.goto("/");

  // Not getByRole("alert"): Next.js adds its own role=alert route announcer.
  const alert = page.locator(".alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Schedule unavailable.");
  await expect(alert).toContainText("(500)");
  await expect(page.getByText("Workbook connection needs attention")).toBeVisible();
});
