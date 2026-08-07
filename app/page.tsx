"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INBOUND_DOCUMENT_LINKS, INBOUND_PACKING_LIST_LINKS } from "./inbound-links";
import { INBOUND_INVOICE_LINKS } from "./inbound-invoice-links";
import { packingListPallets } from "./inbound-pallets";
import { computeLiveKpis } from "../lib/sales-kpis";

const SHEET_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const NATIONAL_SHEET_ID = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";
const NATIONAL_SHEET_URL = `https://docs.google.com/spreadsheets/d/${NATIONAL_SHEET_ID}/edit?gid=99300389#gid=99300389`;
const SALES_SHEET_ID = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";
const SALES_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SALES_SHEET_ID}/edit?gid=0#gid=0`;
const SALES_SNAPSHOT = {
  nationalsMtd: 2_209_375.46,
  nationalsYtd: 6_244_884.52,
  wmsMtd: 3_601_652.95,
  wmsYtd: 15_591_074.08,
};
// Deployed from google-apps-script/Code.gs (doPost), bound to LOGISTICS MASTER 2026.
// VERIFY: confirm this /exec URL is the CURRENT deployment of google-apps-script/Code.gs --
// if you redeploy that script, Apps Script gives you a new URL and this must be updated too.
const WRITE_ENDPOINT =
  "https://script.google.com/a/macros/stylekoreanus.com/s/AKfycbwyVnU2jvOtMFXuY7KtX_8-hHXYVLrc6R2Dr_6akdDaTGQPc8duSo7tpguIuk00MjDl/exec";
const AUTO_REFRESH_MS = 30 * 60 * 1000;

type Direction = "inbound" | "outbound";
type OutboundDepartment = "Wholesale" | "B2B/E-Com" | "Nationals" | "MBX" | "NJ";

type ScheduleItem = {
  id: string;
  direction: Direction;
  date: Date;
  dateText: string;
  title: string;
  reference: string;
  secondary: string;
  status: string;
  sourceSheet: string;
  sourceRow: number;
  sourceUrl?: string;
  editable?: boolean;
  customer?: string;
  customerNo?: string;
  po?: string;
  invoice?: string;
  shipmentNo?: string;
  shipmentUrl?: string;
  invoiceUrl?: string;
  container?: string;
  containerUrl?: string;
  mbl?: string;
  hbl?: string;
  pro?: string;
  carrier?: string;
  carrierReference?: string;
  trackingNumber?: string;
  shipDate?: string;
  mode?: string;
  vessel?: string;
  pod?: string;
  eta?: string;
  isSmallParcel?: boolean;
  shippingMethod?: string;
  sourceType?: string;
  department?: OutboundDepartment;
};

type KpiSnapshot = {
  shippingMtd: number;
  shippingYtd: number;
  transfersMtd: number;
  transfersYtd: number;
  njTransferMtd: number;
  njTransferYtd: number;
  nationalsSalesMtd: number;
  nationalsSalesYtd: number;
  wmsSalesMtd: number;
  wmsSalesYtd: number;
  topCarriers: Array<{
    name: string;
    earnings: number;
    moves: number;
    shipmentPercent: number;
  }>;
  ltlPercent: number;
  ftlPercent: number;
  avgLocal: number;
  avgCalifornia: number;
  avgOutOfState: number;
  avgLocalMtd: number;
  avgCaliforniaMtd: number;
  avgOutOfStateMtd: number;
};

type InventoryItem = {
  id: string;
  shipmentNo: string;
  productName: string;
  sku: string;
  upc: string;
  expirationDate: string;
  palletNumber?: string;
  quantity: number;
  location: string;
  status: string;
};

type InventoryCollections = {
  inbound: InventoryItem[];
  inStock: InventoryItem[];
};

const EMPTY_KPIS: KpiSnapshot = {
  shippingMtd: 0,
  shippingYtd: 0,
  transfersMtd: 0,
  transfersYtd: 0,
  njTransferMtd: 0,
  njTransferYtd: 0,
  nationalsSalesMtd: SALES_SNAPSHOT.nationalsMtd,
  nationalsSalesYtd: SALES_SNAPSHOT.nationalsYtd,
  wmsSalesMtd: SALES_SNAPSHOT.wmsMtd,
  wmsSalesYtd: SALES_SNAPSHOT.wmsYtd,
  topCarriers: [],
  ltlPercent: 0,
  ftlPercent: 0,
  avgLocal: 0,
  avgCalifornia: 0,
  avgOutOfState: 0,
  avgLocalMtd: 0,
  avgCaliforniaMtd: 0,
  avgOutOfStateMtd: 0,
};

const SOURCE_LEGEND = [
  "Wholesale",
  "Ocean",
  "Air",
  "UPS (Parcel)",
  "FedEx (Parcel)",
  "USPS",
  "Amazon",
  "DHL (Small Parcel)",
  "UPS (Freight)",
  "FedEx (Freight)",
  "DHL (Freight)",
];

const DEPARTMENT_LEGEND: OutboundDepartment[] = [
  "Wholesale",
  "B2B/E-Com",
  "Nationals",
  "MBX",
  "NJ",
];

const STATUS_OPTIONS = [
  "Scheduled",
  "Work in Progress",
  "Pending",
  "Shipping",
  "Shipped",
  "Delivered",
  "Received",
  "Cancelled",
  "Completed",
];

const INBOUND_STATUS_OPTIONS = [
  ...STATUS_OPTIONS,
  "Customs Clearance",
  "FDA Review/Hold",
  "FWS Review/Hold",
  "Delayed",
];

const finished = new Set(["shipped", "delivered", "received", "cancelled", "completed"]);
const finishedImports = new Set(["delivered", "received", "cancelled", "completed"]);

// Defined here (before IMPORT_STALE_CUTOFF) so the IIFE below has no forward-reference
// dependency on the later startOfToday declaration.
function startOfToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Number(value.year), Number(value.month) - 1, Number(value.day));
}

// Any import whose ETA is before this date is treated as effectively received/delivered/completed
// and hidden from the "current + upcoming" Import Schedules table, even if the sheet's Status
// cell is blank or stale. This does not overwrite the Status column in the source spreadsheet.
//
// This used to be a fixed literal date, which meant it silently stopped working once "today"
// caught up to it -- every row eventually aged past the cutoff and the whole table (and the
// Inbound Schedule calendar it feeds) went empty. It's now a rolling window measured back from
// today, computed at module load, so it keeps working without needing a manual date bump.
const IMPORT_STALE_WINDOW_DAYS = 30;
const IMPORT_STALE_CUTOFF = (() => {
  const cutoff = startOfToday();
  cutoff.setDate(cutoff.getDate() - IMPORT_STALE_WINDOW_DAYS);
  return cutoff.getTime();
})();

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function cell(row: any, index: number) {
  if (Array.isArray(row)) return clean(row[index]);
  const value = row?.c?.[index];
  return clean(value?.f ?? value?.v ?? "");
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function parseGviz(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("The workbook returned an unreadable response.");
  const payload = JSON.parse(text.slice(start, end + 1));
  if (!payload.table) throw new Error("No schedule data was returned.");
  return payload.table;
}

function parseDate(value: string) {
  const full = value.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (full) {
    let year = Number(full[3]);
    if (year < 100) year += 2000;
    return new Date(year, Number(full[1]) - 1, Number(full[2]));
  }
  const short = value.match(/(\d{1,2})\/(\d{1,2})/);
  if (!short) return null;
  const today = new Date();
  const candidates = [-1, 0, 1].map(
    (offset) => new Date(today.getFullYear() + offset, Number(short[1]) - 1, Number(short[2])),
  );
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate.getTime() - today.getTime()) <
    Math.abs(best.getTime() - today.getTime())
      ? candidate
      : best,
  );
}

function parseMoney(value: string) {
  const text = clean(value).toUpperCase();
  if (!text || /^(N\/?A|NONE|PENDING|WAIVED|-)$/.test(text)) return 0;
  const match = text.replace(/[$,\s]/g, "").match(/-?\d+(?:\.\d+)?(?:[KMB])?/);
  if (!match) return 0;
  const suffix = match[0].slice(-1);
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  const numberText = multiplier === 1 ? match[0] : match[0].slice(0, -1);
  const amount = Number(numberText) * multiplier;
  return Number.isFinite(amount) ? amount : 0;
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function moneyWithCents(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function statusClass(status: string) {
  const value = status.toLowerCase();
  if (/delay|hold|review|pending/.test(value)) return "status warning";
  if (/deliver|receive|complete|shipped/.test(value)) return "status done";
  if (/work|shipping|clearance/.test(value)) return "status active";
  return "status";
}

function importsCellUrl(row: number, column: string) {
  return `${SHEET_URL}?gid=1497250700&range=${column}${row}#gid=1497250700&range=${column}${row}`;
}

function sourceRowUrl(item: ScheduleItem) {
  if (item.direction === "inbound") {
    if (item.sourceSheet === "INBOUND SHIPMENTS DATA") {
      return `${SHEET_URL}?gid=2026070701&range=A${item.sourceRow}#gid=2026070701&range=A${item.sourceRow}`;
    }
    return importsCellUrl(item.sourceRow, "A");
  }
  if (item.sourceSheet === "Outbound Shipping Schedule") {
    return `${SHEET_URL}?gid=20260708&range=A${item.sourceRow}#gid=20260708&range=A${item.sourceRow}`;
  }
  if (item.sourceSheet === "NATIONAL ORDER PROGRESS") {
    return `https://docs.google.com/spreadsheets/d/${NATIONAL_SHEET_ID}/edit?gid=99300389&range=A${item.sourceRow}#gid=99300389&range=A${item.sourceRow}`;
  }
  if (item.sourceSheet === "Stylekorean") {
    return `https://docs.google.com/spreadsheets/d/${SALES_SHEET_ID}/edit?gid=0&range=A${item.sourceRow}#gid=0&range=A${item.sourceRow}`;
  }
  return item.sourceUrl ?? SHEET_URL;
}

function officialTrackingUrl(container: string, carrierKey: string, fallback: string) {
  const value = clean(container)
    .replace(/^(TRACKING|TRACK|PRO)\s*#?\s*/i, "")
    .replace(/\s+/g, "")
    .toUpperCase();
  const carrier = clean(carrierKey).toUpperCase();
  if (!value) return "";
  if (/^1Z/.test(value)) return `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(value)}`;
  if (/^(94|92|93)/.test(value)) {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(value)}`;
  }
  if (/^(JD|JJD)/.test(value)) {
    return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(value)}`;
  }
  if (/FEDEX|FDX/.test(carrier)) {
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(value)}`;
  }
  if (/AMAZON/.test(carrier) || /^TBA/.test(value)) return "https://track.amazon.com/";
  if (/^(SMCU)|SMLM|SM LINES?/.test(`${value} ${carrier}`)) {
    return `https://esvc.smlines.com/smline/CUP_HOM_3301GS.do?_search=false&f_cmd=121&page=1&rows=10000&search_name=${encodeURIComponent(value)}&search_type=C&sidx=&sord=asc`;
  }
  if (/^(HDMU)|(^| )HMM( |$)/.test(`${value} ${carrier}`)) {
    return "https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do";
  }
  if (/^(MAEU|MRSU|MSKU)|MAERSK/.test(`${value} ${carrier}`)) {
    return `https://www.maersk.com/tracking/${encodeURIComponent(value)}`;
  }
  if (/^(KMTU|KORP)|KMTC/.test(`${value} ${carrier}`)) return "https://www.ekmtc.com/index.html";
  if (/^(PUSM)|(^| )ONE( |$)/.test(`${value} ${carrier}`)) {
    return `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?ctrack-field=${encodeURIComponent(value)}&trakNoParam=${encodeURIComponent(value)}`;
  }
  if (/^(COSU|CSLU)/.test(value)) {
    return `https://elines.coscoshipping.com/ebusiness/cargotracking?trackingType=CONTAINER&number=${encodeURIComponent(value)}`;
  }
  return fallback;
}

function correctedInboundInvoice(shipmentNo: string, value: string) {
  if (/^OSL10(?:\s*-\s*2026)?$/i.test(clean(shipmentNo))) {
    return clean(value).replace(/\bN00451013\b/g, "IN00451013");
  }
  return clean(value);
}

function parcelCarrier(value: string) {
  const match = clean(value).match(/\b(UPS|FEDEX|DHL|USPS|AMAZON)\b/i);
  return match ? match[1].toUpperCase().replace("FEDEX", "FedEx") : "";
}

function sourceClass(value: string) {
  const normalized = clean(value).toLowerCase();
  if (normalized === "ocean") return "source-ocean";
  if (normalized === "air") return "source-air";
  if (normalized === "wholesale") return "source-wholesale";
  if (normalized.includes("ups") && normalized.includes("freight")) return "source-ups-freight";
  if (normalized.includes("fedex") && normalized.includes("freight")) return "source-fedex-freight";
  if (normalized.includes("dhl") && normalized.includes("freight")) return "source-dhl-freight";
  if (normalized.includes("ups")) return "source-ups-parcel";
  if (normalized.includes("fedex")) return "source-fedex-parcel";
  if (normalized.includes("dhl")) return "source-dhl-parcel";
  if (normalized.includes("usps")) return "source-usps";
  if (normalized.includes("amazon")) return "source-amazon";
  return "source-wholesale";
}

function departmentClass(value?: OutboundDepartment) {
  if (value === "B2B/E-Com") return "department-b2b-ecom";
  if (value === "Nationals") return "department-nationals";
  if (value === "MBX") return "department-mbx";
  if (value === "NJ") return "department-nj";
  return "department-wholesale";
}

function outboundDepartment(
  values: string[],
  fallback: OutboundDepartment,
): OutboundDepartment {
  const text = values.map(clean).filter(Boolean).join(" ").toUpperCase();
  if (/\bMBX\b/.test(text)) return "MBX";
  if (/\bNJ\b|\bNEW JERSEY\b/.test(text)) return "NJ";
  if (
    /\bNATIONALS?\b|\bULTA\b|\bROSS\b|\bTJX\b|\bMARSHALLS\b|\bBURLINGTON\b|\bIHERB\b|\bSEPHORA\b|\bOLIVE YOUNG\b/.test(
      text,
    )
  ) {
    return "Nationals";
  }
  if (/\bB2B\b|\bE-?COM\b|\bSTYLEKOREAN\b|\bWMS\b/.test(text)) return "B2B/E-Com";
  if (/\bWHOLESALE\b/.test(text)) return "Wholesale";
  return fallback;
}

function outboundSourceType(carrier: string, isSmallParcel: boolean) {
  const name = parcelCarrier(carrier);
  if (!name) return "Wholesale";
  if (name === "USPS" || name === "AMAZON") return name === "AMAZON" ? "Amazon" : "USPS";
  if (name === "DHL") return isSmallParcel ? "DHL (Small Parcel)" : "DHL (Freight)";
  return `${name} (${isSmallParcel ? "Parcel" : "Freight"})`;
}

function trackingCandidate(...values: string[]) {
  const candidates = values
    .flatMap((value) => clean(value).split(/\r?\n|,\s*/))
    .map((value) => value.replace(/^(TRACKING|TRACK|PRO)\s*#?\s*/i, "").trim())
    .filter(Boolean);
  return (
    candidates.find((value) =>
      /^(1Z[A-Z0-9]{10,}|TBA[A-Z0-9]{8,}|JJD[A-Z0-9]{8,}|\d{10,22})$/i.test(
        value.replace(/\s+/g, ""),
      ),
    ) ?? ""
  ).replace(/\s+/g, "");
}

function firstDatedValue(...values: string[]) {
  for (const value of values) {
    const date = parseDate(clean(value));
    if (date) {
      const text = clean(value).match(/\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/)?.[0] ?? clean(value);
      return { date, text };
    }
  }
  return null;
}

function lastDateToken(value: string) {
  const matches = clean(value).match(/\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g);
  return matches ? matches[matches.length - 1] : clean(value);
}

function sanitizeSecondary(value: string) {
  return clean(value)
    .split(/\s*·\s*/)
    .filter((part) => part && !/^imported from\b/i.test(part))
    .join(" · ");
}

function splitValues(value: string) {
  return clean(value)
    .split(/\r?\n|,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function inventoryShipmentReferences(value: string) {
  return Array.from(new Set(
    clean(value)
      .split(/\r?\n|,\s*/)
      .map((part) => part.replace(/\s*\(rcvd[^)]*\)\s*/gi, "").trim())
      .filter(Boolean),
  ));
}

function normalizedShipmentCode(value: string) {
  const match = clean(value).toUpperCase().match(/\b([A-Z]{2,10})\s*[- ]?\s*(\d{1,3})\b/);
  return match ? `${match[1]}${Number(match[2])}` : clean(value).replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function inventoryProductsMatch(left: InventoryItem, right: InventoryItem) {
  const leftSku = normalizedIdentifier(left.sku);
  const rightSku = normalizedIdentifier(right.sku);
  if (leftSku && rightSku && leftSku === rightSku) return true;
  const leftUpc = normalizedIdentifier(left.upc);
  const rightUpc = normalizedIdentifier(right.upc);
  if (leftUpc && rightUpc && leftUpc === rightUpc) return true;
  return Boolean(
    normalizedIdentifier(left.productName) &&
    normalizedIdentifier(left.productName) === normalizedIdentifier(right.productName),
  );
}

function inventoryShipmentCodes(item: InventoryItem) {
  return new Set(
    inventoryShipmentReferences(item.shipmentNo)
      .map(normalizedShipmentCode)
      .filter(Boolean),
  );
}

function scheduleMatchesInventoryShipment(item: ScheduleItem, selected: InventoryItem | null) {
  if (!selected) return false;
  const selectedCodes = inventoryShipmentCodes(selected);
  if (!selectedCodes.size) return false;
  return [item.shipmentNo, item.title]
    .flatMap((value) => inventoryShipmentReferences(value ?? ""))
    .map(normalizedShipmentCode)
    .some((value) => selectedCodes.has(value));
}

function packingListUrl(shipment: string) {
  const code = normalizedShipmentCode(shipment);
  const packingList = INBOUND_PACKING_LIST_LINKS[shipment] ?? INBOUND_PACKING_LIST_LINKS[code];
  if (packingList) return packingList;
  const direct = INBOUND_DOCUMENT_LINKS[shipment];
  if (direct) return direct;
  const candidates = Object.entries(INBOUND_DOCUMENT_LINKS).filter(
    ([label]) => normalizedShipmentCode(label) === code,
  );
  const mapped =
    candidates.find(([label]) => /\b2026\b/.test(label)) ??
    candidates[candidates.length - 1];
  if (mapped) return mapped[1];
  return `https://drive.google.com/drive/u/0/search?q=${encodeURIComponent(`"${shipment}" "packing list"`)}`;
}

function driveInvoiceSearchUrl(invoice: string) {
  return `https://drive.google.com/drive/u/0/search?q=${encodeURIComponent(invoice)}`;
}

function invoiceFileUrl(invoice: string) {
  return INBOUND_INVOICE_LINKS[invoice] ?? driveInvoiceSearchUrl(invoice);
}

function classifyOutboundReference(value: string) {
  const text = clean(value);
  if (!text) return { carrierReference: "", trackingNumber: "" };
  if (/booking|pickup|pick-up|load|bol|bold/i.test(text)) {
    return { carrierReference: text, trackingNumber: "" };
  }
  return { carrierReference: "", trackingNumber: text };
}

async function fetchTable(
  spreadsheetId: string,
  gid: number,
  range: string,
  headers: number,
) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:json");
  url.searchParams.set("gid", String(gid));
  url.searchParams.set("range", range);
  url.searchParams.set("headers", String(headers));
  url.searchParams.set("_", String(Date.now()));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Workbook read failed (${response.status}).`);
  return parseGviz(await response.text());
}

async function fetchOptionalSheet(sheetName: string, range: string) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`);
  url.searchParams.set("tqx", "out:json");
  url.searchParams.set("sheet", sheetName);
  url.searchParams.set("range", range);
  url.searchParams.set("headers", "1");
  url.searchParams.set("_", String(Date.now()));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return null;
  try {
    return parseGviz(await response.text());
  } catch {
    return null;
  }
}

function inventoryHeader(value: unknown) {
  return clean(value)
    .toUpperCase()
    .replace(/[_#()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inventoryIndexes(table: any) {
  const labels = (table?.cols ?? []).map((column: any) => inventoryHeader(column.label));
  return (...names: string[]) => labels.findIndex((label: string) => names.includes(label));
}

function inventoryNumber(value: string) {
  return Number(value.replace(/[$,\s]/g, "")) || 0;
}

function dashboardInventoryItems(table: any): InventoryCollections {
  if (!table?.rows) return { inbound: [], inStock: [] };
  const find = inventoryIndexes(table);
  const indexes = {
    shipmentNo: find("INBOUND SHIPMENTS 차수", "INBOUND SHIPMENTS", "SHIPMENT NO", "SHIPMENT"),
    productName: find("PRODUCT NAME", "PRODUCT DESCRIPTION", "DESCRIPTION"),
    sku: find("SKU"),
    upc: find("UPC", "BARCODE"),
    expirationDate: find("NEAREST EXPIRY", "EXPIRY DATE", "EXPIRATION DATE"),
    incoming: find("REMAINING TO RECEIVE", "INCOMING CONFIRMED"),
    onHand: find("ON HAND ACTUAL", "ON HAND", "AVAILABLE"),
    location: find("LOCATIONS", "LOCATION"),
    status: find("FLAG", "STATUS"),
  };
  const inbound: InventoryItem[] = [];
  const inStock: InventoryItem[] = [];
  table.rows.forEach((row: any, rowIndex: number) => {
    const value = (index: number) => (index >= 0 ? cell(row, index) : "");
    const productName = value(indexes.productName);
    const sku = value(indexes.sku);
    const upc = value(indexes.upc);
    const incoming = inventoryNumber(value(indexes.incoming));
    if ((!productName && !sku && !upc) || incoming <= 0) return;
    const shipmentNo = value(indexes.shipmentNo);
    const base = {
      shipmentNo,
      productName,
      sku,
      upc,
      expirationDate: value(indexes.expirationDate),
      palletNumber: packingListPallets(shipmentNo, sku),
      location: value(indexes.location),
      status: value(indexes.status),
    };
    if (!/^(DELIVERED|RECEIVED|COMPLETED|CANCELLED)$/.test(value(indexes.status).toUpperCase())) inbound.push({ ...base, id: `inventory-inbound-${rowIndex}`, quantity: incoming });
    const onHand = inventoryNumber(value(indexes.onHand));
    if (onHand > 0) inStock.push({ ...base, id: `inventory-stock-${rowIndex}`, quantity: onHand });
  });
  return { inbound, inStock };
}

function skwInboundItems(table: any): InventoryItem[] {
  if (!table?.rows) return [];
  const find = inventoryIndexes(table);
  const indexes = {
    shipmentNo: find("IB ID", "PO NUMBER"),
    productName: find("PRODUCT DESCRIPTION", "PRODUCT NAME", "DESCRIPTION"),
    sku: find("SKU"),
    upc: find("UPC", "BARCODE"),
    expirationDate: find("EXPIRY DATE", "EXPIRATION DATE"),
    quantity: find("QTY EA", "QUANTITY", "QTY"),
    palletNumber: find("PALLET NO", "PALLET NUMBER", "PLT NO", "PALLET"),
    status: find("STATUS"),
    stockPosted: find("STOCK POSTED"),
  };
  const finishedStatuses = new Set(["DELIVERED", "RECEIVED", "COMPLETED", "CANCELLED"]);
  return table.rows.flatMap((row: any, rowIndex: number) => {
    const value = (index: number) => (index >= 0 ? cell(row, index) : "");
    const productName = value(indexes.productName);
    const sku = value(indexes.sku);
    const upc = value(indexes.upc);
    const status = value(indexes.status);
    const stockPosted = value(indexes.stockPosted).toUpperCase();
    if ((!productName && !sku && !upc) || finishedStatuses.has(status.toUpperCase()) || /^(TRUE|YES|POSTED|1)$/.test(stockPosted)) return [];
    const shipmentNo = value(indexes.shipmentNo);
    return [{
      id: `skw-inbound-${rowIndex}`,
      shipmentNo,
      productName,
      sku,
      upc,
      expirationDate: value(indexes.expirationDate),
      palletNumber: value(indexes.palletNumber) || packingListPallets(shipmentNo, sku),
      quantity: inventoryNumber(value(indexes.quantity)),
      location: "",
      status,
    }];
  });
}

function skwStockItems(table: any): InventoryItem[] {
  if (!table?.rows) return [];
  const find = inventoryIndexes(table);
  const indexes = {
    shipmentNo: find("SOURCE IB ID"),
    productName: find("PRODUCT DESCRIPTION", "PRODUCT NAME", "DESCRIPTION"),
    sku: find("SKU"),
    upc: find("UPC", "BARCODE"),
    expirationDate: find("EXPIRY DATE", "EXPIRATION DATE"),
    quantity: find("QTY EA", "QUANTITY", "QTY"),
    location: find("LOCATION"),
  };
  return table.rows.flatMap((row: any, rowIndex: number) => {
    const value = (index: number) => (index >= 0 ? cell(row, index) : "");
    const productName = value(indexes.productName);
    const sku = value(indexes.sku);
    const upc = value(indexes.upc);
    const quantity = inventoryNumber(value(indexes.quantity));
    if ((!productName && !sku && !upc) || quantity <= 0) return [];
    return [{
      id: `skw-stock-${rowIndex}`,
      shipmentNo: value(indexes.shipmentNo),
      productName,
      sku,
      upc,
      expirationDate: value(indexes.expirationDate),
      quantity,
      location: value(indexes.location),
      status: "Received",
    }];
  });
}

function inventoryIdentity(item: InventoryItem, includeShipment: boolean) {
  return [item.sku || item.upc || item.productName, item.expirationDate, item.location, item.palletNumber, includeShipment ? item.shipmentNo : ""]
    .map((value) => clean(value).toUpperCase())
    .join("||");
}

function uniqueInventoryItems(items: InventoryItem[], includeShipment: boolean) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = inventoryIdentity(item, includeShipment);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function InventoryPanel({
  title,
  eyebrow,
  items,
  loading,
  showLocation,
  selectedItem,
  selectable = false,
  onSelect,
}: {
  title: string;
  eyebrow: string;
  items: InventoryItem[];
  loading: boolean;
  showLocation: boolean;
  selectedItem: InventoryItem | null;
  selectable?: boolean;
  onSelect?: (item: InventoryItem) => void;
}) {
  const [inventoryQuery, setInventoryQuery] = useState("");
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const filteredItems = useMemo(() => {
    const needle = inventoryQuery.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => [item.productName, item.sku, item.upc, item.expirationDate, item.location, item.shipmentNo]
      .join(" ")
      .toLowerCase()
      .includes(needle));
  }, [inventoryQuery, items]);
  const displayedItems = useMemo(() => {
    if (!selectedItem || !showLocation) return filteredItems.slice(0, 250);
    const selectedMatches = items.filter((item) => inventoryProductsMatch(item, selectedItem));
    const visibleById = new Map(
      [...selectedMatches, ...filteredItems].map((item) => [item.id, item]),
    );
    return [...visibleById.values()]
      .sort((left, right) =>
        Number(inventoryProductsMatch(right, selectedItem)) -
        Number(inventoryProductsMatch(left, selectedItem)),
      )
      .slice(0, 250);
  }, [filteredItems, items, selectedItem, showLocation]);
  useEffect(() => {
    if (!selectedItem || !showLocation) return;
    const frame = window.requestAnimationFrame(() => {
      const wrap = tableWrapRef.current;
      const matchedRow = wrap?.querySelector<HTMLTableRowElement>("tr.inventory-match");
      if (!wrap || !matchedRow) return;
      const targetTop = matchedRow.offsetTop - (wrap.clientHeight - matchedRow.offsetHeight) / 2;
      wrap.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [displayedItems, selectedItem, showLocation]);
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  return (
    <section className="inventory-panel" aria-label={title}>
      <div className="panel-heading inventory-heading">
        <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>
        <div className="inventory-total"><strong>{items.length}</strong><span>products · {totalQuantity.toLocaleString()} units</span></div>
      </div>
      <div className="inventory-toolbar">
        <input
          aria-label={`Search ${title}`}
          onChange={(event) => setInventoryQuery(event.target.value)}
          placeholder="Search product, SKU, UPC, shipment, location…"
          type="search"
          value={inventoryQuery}
        />
        <span>Showing {displayedItems.length.toLocaleString()} of {filteredItems.length.toLocaleString()}</span>
      </div>
      <div className="inventory-table-wrap" ref={tableWrapRef}>
        <table className="inventory-table">
          <thead><tr><th>Product name</th><th>SKU #</th><th>UPC #</th><th>Expiration</th>{!showLocation && <th>Pallet #</th>}<th>Qty</th>{showLocation && <th>Location</th>}</tr></thead>
          <tbody>
            {displayedItems.map((item) => {
              const selected = selectable && selectedItem?.id === item.id;
              const matching = !selectable && Boolean(selectedItem && inventoryProductsMatch(item, selectedItem));
              return <tr
                aria-label={selectable ? `Select ${item.productName || item.sku || item.upc}` : undefined}
                aria-selected={selected || matching || undefined}
                className={[
                  selectable ? "inventory-selectable" : "",
                  selected ? "inventory-selected" : "",
                  matching ? "inventory-match" : "",
                ].filter(Boolean).join(" ")}
                data-product-key={normalizedIdentifier(item.sku || item.upc || item.productName)}
                key={item.id}
                onClick={selectable ? () => onSelect?.(item) : undefined}
                onKeyDown={selectable ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect?.(item);
                  }
                } : undefined}
                tabIndex={selectable ? 0 : undefined}
                title={selectable ? (selected ? "Click again to clear product highlights" : "Click to highlight matching stock and inbound shipments") : undefined}
              >
              <td>
                <strong>{item.productName || "—"}</strong>
                {!showLocation && inventoryShipmentReferences(item.shipmentNo).length > 0 && (
                  <small className="inventory-shipment-links">
                    {inventoryShipmentReferences(item.shipmentNo).map((shipment) => (
                      <a
                        aria-label={`Open packing list for shipment ${shipment}`}
                        href={packingListUrl(shipment)}
                        key={shipment}
                        onClick={(event) => event.stopPropagation()}
                        rel="noreferrer"
                        target="_blank"
                        title={`Open packing-list documents for ${shipment}`}
                      >
                        {shipment} <span aria-hidden="true">↗</span>
                      </a>
                    ))}
                  </small>
                )}
              </td>
              <td>{item.sku || "—"}</td><td>{item.upc || "—"}</td><td>{item.expirationDate || "—"}</td>
              {!showLocation && <td className="inventory-pallet">{item.palletNumber || "—"}</td>}
              <td>{item.quantity.toLocaleString()}</td>
              {showLocation && <td>{item.location || "Unassigned"}</td>}
            </tr>})}
            {!loading && filteredItems.length === 0 && <tr><td className="import-empty" colSpan={6}>No matching inventory records are currently available.</td></tr>}
            {loading && <tr><td className="import-empty" colSpan={6}>Syncing inventory…</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LowStockPanel({
  items,
  inboundItems,
  loading,
}: {
  items: InventoryItem[];
  inboundItems: InventoryItem[];
  loading: boolean;
}) {
  const lowStockItems = useMemo(
    () => items.filter((item) => item.quantity < 200).sort((a, b) => a.quantity - b.quantity),
    [items],
  );
  const incomingShipmentsFor = (item: InventoryItem) =>
    Array.from(new Set(
      inboundItems
        .filter((inbound) => inventoryProductsMatch(inbound, item))
        .flatMap((inbound) => inventoryShipmentReferences(inbound.shipmentNo)),
    ));
  return (
    <section className="inventory-panel low-stock-panel" aria-label="Low Stock">
      <div className="panel-heading inventory-heading">
        <div><p className="eyebrow">QTY UNDER 200 · CURRENT WAREHOUSE ON HAND</p><h2>Low Stock</h2></div>
        <div className="inventory-total"><strong>{lowStockItems.length}</strong><span>products</span></div>
      </div>
      <div className="inventory-table-wrap">
        <table className="inventory-table">
          <thead><tr><th>Product name</th><th>SKU #</th><th>UPC #</th><th>Expiration</th><th>Qty</th><th>Location</th><th>Incoming shipment #</th></tr></thead>
          <tbody>
            {lowStockItems.map((item) => {
              const shipments = incomingShipmentsFor(item);
              return (
                <tr key={item.id}>
                  <td><strong>{item.productName || "—"}</strong></td>
                  <td>{item.sku || "—"}</td>
                  <td>{item.upc || "—"}</td>
                  <td>{item.expirationDate || "—"}</td>
                  <td>{item.quantity.toLocaleString()}</td>
                  <td>{item.location || "Unassigned"}</td>
                  <td>
                    {shipments.length ? (
                      <span className="inventory-shipment-links">
                        {shipments.map((shipment) => (
                          <a href={packingListUrl(shipment)} key={shipment} rel="noreferrer" target="_blank">
                            {shipment} <span aria-hidden="true">↗</span>
                          </a>
                        ))}
                      </span>
                    ) : "—"}
                  </td>
                </tr>
              );
            })}
            {!loading && lowStockItems.length === 0 && <tr><td className="import-empty" colSpan={7}>No low-stock products currently on hand.</td></tr>}
            {loading && <tr><td className="import-empty" colSpan={7}>Syncing inventory…</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

async function fetchCsvRows(spreadsheetId: string, gid: number) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
  url.searchParams.set("format", "csv");
  url.searchParams.set("gid", String(gid));
  url.searchParams.set("_", String(Date.now()));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Workbook read failed (${response.status}).`);
  return parseCsv(await response.text());
}

async function fetchLiveKpis() {
  // GitHub Pages build: KPIs are computed in the browser from the same
  // link-readable workbook CSVs the old /api/sales-kpis route used.
  return (await computeLiveKpis()) as unknown as KpiSnapshot;
}

function normalizeStatus(value: string) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return "Scheduled";
  if (normalized === "wip") return "Work in Progress";
  if (normalized === "ready" || normalized === "routed/booked" || normalized === "picked up") {
    return "Scheduled";
  }
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type ImportSourceRecord = {
  sourceRow: number;
  shipmentNo: string;
  invoice: string;
  mbl: string;
  hbl: string;
  container: string;
  vessel: string;
  status: string;
  etd: string;
  eta: string;
  deliveryExpected: string;
};

function importsBoundaryRow(rows: string[][]) {
  const index = rows.findIndex((row) => {
    const joined = row.map(clean).join("").toUpperCase();
    return (
      joined.includes("URGENT") &&
      joined.includes("COMPLETED") &&
      joined.includes("ESTIMATED") &&
      joined.includes("CHANGED") &&
      joined.includes("미정")
    );
  });
  return index === -1 ? rows.length : index;
}

function importSourceRecords(rows: string[][]): ImportSourceRecord[] {
  rows = rows.slice(0, importsBoundaryRow(rows));
  return rows.flatMap((row, index) => {
    const sourceRow = index + 1;
    if (sourceRow <= 2) return [];
    const shipmentNo = cell(row, 0);
    const invoice = cell(row, 2);
    const mbl = cell(row, 3);
    const hbl = cell(row, 4);
    if (!shipmentNo && !invoice && !mbl && !hbl) return [];
    return [
      {
        sourceRow,
        shipmentNo,
        invoice,
        mbl,
        hbl,
        container: cell(row, 7),
        vessel: cell(row, 12),
        status: cell(row, 27),
        etd: cell(row, 13),
        eta: cell(row, 14),
        deliveryExpected: cell(row, 16),
      },
    ];
  });
}

function pendingImportItems(importsRows: string[][]): ScheduleItem[] {
  const today = startOfToday();

  return importSourceRecords(importsRows).flatMap((record) => {
    const status = normalizeStatus(record.status);
    const hasShipmentDocuments = Boolean(
      record.shipmentNo && (record.invoice || record.mbl || record.hbl || record.container),
    );
    if (!hasShipmentDocuments || parcelCarrier(record.shipmentNo)) return [];

    // Prefer Delivery Expected when present, but most in-transit rows only ever get an ETA/ETD
    // filled in (Delivery Expected is usually populated only once a shipment is close to or
    // already received). Without this fallback, unfinished shipments with a real ETA but a
    // blank Delivery Expected cell were silently dropped, which emptied out the Inbound
    // Schedule and Import Schedules table.
    const dated = firstDatedValue(record.deliveryExpected, record.eta, record.etd);
    if (!dated) return [];
    const date = dated.date;
    const overdue = date.getTime() < today.getTime();
    const eta = `${dated.text}${overdue ? " · OVERDUE" : ""}`;
    const mode = resolvedInboundMode(
      "",
      record.shipmentNo,
      record.mbl,
      record.hbl,
      record.container,
      record.vessel,
    );
    const trackingNumber = record.container;
    const invoice = correctedInboundInvoice(record.shipmentNo, record.invoice);
    const folderUrl = INBOUND_DOCUMENT_LINKS[record.shipmentNo] ?? importsCellUrl(record.sourceRow, "B");

    return [{
      id: `pending-import-${record.sourceRow}`,
      direction: "inbound",
      date,
      dateText: eta,
      title: record.shipmentNo,
      reference: trackingNumber || invoice || record.mbl || record.hbl,
      secondary: [mode, record.vessel].filter(Boolean).join(" · "),
      status,
      sourceSheet: "IMPORTS",
      sourceRow: record.sourceRow,
      sourceUrl: SHEET_URL,
      editable: true,
      shipmentNo: record.shipmentNo,
      shipmentUrl: folderUrl,
      invoice,
      invoiceUrl: invoiceFileUrl(splitValues(invoice)[0] ?? ""),
      container: record.container,
      containerUrl: officialTrackingUrl(
        trackingNumber,
        [record.mbl, record.hbl, record.vessel, record.shipmentNo].filter(Boolean).join(" "),
        importsCellUrl(record.sourceRow, "H"),
      ),
      mbl: record.mbl,
      hbl: record.hbl,
      mode,
      vessel: record.vessel,
      pod: /^OSL/i.test(record.shipmentNo) ? "LGB" : "LAX",
      eta,
      isSmallParcel: false,
      shippingMethod: mode,
      sourceType: mode,
    }];
  });
}

function inboundParcelItems(rows: string[][]): ScheduleItem[] {
  let currentCarrier = "";
  const today = startOfToday();

  return rows.flatMap((row, index) => {
    const firstColumn = cell(row, 0);
    const sectionCarrier = parcelCarrier(firstColumn);
    if (sectionCarrier) {
      currentCarrier = sectionCarrier;
    } else if (firstColumn) {
      currentCarrier = "";
    }
    if (!currentCarrier) return [];

    const trackingNumber = trackingCandidate(cell(row, 1), cell(row, 10));
    const invoice = cell(row, 2);
    const department = cell(row, 3);
    const etaSource = lastDateToken(cell(row, 4));
    
    const isSectionHeader =
      /TRACKING\s*#?/i.test(cell(row, 1)) ||
      (!trackingNumber && !invoice && !department && !etaSource);
    if (isSectionHeader) return [];

    const sourceRow = index + 1;
    // WEBSITE STATUS is column AB (index 27) on IMPORTS; AD/29 lands on the small-parcel
    // section's "BRAND" header block, which silently returned blank statuses.
    const status = normalizeStatus(cell(row, 27));
    const datedValue = firstDatedValue(etaSource);
    const sourceDate = datedValue?.date ?? today;
    const unfinished = !finished.has(status.toLowerCase());
    const isStale = sourceDate.getTime() < IMPORT_STALE_CUTOFF;
    // Stale (pre-cutoff) rows are left at their real source date instead of being
    // bumped to "today" so they fall out of the 14-day window and stay hidden,
    // the same way old imports are treated as finished. Recent overdue rows still
    // get pinned to today so they keep nagging until resolved.
    const overdue = unfinished && !isStale && sourceDate.getTime() < today.getTime();
    const date = overdue ? today : sourceDate;
    const etaText = datedValue?.text
      ? `${datedValue.text}${overdue ? " · OVERDUE" : ""}`
      : "ETA pending";
    const shipmentNo = trackingNumber || `${currentCarrier}-${sourceRow}`;

    return [
      {
        id: `inbound-parcel-${sourceRow}`,
        direction: "inbound",
        date,
        dateText: etaText,
        title: trackingNumber || "Tracking pending",
        reference: trackingNumber || invoice || `${currentCarrier} parcel`,
        secondary: department,
        status,
        sourceSheet: "IMPORTS",
        sourceRow,
        sourceUrl: SHEET_URL,
        editable: true,
        shipmentNo,
        shipmentUrl: importsCellUrl(sourceRow, "B"),
        invoice,
        invoiceUrl: invoice ? invoiceFileUrl(splitValues(invoice)[0] ?? "") : "",
        containerUrl: officialTrackingUrl(
          trackingNumber,
          currentCarrier,
          importsCellUrl(sourceRow, "B"),
        ),
        eta: etaText,
        carrier: currentCarrier,
        trackingNumber,
        pro: trackingNumber,
        isSmallParcel: true,
        shippingMethod: currentCarrier,
        sourceType: outboundSourceType(currentCarrier, true),
      },
    ];
  });
}

function normalizedIdentifier(value: string) {
  return clean(value).replace(/\s+/g, "").toUpperCase();
}

function resolveImportSource(
  records: ImportSourceRecord[],
  shipmentNo: string,
  invoice: string,
  mbl: string,
  hbl: string,
) {
  const shipmentKey = normalizedIdentifier(shipmentNo);
  const invoiceKeys = splitValues(invoice).map(normalizedIdentifier).filter(Boolean);
  const mblKey = normalizedIdentifier(mbl);
  const hblKey = normalizedIdentifier(hbl);

  const uniqueMatch = (matches: ImportSourceRecord[]) =>
    matches.length === 1 ? matches[0] : null;
  if (shipmentKey) {
    const shipmentMatch = uniqueMatch(
      records.filter(
        (record) => normalizedIdentifier(record.shipmentNo) === shipmentKey,
      ),
    );
    if (shipmentMatch) return shipmentMatch;
  }

  return uniqueMatch(
    records.filter((record) => {
      const recordInvoices = splitValues(record.invoice).map(normalizedIdentifier);
      const invoiceMatch =
        invoiceKeys.length > 0 &&
        invoiceKeys.some((value) => recordInvoices.includes(value));
      const mblMatch = mblKey && normalizedIdentifier(record.mbl) === mblKey;
      const hblMatch = hblKey && normalizedIdentifier(record.hbl) === hblKey;
      return invoiceMatch && (mblMatch || hblMatch);
    }),
  );
}

function resolvedInboundMode(
  reportedMode: string,
  shipmentNo: string,
  mbl: string,
  hbl: string,
  container: string,
  vessel: string,
) {
  const shipmentCode = clean(shipmentNo).toUpperCase();
  const transportIds = [mbl, hbl, container].map(clean).join(" ").toUpperCase();
  const normalizedVessel = clean(vessel).toUpperCase();
  const isAirPrefix = /^(?:JSL|KYL)/.test(shipmentCode);
  const isAirWaybill = /\b\d{3}[- ]?\d{8}\b|\bMAWB\b/.test(transportIds);
  const isFlightNumber = /^(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])[- ]?\d{2,4}[A-Z]?$/.test(
    normalizedVessel,
  );
  const isOceanScac = /\b[A-Z]{4}[- ]?\d{6,12}\b|\bSCAC\b/.test(transportIds);
  if (
    isAirPrefix ||
    isAirWaybill ||
    isFlightNumber ||
    /\bAIR\b/i.test(reportedMode)
  ) {
    return "Air";
  }
  if (isOceanScac || /\bOCEAN\b/i.test(reportedMode)) return "Ocean";
  return clean(reportedMode) || "Ocean";
}

function inboundItems(table: any, importsRows: string[][]): ScheduleItem[] {
  const imports = importSourceRecords(importsRows);
  return (table.rows ?? []).flatMap((row: any, index: number) => {
    const eta = cell(row, 12);
    const expectedDelivery = cell(row, 14);
    const shipmentNo = cell(row, 1);
    const invoiceValue = cell(row, 3);
    const mbl = cell(row, 4);
    const hbl = cell(row, 5);
    const importSource = resolveImportSource(
      imports,
      shipmentNo,
      invoiceValue,
      mbl,
      hbl,
    );
    const importsSourceRow = importSource?.sourceRow;
    const container = cell(row, 6) || importSource?.container || "";
    const reportedMode = cell(row, 0);
    const vessel = cell(row, 10) || importSource?.vessel || "";
    const mode = resolvedInboundMode(reportedMode, shipmentNo, mbl, hbl, container, vessel);
    const smallParcelCarrier = parcelCarrier([mode, shipmentNo].join(" "));
    const isSmallParcel = Boolean(smallParcelCarrier);
    if (isSmallParcel) return [];
    const datedValue = firstDatedValue(expectedDelivery, eta);
    if (
      !datedValue ||
      !importsSourceRow ||
      (!shipmentNo && !container)
    ) {
      return [];
    }
    const { date, text: dateText } = datedValue;
    const sourceRow = importsSourceRow;
    const status = normalizeStatus(importSource?.status || cell(row, 16));
    const folderUrl = INBOUND_DOCUMENT_LINKS[shipmentNo] ?? importsCellUrl(sourceRow, "B");
    const carrierKey = [cell(row, 0), cell(row, 4), cell(row, 5), cell(row, 10), shipmentNo]
      .filter(Boolean)
      .join(" ");
    const invoice = correctedInboundInvoice(shipmentNo, invoiceValue);
    const trackingNumber = container;
    return [
      {
        id: `inbound-${sourceRow}-${index}`,
        direction: "inbound",
        date,
        dateText,
        title: shipmentNo || container,
        reference: trackingNumber || invoice || "Inbound shipment",
        secondary: [cell(row, 0), cell(row, 10)].filter(Boolean).join(" · "),
        status,
        sourceSheet: "IMPORTS",
        sourceRow,
        sourceUrl: SHEET_URL,
        editable: true,
        shipmentNo,
        shipmentUrl: folderUrl,
        container,
        containerUrl: officialTrackingUrl(
          trackingNumber,
          `${carrierKey} ${smallParcelCarrier}`,
          importsCellUrl(sourceRow, "H"),
        ),
        mbl,
        hbl,
        invoice,
        invoiceUrl: invoiceFileUrl(splitValues(invoice)[0] ?? ""),
        mode,
        vessel,
        pod: /^OSL/i.test(shipmentNo) ? "LGB" : "LAX",
        eta: expectedDelivery || eta,
        carrier: "",
        trackingNumber: "",
        pro: "",
        isSmallParcel: false,
        shippingMethod: mode,
        sourceType: mode === "Ocean" ? "Ocean" : "Air",
      },
    ];
  });
}

function ImportSchedules({
  items,
  loading,
  savingId,
  onStatus,
  selectedInventory,
}: {
  items: ScheduleItem[];
  loading: boolean;
  savingId: string;
  onStatus: (item: ScheduleItem, status: string) => void;
  selectedInventory: InventoryItem | null;
}) {
  const sortedItems = useMemo(
    () => [...items].sort((a, b) => a.date.getTime() - b.date.getTime()),
    [items],
  );
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const oceanCount = sortedItems.filter((item) => item.mode === "Ocean").length;
  const airCount = sortedItems.filter((item) => item.mode === "Air").length;

  useEffect(() => {
    if (!selectedInventory) return;
    const timer = window.setTimeout(() => {
      const wrap = tableWrapRef.current;
      const matchedRow = wrap?.querySelector<HTMLTableRowElement>(
        'tr[data-shipment-match="true"]',
      );
      if (!wrap || !matchedRow) return;
      const tableTop = matchedRow.offsetTop - (wrap.clientHeight - matchedRow.offsetHeight) / 2;
      wrap.scrollTo({ top: Math.max(0, tableTop) });
      window.requestAnimationFrame(() => {
        const bounds = matchedRow.getBoundingClientRect();
        const pageTop = window.scrollY + bounds.top - (window.innerHeight - bounds.height) / 2;
        window.scrollTo({ top: Math.max(0, pageTop) });
      });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [selectedInventory, sortedItems]);

  const linkValue = (value: string, href?: string) =>
    value ? (
      href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {value} <span aria-hidden="true">↗</span>
        </a>
      ) : (
        value
      )
    ) : (
      "—"
    );

  return (
    <section className="import-schedules" aria-labelledby="import-schedules-heading">
      <div className="panel-heading import-heading">
        <div>
          <p className="eyebrow">
            {selectedInventory ? "CURRENT + UPCOMING + SELECTED SHIPMENT" : "CURRENT + UPCOMING · OCEAN / AIR"}
          </p>
          <h2 id="import-schedules-heading">Import Schedules</h2>
        </div>
        <div className="import-totals" aria-label="Import schedule totals">
          <span><b>{oceanCount}</b> Ocean</span>
          <span><b>{airCount}</b> Air</span>
          <strong>{sortedItems.length}</strong>
        </div>
      </div>
      <div className="import-table-wrap" ref={tableWrapRef}>
        <table className="import-table">
          <thead>
            <tr>
              <th>Mode</th>
              <th>Shipment</th>
              <th>Invoice</th>
              <th>MBL</th>
              <th>HBL</th>
              <th>Container #</th>
              <th>VSL</th>
              <th>POD</th>
              <th>ETA</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item) => {
              const shipmentMatch = scheduleMatchesInventoryShipment(item, selectedInventory);
              return (
              <tr
                aria-label={shipmentMatch ? `Selected product shipment ${item.shipmentNo || item.title}` : undefined}
                className={`${sourceClass(item.sourceType ?? item.mode ?? "")} ${shipmentMatch ? "shipment-match" : ""}`}
                data-shipment-match={shipmentMatch || undefined}
                key={`import-${item.id}`}
              >
                <td><span className={`mode-pill ${item.mode?.toLowerCase()}`}>{item.mode || "—"}</span></td>
                <td>{linkValue(item.shipmentNo ?? item.title, item.shipmentUrl)}</td>
                <td>
                  <div className="multi-links">
                    {splitValues(item.invoice ?? "").length
                      ? splitValues(item.invoice ?? "").map((invoice) => (
                          <a
                            key={invoice}
                            href={invoiceFileUrl(invoice)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {invoice} <span aria-hidden="true">↗</span>
                          </a>
                        ))
                      : "—"}
                  </div>
                </td>
                <td>{item.mbl || "—"}</td>
                <td>{item.hbl || "—"}</td>
                <td>{linkValue(item.container ?? "", item.containerUrl)}</td>
                <td>{item.vessel || "—"}</td>
                <td>{item.pod || "—"}</td>
                <td><time dateTime={dayKey(item.date)}>{item.eta || item.dateText || "—"}</time></td>
                <td>
                  {item.editable ? (
                    <select
                      className="compact-status-select"
                      aria-label={`Update ${item.title} status`}
                      disabled={savingId === item.id}
                      value={INBOUND_STATUS_OPTIONS.includes(item.status) ? item.status : "Scheduled"}
                      onChange={(event) => onStatus(item, event.target.value)}
                    >
                      {INBOUND_STATUS_OPTIONS.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <span className={statusClass(item.status)}>{item.status}</span>
                  )}
                </td>
              </tr>
            )})}
            {!loading && sortedItems.length === 0 && (
              <tr>
                <td className="import-empty" colSpan={10}>No unfinished imports match the active search.</td>
              </tr>
            )}
            {loading && (
              <tr>
                <td className="import-empty" colSpan={10}>Syncing import schedules…</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type OutboundSourceRecord = {
  sourceRow: number;
  customer: string;
  invoice: string;
  shipDate: string;
  pro: string;
};

function outboundSourceRecords(rows: string[][]): OutboundSourceRecord[] {
  return rows.flatMap((row, index) => {
    const sourceRow = index + 1;
    if (sourceRow < 4) return [];
    const customer = cell(row, 0);
    const invoice = cell(row, 1);
    const shipDate = cell(row, 3);
    if (!customer || !shipDate) return [];
    return [{
      sourceRow,
      customer,
      invoice,
      shipDate,
      pro: cell(row, 18),
    }];
  });
}

function resolveOutboundSource(records: OutboundSourceRecord[], item: ScheduleItem) {
  const uniqueMatch = (matches: OutboundSourceRecord[]) =>
    matches.length === 1 ? matches[0] : null;
  const proKey = normalizedIdentifier(item.pro || item.carrierReference || "");
  if (proKey) {
    const proMatch = uniqueMatch(
      records.filter((record) => normalizedIdentifier(record.pro) === proKey),
    );
    if (proMatch) return proMatch;
  }

  const customerKey = normalizedIdentifier(item.customer || item.customerNo || "");
  const invoiceKeys = splitValues(item.invoice || "").map(normalizedIdentifier).filter(Boolean);
  const shipDateKey = normalizedIdentifier(item.shipDate || "");
  return uniqueMatch(
    records.filter((record) => {
      const recordInvoices = splitValues(record.invoice).map(normalizedIdentifier);
      return (
        customerKey &&
        normalizedIdentifier(record.customer) === customerKey &&
        shipDateKey &&
        normalizedIdentifier(record.shipDate) === shipDateKey &&
        invoiceKeys.some((invoice) => recordInvoices.includes(invoice))
      );
    }),
  );
}

function outboundItems(rows: string[][]): ScheduleItem[] {
  return rows.flatMap((row, index) => {
    const sourceRow = index + 1;
    if (sourceRow < 4) return [];
    const customer = cell(row, 0);
    const invoice = cell(row, 1);
    const shipDate = cell(row, 3);
    const date = parseDate(shipDate);
    if (!date || !customer) return [];
    const status = normalizeStatus(cell(row, 23) || cell(row, 20));
    const carrier = cell(row, 16);
    const carrierRefs = classifyOutboundReference(cell(row, 18));
    const note = cell(row, 19);
    return [
      {
        id: `outbound-${sourceRow}`,
        direction: "outbound",
        date,
        dateText: shipDate,
        title: customer,
        reference: invoice || cell(row, 18) || "Outbound shipment",
        secondary: [cell(row, 16), cell(row, 18)].filter(Boolean).join(" · "),
        status,
        sourceSheet: "Outbound Shipping Schedule",
        sourceRow,
        sourceUrl: SHEET_URL,
        editable: true,
        customer,
        customerNo: customer,
        invoice,
        pro: carrierRefs.trackingNumber,
        carrier,
        carrierReference: carrierRefs.carrierReference || cell(row, 19),
        trackingNumber: carrierRefs.trackingNumber,
        shipDate,
        shippingMethod: "Trucking",
        sourceType: outboundSourceType(carrier, false),
        department: outboundDepartment([note, customer], "Wholesale"),
      },
    ];
  });
}

function nationalOutboundItems(table: any): ScheduleItem[] {
  return (table.rows ?? []).flatMap((row: any, index: number) => {
    const pickupDate = cell(row, 9);
    const startShip = cell(row, 7);
    const cancelDate = cell(row, 8);
    const dateText = pickupDate || startShip || cancelDate;
    const date = parseDate(dateText);
    const channel = cell(row, 1);
    const shippingMethod = cell(row, 11);
    if (!date || !channel || !/^trucking$/i.test(shippingMethod)) return [];
    const sourceRow = index + 2;
    const order = cell(row, 3);
    const po = cell(row, 5);
    const department = cell(row, 2);
    return [
      {
        id: `national-outbound-${sourceRow}`,
        direction: "outbound",
        date,
        dateText,
        title: channel,
        reference: order || po || "National order",
        secondary: [cell(row, 2), cell(row, 12)]
          .filter(Boolean)
          .join(" · "),
        status: normalizeStatus(cell(row, 0)),
        sourceSheet: "NATIONAL ORDER PROGRESS",
        sourceRow,
        sourceUrl: NATIONAL_SHEET_URL,
        editable: false,
        customer: channel,
        customerNo: channel,
        po,
        invoice: order,
        carrier: "",
        carrierReference: "",
        shipDate: dateText,
        shippingMethod: "Trucking",
        sourceType: "Wholesale",
        department: outboundDepartment([department, channel], "Nationals"),
      },
    ];
  });
}

function salesOutboundItems(table: any): ScheduleItem[] {
  return (table.rows ?? []).flatMap((row: any, index: number) => {
    const shipDate = cell(row, 4);
    const date = parseDate(shipDate);
    const customer = cell(row, 2);
    const shippingMethod = cell(row, 5);
    const carrier = parcelCarrier(shippingMethod);
    const isSmallParcel = Boolean(carrier) && !/truck/i.test(shippingMethod);
    const isTrucking = /\btruck(?:ing)?\b/i.test(shippingMethod);
    if (!date || !customer || (!isSmallParcel && !isTrucking)) return [];
    const sourceRow = index + 3;
    const issue = cell(row, 7);
    const status = /yes|issue|hold|pending/i.test(issue) ? "Pending" : "Scheduled";
    const trackingNumber = isSmallParcel
      ? trackingCandidate(...Array.from({ length: 24 }, (_, offset) => cell(row, offset + 8)))
      : "";
    return [
      {
        id: `sales-outbound-${sourceRow}`,
        direction: "outbound",
        date,
        dateText: shipDate,
        title: customer,
        reference: trackingNumber || cell(row, 1) || "Sales shipment",
        secondary: [cell(row, 3), cell(row, 5), issue && `Issue: ${issue}`]
          .filter(Boolean)
          .join(" · "),
        status,
        sourceSheet: "Stylekorean",
        sourceRow,
        sourceUrl: SALES_SHEET_URL,
        editable: false,
        customer,
        customerNo: customer,
        invoice: cell(row, 1),
        carrier: carrier || shippingMethod,
        trackingNumber,
        pro: trackingNumber,
        containerUrl: trackingNumber
          ? officialTrackingUrl(trackingNumber, carrier, sourceRowUrl({
              id: "",
              direction: "outbound",
              date,
              dateText: shipDate,
              title: customer,
              reference: "",
              secondary: "",
              status,
              sourceSheet: "Stylekorean",
              sourceRow,
            }))
          : "",
        shipDate,
        isSmallParcel,
        shippingMethod: isTrucking ? "Trucking" : shippingMethod,
        sourceType: outboundSourceType(carrier || shippingMethod, isSmallParcel),
        department: outboundDepartment(
          [customer, cell(row, 3), cell(row, 11), cell(row, 12)],
          "B2B/E-Com",
        ),
      },
    ];
  });
}

function consolidateTruckingItems(records: ScheduleItem[]) {
  const groups = new Map<string, ScheduleItem[]>();
  const ungrouped: ScheduleItem[] = [];

  records.forEach((item) => {
    if (
      item.direction !== "outbound" ||
      item.isSmallParcel ||
      !/^trucking$/i.test(item.shippingMethod ?? "")
    ) {
      ungrouped.push(item);
      return;
    }
    const customerKey = normalizedIdentifier(item.customer || item.customerNo || item.title);
    const dateKey = item.date ? dayKey(item.date) : normalizedIdentifier(item.shipDate || item.dateText);
    if (!customerKey || !dateKey) {
      ungrouped.push(item);
      return;
    }
    const key = `${customerKey}___${dateKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  });

  const invoiceKeys = (items: ScheduleItem[]) => new Set(
    items.flatMap((item) => splitValues(item.invoice ?? "")).map(normalizedIdentifier).filter(Boolean),
  );
  const groupEntries = [...groups.entries()];
  const scheduleGroups = groupEntries.filter(([, items]) =>
    items.some((item) => item.sourceSheet === "Outbound Shipping Schedule"),
  );
  const absorbed = new Set<string>();
  groupEntries.forEach(([key, items]) => {
    if (items.some((item) => item.sourceSheet === "Outbound Shipping Schedule")) return;
    const invoices = invoiceKeys(items);
    if (!invoices.size) return;
    const matches = scheduleGroups.filter(([, scheduled]) =>
      [...invoiceKeys(scheduled)].some((invoice) => invoices.has(invoice)),
    );
    if (matches.length !== 1) return;
    matches[0][1].push(...items);
    absorbed.add(key);
  });

  const consolidated = groupEntries.filter(([key]) => !absorbed.has(key)).map(([key, items]) => {
    const primary =
      items.find((item) => item.sourceSheet === "Outbound Shipping Schedule") ??
      items.find((item) => item.editable) ??
      items[0];
    const invoices = Array.from(new Set(
      items.flatMap((item) => splitValues(item.invoice ?? "")).map((value) => value.trim()).filter(Boolean),
    ));
    const warningStatus = items.find((item) => /pending|delay|hold|review/i.test(item.status));
    const secondary = Array.from(new Set(items.map((item) => item.secondary).filter(Boolean))).join(" · ");
    const invoice = invoices.join("\n");
    return {
      ...primary,
      id: `trucking-${key}`,
      invoice,
      reference: invoice || primary.reference,
      secondary,
      status: warningStatus?.status ?? primary.status,
    };
  });

  return [...ungrouped, ...consolidated];
}

async function postStatus(item: ScheduleItem, status: string) {
  let sourceRow = item.sourceRow;
  if (item.sourceSheet === "IMPORTS") {
    const importsRows = await fetchCsvRows(SHEET_ID, 1497250700);
    const source = item.isSmallParcel
      ? inboundParcelItems(importsRows).find(
          (record) =>
            record.sourceRow === item.sourceRow &&
            normalizedIdentifier(record.trackingNumber || record.invoice || "") ===
              normalizedIdentifier(item.trackingNumber || item.invoice || ""),
        )
      : resolveImportSource(
          importSourceRecords(importsRows),
          item.shipmentNo ?? "",
          item.invoice ?? "",
          item.mbl ?? "",
          item.hbl ?? "",
        );
    if (!source) {
      throw new Error("The IMPORTS sheet did not contain one unique matching shipment row.");
    }
    sourceRow = source.sourceRow;
  } else if (item.sourceSheet === "Outbound Shipping Schedule") {
    const outbound = outboundSourceRecords(await fetchCsvRows(SHEET_ID, 20260708));
    const source = resolveOutboundSource(outbound, item);
    if (!source) {
      throw new Error("The outbound sheet did not contain one unique matching shipment row.");
    }
    sourceRow = source.sourceRow;
  }

  const payload = {
    kind: item.direction,
    sourceSheet: item.sourceSheet,
    sourceRow,
    shipmentNo: item.shipmentNo ?? "",
    container: item.container ?? "",
    mbl: item.mbl ?? "",
    hbl: item.hbl ?? "",
    pro: item.pro ?? "",
    invoice: item.invoice ?? "",
    customer: item.customer ?? "",
    shipDate: item.shipDate ?? "",
    currentStatus: item.status,
    status,
  };
  const body = JSON.stringify(payload);
  const response = await fetch(WRITE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || "The source sheet rejected this status change.");
  }
  if (!result || result.ok !== true) {
    throw new Error("The source sheet returned an invalid confirmation.");
  }
  if (result.row && Number(result.row) !== sourceRow) {
    throw new Error("The update was rejected because the confirmed source row changed.");
  }

  const expectedStatus = normalizeStatus(status);
  for (const delay of [350, 900, 1800]) {
    await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      let persisted = "";
      if (item.sourceSheet === "IMPORTS") {
        // WEBSITE STATUS lives in column AB (index 27) on the IMPORTS tab — AD is
        // "CONTAINER RAW (SYSTEM)". Reading the wrong column here made every status
        // write look unconfirmed even when the Apps Script backend saved it correctly.
        const table = await fetchTable(
          SHEET_ID,
          1497250700,
          `AB${sourceRow}:AB${sourceRow}`,
          0,
        );
        persisted = cell(table.rows?.[0], 0);
      } else if (item.sourceSheet === "Outbound Shipping Schedule") {
        const table = await fetchTable(
          SHEET_ID,
          20260708,
          `U${sourceRow}:X${sourceRow}`,
          0,
        );
        persisted = cell(table.rows?.[0], 3) || cell(table.rows?.[0], 0);
      }
      if (
        persisted &&
        normalizeStatus(persisted) === expectedStatus
      ) {
        return;
      }
    } catch {
      // Retry while the workbook recalculates and publishes its latest values.
    }
  }
  throw new Error(
    "The source sheet did not confirm this status change. The card was left unchanged.",
  );
}

function ScheduleCard({
  item,
  saving,
  onStatus,
}: {
  item: ScheduleItem;
  saving: boolean;
  onStatus: (item: ScheduleItem, status: string) => void;
}) {
  const options = item.direction === "inbound" ? INBOUND_STATUS_OPTIONS : STATUS_OPTIONS;
  const sourceCellUrl = sourceRowUrl(item);
  const valueLink = (label: string, value: string, href?: string, blankWhenMissing = false) => (
    <div className="data-field">
      <dt>{label}</dt>
      <dd>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {value} <span aria-hidden="true">↗</span>
          </a>
        ) : (
          value || (blankWhenMissing ? "" : "—")
        )}
      </dd>
    </div>
  );
  const invoiceLinks = (item.invoice ? splitValues(item.invoice) : []).map((invoice) =>
    item.direction === "inbound" ? (
      <a key={invoice} href={invoiceFileUrl(invoice)} target="_blank" rel="noreferrer">
        {invoice} <span aria-hidden="true">↗</span>
      </a>
    ) : (
      <span key={invoice}>{invoice}</span>
    ),
  );
  const summaryPrimary =
    item.direction === "outbound"
      ? item.customerNo ?? item.customer ?? item.title
      : item.isSmallParcel
        ? item.trackingNumber ?? item.pro ?? item.title
        : item.shipmentNo ?? item.title;
  const summaryHref =
    item.direction === "inbound"
      ? item.isSmallParcel
        ? item.containerUrl
        : item.shipmentUrl
      : undefined;
  const secondary = sanitizeSecondary(item.secondary);

  return (
    <details
      className={`schedule-card ${item.direction} ${sourceClass(item.sourceType ?? "")} ${
        item.direction === "outbound" ? departmentClass(item.department) : ""
      }`}
    >
      <summary className="card-summary">
        <span className="summary-primary">
          <small>{item.isSmallParcel ? "TRACKING" : item.direction === "inbound" ? "SHIPMENT" : "CUSTOMER"}</small>
          {summaryHref ? (
            <a href={summaryHref} target="_blank" rel="noreferrer">{summaryPrimary} ↗</a>
          ) : (
            <strong>{summaryPrimary}</strong>
          )}
        </span>
        <span className="summary-invoices">
          <small>INVOICE #</small>
          <span>{invoiceLinks.length ? invoiceLinks : "—"}</span>
        </span>
        <span className="expand-mark" aria-hidden="true">＋</span>
      </summary>

      <div className="card-detail">
        <div className="card-topline">
          <div className="card-badges">
            {item.direction === "outbound" ? (
              <span className="department-badge">{item.department ?? "Wholesale"}</span>
            ) : null}
            <span className="direction-label source-badge">
              {item.sourceType || (item.direction === "inbound" ? "Inbound" : "Wholesale")}
            </span>
          </div>
          <span className={statusClass(item.status)}>{item.status}</span>
        </div>
        {item.direction === "inbound" ? (
          item.isSmallParcel ? (
            <dl className="data-grid inbound-data">
              {valueLink("Tracking / PRO #", item.trackingNumber ?? item.pro ?? "", item.containerUrl)}
              {valueLink("Invoice #", splitValues(item.invoice ?? "").join(" · "), item.invoiceUrl)}
              {valueLink("Carrier", item.carrier ?? "")}
              {valueLink("ETA", item.eta ?? item.dateText)}
            </dl>
          ) : (
            <dl className="data-grid inbound-data">
              {valueLink("Shipment", item.shipmentNo ?? item.title, item.shipmentUrl)}
              {valueLink("Invoice #", splitValues(item.invoice ?? "").join(" · "), item.invoiceUrl)}
              {valueLink("Container #", item.container ?? "", item.containerUrl)}
              {valueLink("MBL", item.mbl ?? "")}
              {valueLink("HBL", item.hbl ?? "")}
              {valueLink("VSL", item.vessel ?? "")}
              {valueLink("POD", item.pod ?? "")}
              {valueLink("ETA", item.eta ?? item.dateText)}
            </dl>
          )
        ) : (
          <dl className="data-grid outbound-data">
            {valueLink("Customer #", item.customerNo ?? item.customer ?? item.title)}
            {valueLink("PO # / Invoice #", [item.po, item.invoice].filter(Boolean).join(" · "), undefined, true)}
            {item.carrier ? valueLink("Carrier", item.carrier) : null}
            {item.carrierReference
              ? valueLink("Booking / Pickup / Load / BOL #", item.carrierReference)
              : null}
            {item.trackingNumber || item.pro
              ? valueLink("Tracking # / PRO #", item.trackingNumber ?? item.pro ?? "")
              : null}
          </dl>
        )}
        {secondary ? <p className="secondary">{secondary}</p> : null}
        <div className="card-actions">
          {item.editable ? (
            <label className="status-field">
              <span>Status</span>
              <select
                aria-label={`Update ${item.title} status`}
                disabled={saving}
                value={options.includes(item.status) ? item.status : "Scheduled"}
                onChange={(event) => onStatus(item, event.target.value)}
              >
                {options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          ) : (
            <span className="read-only-label">READ ONLY</span>
          )}
          <a
            className="source-link"
            href={sourceCellUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${item.sourceSheet} source row`}
          >
            SOURCE · ROW {item.sourceRow} ↗
          </a>
        </div>
      </div>
    </details>
  );
}

function SmallParcelSchedule({
  direction,
  items,
  loading,
  savingId,
  onStatus,
}: {
  direction: Direction;
  items: ScheduleItem[];
  loading: boolean;
  savingId: string;
  onStatus: (item: ScheduleItem, status: string) => void;
}) {
  const sortedItems = [...items].sort((a, b) => a.date.getTime() - b.date.getTime());
  const isInbound = direction === "inbound";
  const headingId = `${direction}-small-parcel-heading`;

  return (
    <section
      className={`parcel-panel ${direction}-parcel-panel`}
      aria-labelledby={headingId}
    >
      <div className="panel-heading parcel-heading">
        <div>
          <p className="eyebrow">UPS · FEDEX · USPS · DHL · AMAZON</p>
          <h2 id={headingId}>
            {isInbound
              ? "Inbound Schedule (Small Parcels)"
              : "Outbound Schedule (Small Parcels)"}
          </h2>
        </div>
        <div className="parcel-total">
          <strong>{sortedItems.length}</strong>
          <span>active</span>
        </div>
      </div>
      <div className="parcel-grid">
        {sortedItems.map((item) => {
          const tracking = item.trackingNumber || item.pro || "";
          return (
            <details
              className={`parcel-card ${sourceClass(item.sourceType ?? "")} ${
                direction === "outbound" ? departmentClass(item.department) : ""
              }`}
              key={`parcel-${item.id}`}
            >
              <summary className="parcel-summary">
                <span className="parcel-badges">
                  {direction === "outbound" ? (
                    <span className="department-badge">{item.department ?? "B2B/E-Com"}</span>
                  ) : null}
                  <span className="source-badge">{item.sourceType || item.carrier || "Parcel"}</span>
                </span>
                <strong className="parcel-tracking">{tracking || "Tracking pending"}</strong>
                <span className="parcel-invoice">{item.invoice ? `Invoice # ${item.invoice}` : "Invoice # —"}</span>
                <span className="expand-mark" aria-hidden="true">＋</span>
              </summary>
              <div className="parcel-detail">
                <div className="parcel-topline">
                  <span className={statusClass(item.status)}>{item.status}</span>
                  <span>{item.customer || item.shipmentNo || ""}</span>
                </div>
                <div className="parcel-footer">
                  <span><b>ETA</b> {item.dateText || "—"}</span>
                  {tracking && item.containerUrl ? (
                    <a href={item.containerUrl} target="_blank" rel="noreferrer">
                      Track ↗
                    </a>
                  ) : (
                    <a href={sourceRowUrl(item)} target="_blank" rel="noreferrer">
                      Source ↗
                    </a>
                  )}
                </div>
                {item.editable ? (
                  <label className="status-field parcel-status-field">
                    <span>Status</span>
                    <select
                      aria-label={`Update ${item.title} status`}
                      disabled={savingId === item.id}
                      value={
                        (direction === "inbound" ? INBOUND_STATUS_OPTIONS : STATUS_OPTIONS).includes(item.status)
                          ? item.status
                          : "Scheduled"
                      }
                      onChange={(event) => onStatus(item, event.target.value)}
                    >
                      {(direction === "inbound" ? INBOUND_STATUS_OPTIONS : STATUS_OPTIONS).map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            </details>
          );
        })}
        {!loading && sortedItems.length === 0 && (
          <div className="parcel-empty">
            No {direction} small-parcel shipments in the active 14-day window.
          </div>
        )}
        {loading && <div className="loading-card" />}
      </div>
    </section>
  );
}

function ScheduleBoard({
  direction,
  days,
  items,
  loading,
  savingId,
  onStatus,
}: {
  direction: Direction;
  days: Date[];
  items: ScheduleItem[];
  loading: boolean;
  savingId: string;
  onStatus: (item: ScheduleItem, status: string) => void;
}) {
  const isInbound = direction === "inbound";
  return (
    <section
      className={`schedule-panel ${direction}-panel`}
      aria-labelledby={`${direction}-schedule-heading`}
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{isInbound ? "ARRIVALS" : "DEPARTURES · TRUCKING ONLY"}</p>
          <h2 id={`${direction}-schedule-heading`}>
            {isInbound ? "Inbound schedule" : "Outbound schedule"}
          </h2>
        </div>
        <div className={`board-total ${direction}`}>
          <span>{isInbound ? "INBOUND" : "OUTBOUND"}</span>
          <strong>{items.length}</strong>
          <small>next 14 days</small>
        </div>
      </div>
      <div className="board-wrap">
        <div className="board">
          {days.map((day, index) => {
            const dayItems = items.filter((item) => dayKey(item.date) === dayKey(day));
            return (
              <section
                className={index === 0 ? "day-column today" : "day-column"}
                key={`${direction}-${dayKey(day)}`}
              >
                <header>
                  <span>
                    {day.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()}
                  </span>
                  <strong>{day.getDate()}</strong>
                  <small>
                    {day.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}
                  </small>
                  <b>{dayItems.length}</b>
                </header>
                <div className="day-items">
                  {dayItems.map((item) => (
                    <ScheduleCard
                      key={item.id}
                      item={item}
                      saving={savingId === item.id}
                      onStatus={onStatus}
                    />
                  ))}
                  {!loading && dayItems.length === 0 && (
                    <div className="empty-day">
                      <span>—</span>
                      No {direction} moves
                    </div>
                  )}
                  {loading && <div className="loading-card" />}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [nextRefreshAt, setNextRefreshAt] = useState<Date | null>(null);
  const [query, setQuery] = useState("");
  const [includeFinished, setIncludeFinished] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [notice, setNotice] = useState("");
  const [kpis, setKpis] = useState<KpiSnapshot>(EMPTY_KPIS);
  const [inboundInventory, setInboundInventory] = useState<InventoryItem[]>([]);
  const [warehouseStock, setWarehouseStock] = useState<InventoryItem[]>([]);
  const [selectedInventory, setSelectedInventory] = useState<InventoryItem | null>(null);
  const loadInFlight = useRef(false);
  const lastRefreshAt = useRef(0);

  const days = useMemo(() => {
    const today = startOfToday();
    return Array.from({ length: 14 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() + index);
      return date;
    });
  }, []);

  const load = useCallback(async () => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    setLoading(true);
    setError("");
    try {
      const [
        imports,
        outbound,
        nationalOutbound,
        salesOutbound,
        liveKpis,
        inventoryDashboardTable,
        skwInboundTable,
        skwStockTable,
      ] = await Promise.all([
        fetchCsvRows(SHEET_ID, 1497250700),
        fetchCsvRows(SHEET_ID, 20260708),
        fetchTable(NATIONAL_SHEET_ID, 99300389, "A1:U3500", 1),
        fetchTable(SALES_SHEET_ID, 0, "A2:AF4200", 1),
        fetchLiveKpis(),
        fetchOptionalSheet("INVENTORY", "A1:O6500"),
        fetchOptionalSheet("SKW_Inbound", "A1:R2500"),
        fetchOptionalSheet("SKW_Stock", "A1:J2500"),
      ]);
      setItems(consolidateTruckingItems([
        ...pendingImportItems(imports),
        ...inboundParcelItems(imports),
        ...outboundItems(outbound),
        ...nationalOutboundItems(nationalOutbound),
        ...salesOutboundItems(salesOutbound),
      ]));
      setKpis(liveKpis);
      const dashboardInventory = dashboardInventoryItems(inventoryDashboardTable);
      setInboundInventory(uniqueInventoryItems([
        ...dashboardInventory.inbound,
        ...skwInboundItems(skwInboundTable),
      ], true));
      setWarehouseStock(uniqueInventoryItems([
        ...dashboardInventory.inStock,
        ...skwStockItems(skwStockTable),
      ], false));
      const refreshedAt = new Date();
      lastRefreshAt.current = refreshedAt.getTime();
      setUpdatedAt(refreshedAt);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The live schedule could not be loaded.");
    } finally {
      loadInFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    setNextRefreshAt(new Date(Date.now() + AUTO_REFRESH_MS));
    const refreshIfStale = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastRefreshAt.current >= AUTO_REFRESH_MS
      ) {
        load();
        setNextRefreshAt(new Date(Date.now() + AUTO_REFRESH_MS));
      }
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      load();
      setNextRefreshAt(new Date(Date.now() + AUTO_REFRESH_MS));
    }, AUTO_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshIfStale);
    window.addEventListener("focus", refreshIfStale);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfStale);
      window.removeEventListener("focus", refreshIfStale);
    };
  }, [load]);

  const visibleItems = useMemo(() => {
    const first = days[0].getTime();
    const last = days[days.length - 1].getTime();
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      const stamp = new Date(item.date.getFullYear(), item.date.getMonth(), item.date.getDate()).getTime();
      if (stamp < first || stamp > last) return false;
      // Same rule as the Import Schedules table: anything dated before the cutoff is
      // treated as finished/received/completed and hidden by default. The "Show
      // completed entries" toggle recovers both these and status-finished rows.
      if (!includeFinished && item.date.getTime() < IMPORT_STALE_CUTOFF) return false;
      if (!includeFinished && finished.has(item.status.toLowerCase())) return false;
      if (!needle) return true;
      return [
        item.title,
        item.reference,
        item.secondary,
        item.status,
        item.sourceSheet,
        item.customerNo,
        item.po,
        item.invoice,
        item.shipmentNo,
        item.container,
        item.carrier,
        item.carrierReference,
        item.trackingNumber,
        item.mode,
        item.vessel,
        item.pod,
        item.eta,
        item.shippingMethod,
        item.sourceType,
        item.department,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [days, includeFinished, items, query]);

  const inboundVisibleItems = useMemo(
    () => visibleItems.filter((item) => item.direction === "inbound"),
    [visibleItems],
  );

  const inboundScheduleVisibleItems = useMemo(
    () => inboundVisibleItems.filter((item) => !item.isSmallParcel),
    [inboundVisibleItems],
  );

  const inboundParcelVisibleItems = useMemo(
    () => inboundVisibleItems.filter((item) => item.isSmallParcel),
    [inboundVisibleItems],
  );

  const outboundVisibleItems = useMemo(
    () =>
      visibleItems.filter(
        (item) =>
          item.direction === "outbound" &&
          !item.isSmallParcel &&
          /^trucking$/i.test(item.shippingMethod ?? ""),
      ),
    [visibleItems],
  );

  const outboundParcelVisibleItems = useMemo(
    () => visibleItems.filter((item) => item.direction === "outbound" && item.isSmallParcel),
    [visibleItems],
  );

  const importScheduleItems = useMemo(
    () => {
      const needle = query.trim().toLowerCase();
      return items.filter((item) => {
        if (item.direction !== "inbound" || item.isSmallParcel) return false;
        const selectedShipment = scheduleMatchesInventoryShipment(item, selectedInventory);
        const isStaleImport = item.date.getTime() < IMPORT_STALE_CUTOFF;
        const isFinishedOrStale = finishedImports.has(item.status.toLowerCase()) || isStaleImport;
        if (isFinishedOrStale && !includeFinished && !selectedShipment) return false;
        if (selectedShipment) return true;
        if (!needle) return true;
        return [
          item.title,
          item.reference,
          item.invoice,
          item.shipmentNo,
          item.container,
          item.mbl,
          item.hbl,
          item.vessel,
          item.status,
        ].join(" ").toLowerCase().includes(needle);
      });
    },
    [items, query, selectedInventory, includeFinished],
  );

  const counts = useMemo(() => {
    const today = dayKey(days[0]);
    const inbound = visibleItems.filter((item) => item.direction === "inbound").length;
    const outbound = outboundVisibleItems.length + outboundParcelVisibleItems.length;
    const dueToday = visibleItems.filter((item) => dayKey(item.date) === today).length;
    const exceptions = visibleItems.filter((item) =>
      /pending|delay|hold|review/i.test(item.status),
    ).length;
    return { inbound, outbound, dueToday, exceptions };
  }, [days, outboundParcelVisibleItems, outboundVisibleItems, visibleItems]);

  const handleStatus = async (item: ScheduleItem, status: string) => {
    setSavingId(item.id);
    setNotice(`Saving ${item.title}…`);
    try {
      await postStatus(item, status);
      setItems((current) =>
        current.map((record) => (record.id === item.id ? { ...record, status } : record)),
      );
      setNotice(`${item.title} updated to ${status}.`);
      window.setTimeout(() => setNotice(""), 4500);
    } catch (statusError) {
      setNotice(
        statusError instanceof Error
          ? statusError.message
          : "Status was not saved. Sign in with your StyleKorean Google account and try again.",
      );
    } finally {
      setSavingId("");
    }
  };

  return (
    <main className="site-shell">
      <header className="manifest">
        <div className="route-strip">
          <span>KRPUS ⚓ USLAX</span>
          <i />
          <span>ICN ✈ LAX</span>
          <i />
          <span>5609 RIVERWAY · BUENA PARK CA</span>
        </div>
        <div className="manifest-main">
          <div>
            <p className="eyebrow">LOGISTICS MASTER 2026 · LIVE WORKBOOK SYNC</p>
            <h1>
              StyleKorean<br />Logistics Hub
            </h1>
            <p className="intro">
              Every import, inbound delivery, trucking move, and small-parcel shipment
              across the next fourteen days—one operational board.
            </p>
          </div>
          <div className="manifest-actions">
            <button className="button primary" onClick={load} disabled={loading}>
              {loading ? "SYNCING…" : "↻ REFRESH DATA"}
            </button>
            <div className="source-buttons" aria-label="Source workbooks">
              <a className="button secondary" href={SHEET_URL} target="_blank" rel="noreferrer">
                MASTER
              </a>
              <a className="button secondary" href={NATIONAL_SHEET_URL} target="_blank" rel="noreferrer">
                NATIONAL
              </a>
              <a className="button secondary" href={SALES_SHEET_URL} target="_blank" rel="noreferrer">
                SALES
              </a>
            </div>
          </div>
        </div>
        <div className="sync-strip" role="status" aria-live="polite">
          <span>
            <b className={error ? "sync-dot error" : loading ? "sync-dot loading" : "sync-dot"} />
            {error ? "Workbook connection needs attention" : loading ? "Syncing live records…" : "3 live workbooks connected"}
          </span>
          <span className="mono">
            AUTO SYNC 30 MIN · LAST SYNC {updatedAt ? updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "—"}
            {" · "}NEXT CHECK {nextRefreshAt ? nextRefreshAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "—"}
          </span>
        </div>
      </header>

      {error && (
        <div className="alert" role="alert">
          <strong>Schedule unavailable.</strong> {error} Confirm the workbook is link-readable or
          open it while signed in to your StyleKorean Google account.
        </div>
      )}

      <section className="metrics" aria-label="Two-week schedule totals">
        <article>
          <span>INBOUND</span>
          <strong>{counts.inbound}</strong>
          <small>arrivals in view</small>
        </article>
        <article>
          <span>OUTBOUND</span>
          <strong>{counts.outbound}</strong>
          <small>shipments in view</small>
        </article>
        <article>
          <span>DUE TODAY</span>
          <strong>{counts.dueToday}</strong>
          <small>combined moves</small>
        </article>
        <article className={counts.exceptions ? "metric-alert" : ""}>
          <span>EXCEPTIONS</span>
          <strong>{counts.exceptions}</strong>
          <small>pending / hold / delayed</small>
        </article>
      </section>

      <section className="kpi-panel" aria-labelledby="kpi-heading">
        <div className="kpi-heading">
          <div>
            <p className="eyebrow">2026 ACTUALS · INVOICE FIRST / RATE FALLBACK</p>
            <h2 id="kpi-heading">KPI Control Tower</h2>
          </div>
          <span>MTD / YTD</span>
        </div>
        <div className="kpi-grid">
          <article className="kpi-card">
            <span>SHIPPING COSTS</span>
            <div><small>MTD</small><strong>{money(kpis.shippingMtd)}</strong></div>
            <div><small>YTD</small><strong>{money(kpis.shippingYtd)}</strong></div>
          </article>
          <article className="kpi-card">
            <span>TRANSFER SHIPPING</span>
            <div><small>MTD</small><strong>{money(kpis.transfersMtd)}</strong></div>
            <div><small>YTD</small><strong>{money(kpis.transfersYtd)}</strong></div>
          </article>
          <article className="kpi-card">
            <span>TRUCKING TRANSFERS TO NJ</span>
            <div><small>MTD</small><strong>{money(kpis.njTransferMtd)}</strong></div>
            <div><small>YTD</small><strong>{money(kpis.njTransferYtd)}</strong></div>
          </article>
          <article className="kpi-card">
            <span>SALES · NATIONALS</span>
            <div><small>MTD</small><strong>{moneyWithCents(kpis.nationalsSalesMtd)}</strong></div>
            <div><small>YTD</small><strong>{moneyWithCents(kpis.nationalsSalesYtd)}</strong></div>
          </article>
          <article className="kpi-card">
            <span>SALES · WMS WHOLESALE</span>
            <div><small>MTD</small><strong>{moneyWithCents(kpis.wmsSalesMtd)}</strong></div>
            <div><small>YTD</small><strong>{moneyWithCents(kpis.wmsSalesYtd)}</strong></div>
          </article>
          <article className="kpi-card kpi-carrier">
            <span>TOP 3 CARRIERS · YTD</span>
            <div className="carrier-table-head" aria-hidden="true">
              <small>Carrier</small><small>Earnings</small><small>Shipments</small>
            </div>
            <ol className="carrier-ranking">
              {kpis.topCarriers.map((carrier) => (
                <li key={carrier.name}>
                  <strong>{carrier.name}</strong>
                  <b>{money(carrier.earnings)}</b>
                  <small>{carrier.moves} · {carrier.shipmentPercent.toFixed(1)}%</small>
                </li>
              ))}
              {kpis.topCarriers.length === 0 && <li className="carrier-empty">Carrier data unavailable</li>}
            </ol>
          </article>
          <article className="kpi-card kpi-split">
            <span>TRUCKLOAD MIX · YTD</span>
            <div><small>LTL</small><strong>{kpis.ltlPercent}%</strong></div>
            <div><small>FTL</small><strong>{kpis.ftlPercent}%</strong></div>
          </article>
          <article className="kpi-card kpi-average">
            <span>AVG TRUCKING COST · MTD / YTD</span>
            <div className="average-head" aria-hidden="true"><small>Lane</small><small>MTD</small><small>YTD</small></div>
            <div><small>LOCAL ≤50 MI</small><strong>{money(kpis.avgLocalMtd)}</strong><strong>{money(kpis.avgLocal)}</strong></div>
            <div><small>CALIFORNIA</small><strong>{money(kpis.avgCaliforniaMtd)}</strong><strong>{money(kpis.avgCalifornia)}</strong></div>
            <div><small>OUT OF STATE</small><strong>{money(kpis.avgOutOfStateMtd)}</strong><strong>{money(kpis.avgOutOfState)}</strong></div>
          </article>
        </div>
        <p className="kpi-method">
          All rows, including hidden/completed entries. Shipping costs use freight Invoice first,
          then Rate when Invoice is blank—never shipment Invoice Amount. Nationals sales use
          Order Date (column G) and Amount (column E), expand K values, and exclude cancelled
          orders. WMS wholesale sales use Date (column A) and numeric INVOICE AMOUNT (column G);
          text entries such as “FREE SAMPLE,” “FOC,” “Sample,” and operational notes are excluded.
          MTD is the current month through today; YTD begins January 1, 2026. Trucking averages
          exclude transfers and unclassified destinations; local is within 50 miles of Buena Park.
          The NJ transfer card includes only TRANSFERS rows whose TO field is NJ or New Jersey.
          Carrier earnings use the same freight Invoice-first, Rate-fallback cost, and shipment share
          is each carrier’s moves divided by all YTD moves with a named carrier.{" "}
          <a href={NATIONAL_SHEET_URL} target="_blank" rel="noreferrer">
            Open Nationals source
          </a>
          {" · "}
          <a href={SALES_SHEET_URL} target="_blank" rel="noreferrer">
            Open WMS source
          </a>
          .
        </p>
      </section>

      <section className="control-panel" aria-label="Schedule filters">
        <label className="search">
          <span>⌕</span>
          <input
            type="search"
            placeholder="Search shipment, customer, invoice, container, carrier…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="finished-toggle">
          <input
            type="checkbox"
            checked={includeFinished}
            onChange={(event) => setIncludeFinished(event.target.checked)}
          />
          Show completed & older entries
        </label>
      </section>

      <section className="source-legend" aria-label="Entry source colors">
        <strong>Mode & carrier colors</strong>
        <div>
          {SOURCE_LEGEND.map((source) => (
            <span className={sourceClass(source)} key={source}>
              <i aria-hidden="true" />
              {source}
            </span>
          ))}
        </div>
      </section>

      <section className="source-legend department-legend" aria-label="Outbound department colors">
        <strong>Outbound departments</strong>
        <div>
          {DEPARTMENT_LEGEND.map((department) => (
            <span className={departmentClass(department)} key={department}>
              <i aria-hidden="true" />
              {department}
            </span>
          ))}
        </div>
      </section>

      <ImportSchedules
        items={importScheduleItems}
        loading={loading}
        savingId={savingId}
        onStatus={handleStatus}
        selectedInventory={selectedInventory}
      />

      <div className="inventory-grid">
        <InventoryPanel
          title="Inbound Inventory"
          eyebrow="PRODUCTS ON INBOUND SHIPMENTS"
          items={inboundInventory}
          loading={loading}
          onSelect={(item) => setSelectedInventory((current) => current?.id === item.id ? null : item)}
          selectable
          selectedItem={selectedInventory}
          showLocation={false}
        />
        <InventoryPanel
          title="Products in Stock"
          eyebrow="MATCHING PRODUCTS · CURRENT WAREHOUSE ON HAND"
          items={warehouseStock}
          loading={loading}
          selectedItem={selectedInventory}
          showLocation
        />
      </div>

      <LowStockPanel items={warehouseStock} inboundItems={inboundInventory} loading={loading} />

      <div className="schedule-stack" aria-label="Separate inbound and outbound schedules">
        <ScheduleBoard
          direction="inbound"
          days={days}
          items={inboundScheduleVisibleItems}
          loading={loading}
          savingId={savingId}
          onStatus={handleStatus}
        />
        <SmallParcelSchedule
          direction="inbound"
          items={inboundParcelVisibleItems}
          loading={loading}
          savingId={savingId}
          onStatus={handleStatus}
        />
        <ScheduleBoard
          direction="outbound"
          days={days}
          items={outboundVisibleItems}
          loading={loading}
          savingId={savingId}
          onStatus={handleStatus}
        />
        <SmallParcelSchedule
          direction="outbound"
          items={outboundParcelVisibleItems}
          loading={loading}
          savingId={savingId}
          onStatus={handleStatus}
        />
      </div>

      <footer>
        <p><strong>SK</strong> STYLEKOREAN LOGISTICS · COMPANY OPERATIONS</p>
        <p className="mono">AUTO-REFRESH 30 MIN · STATUS EDITS SYNC TO SOURCE ROWS</p>
      </footer>

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
