import { detectStrongCarrier, trackingCandidate } from "../lib/domain/carriers";

const LOGISTICS_MASTER_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const NATIONAL_SHEET_ID = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";
const WMS_SHEET_ID = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";

const IMPORTS_GID = 1497250700;
const OUTBOUND_GID = 20260708;
const TRUCKING_GID = 1418033635;
const TRANSFERS_GID = 1834454901;
const NATIONAL_GID = 99300389;
const WMS_GID = 0;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_GATEWAY_BYTES = 32 * 1024 * 1024;

export type SourceHealth = { name: string; ok: boolean; fetchedAt: string; latencyMs: number; error?: string };
export type SourceResult<T> = { health: SourceHealth; data: T | null };
export type OutboundSourceMeta = {
  sheetName: "Outbound Shipping Schedule" | "WH Trucking Request";
  headerRow: number;
  rowCount: number;
  fallback: boolean;
  reason?: string;
};

type GvizTable = { cols?: Array<{ label?: string }>; rows?: Array<{ c?: Array<{ v?: unknown; f?: string } | null> }> };
type AppsScriptSnapshot = {
  ok?: boolean;
  generatedAt?: string;
  sources?: {
    imports?: string[][];
    outbound?: string[][];
    trucking?: string[][];
    transfers?: string[][];
    nationalOutbound?: string[][];
    salesOutbound?: string[][];
    inventoryDashboardTable?: string[][];
    skwInboundTable?: string[][];
    skwStockTable?: string[][];
    pendingVerification?: string[][];
  };
};

export async function readBoundedText(response: Response, maxBytes = MAX_SOURCE_BYTES) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Source response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error(`Source response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quoted) {
      if (ch === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(value); value = ""; }
    else if (ch === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += ch;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function parseGviz(text: string): GvizTable {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Unreadable GViz response");
  const payload = JSON.parse(text.slice(start, end + 1));
  if (!payload?.table) throw new Error("GViz response missing table");
  return payload.table;
}

export function gvizTableRows(table: GvizTable | null) {
  if (!table) return [];
  const header = (table.cols ?? []).map((col) => String(col?.label ?? ""));
  const rows = (table.rows ?? []).map((row) =>
    (row.c ?? []).map((cell) => String(cell?.f ?? cell?.v ?? "")),
  );
  return [header, ...rows];
}

/** Normalize malformed parcel columns in the read snapshot only. */
export function normalizeImportsParcelRows(rows: string[][]) {
  const parcelsIndex = rows.findIndex((row) => String(row[0] ?? "").trim().toUpperCase() === "PARCELS");
  if (parcelsIndex < 0) return rows.map((row) => row.slice());
  return rows.map((sourceRow, index) => {
    const row = sourceRow.slice();
    if (index <= parcelsIndex) return row;
    const columnB = row[1] ?? "";
    const columnC = row[2] ?? "";
    const columnK = row[10] ?? "";
    const candidate = trackingCandidate(columnB, columnC, columnK);
    if (!detectStrongCarrier(candidate)) return row;
    row[1] = candidate;
    if (detectStrongCarrier(columnC) && candidate === String(columnC).replace(/[\s-]+/g, "").toUpperCase()) row[2] = "";
    return row;
  });
}

function populatedOutboundRows(rows: string[][] | null, headerRow: number) {
  if (!rows) return 0;
  return rows.slice(headerRow).filter((row) => {
    const customer = String(row[0] ?? "").trim();
    const shipDate = String(row[3] ?? "").trim();
    return Boolean(customer && shipDate);
  }).length;
}

export function selectOutboundSource(
  scheduleRows: string[][] | null,
  truckingRows: string[][] | null,
): { rows: string[][] | null; meta: OutboundSourceMeta } {
  const scheduleRowCount = populatedOutboundRows(scheduleRows, 1);
  const truckingRowCount = populatedOutboundRows(truckingRows, 2);
  if (scheduleRowCount > 0) {
    return {
      rows: scheduleRows,
      meta: { sheetName: "Outbound Shipping Schedule", headerRow: 1, rowCount: scheduleRowCount, fallback: false },
    };
  }
  if (truckingRowCount > 0) {
    return {
      rows: truckingRows,
      meta: {
        sheetName: "WH Trucking Request",
        headerRow: 2,
        rowCount: truckingRowCount,
        fallback: true,
        reason: "Outbound Shipping Schedule has no shipment rows",
      },
    };
  }
  return {
    rows: scheduleRows ?? truckingRows,
    meta: {
      sheetName: scheduleRows ? "Outbound Shipping Schedule" : "WH Trucking Request",
      headerRow: scheduleRows ? 1 : 2,
      rowCount: 0,
      fallback: Boolean(truckingRows),
      reason: "No populated outbound shipment rows are available",
    },
  };
}

// PENDING VERIFICATION read: columns A..N only — column O holds Raw JSON
// (up to 5k chars of raw extraction text: email subjects, message ids,
// document excerpts) which must never leave the backend, and the feed only
// uses the display columns. The tab is an append-only audit trail, so order
// by Timestamp (column A) descending and take the newest 2,000 rows — a
// plain A1:N2000 range would permanently exclude everything appended after
// row 2,000 before the newest-first sort could see it.
const PENDING_VERIFICATION_QUERY = {
  sheet: "PENDING VERIFICATION",
  range: "A:N",
  headers: 1,
  tq: "select * order by A desc limit 2000",
} as const;

// Review status transitions happen in place, so an old NEEDS REVIEW row can
// predate the 2,000-row tail. This companion query recovers those open rows
// (Validation.gs writes the status verbatim as "NEEDS REVIEW").
const PENDING_VERIFICATION_OPEN_QUERY = {
  sheet: "PENDING VERIFICATION",
  range: "A:N",
  headers: 1,
  tq: "select * where C = 'NEEDS REVIEW' order by A desc limit 200",
} as const;

/**
 * Direct read of PENDING VERIFICATION: the newest 2,000 rows plus any open
 * NEEDS REVIEW rows older than that window (mirrors Code.gs's
 * readPendingVerificationTail_). The open-rows query failing degrades to the
 * tail alone rather than killing the feed.
 */
async function fetchPendingVerificationDirect(): Promise<SourceResult<GvizTable>> {
  const [tail, open] = await Promise.all([
    fetchGvizSource("Pending Verification", LOGISTICS_MASTER_ID, PENDING_VERIFICATION_QUERY),
    fetchGvizSource("Pending Verification (open)", LOGISTICS_MASTER_ID, PENDING_VERIFICATION_OPEN_QUERY),
  ]);
  if (!tail.data || !open.data) return tail;
  const seen = new Set(gvizTableRows(tail.data).slice(1).map((row) => JSON.stringify(row)));
  const extraRows = gvizTableRows(open.data)
    .slice(1)
    .filter((row) => !seen.has(JSON.stringify(row)));
  if (!extraRows.length) return tail;
  return {
    health: tail.health,
    data: {
      cols: tail.data.cols,
      rows: [...(tail.data.rows ?? []), ...extraRows.map((row) => ({ c: row.map((value) => ({ v: value })) }))],
    },
  };
}

async function timedFetch(name: string, url: URL, maxBytes = MAX_SOURCE_BYTES, timeoutMs = 20_000): Promise<SourceResult<string>> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "user-agent": "StyleKorean-Control-Tower/2026-08-12" }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { data: await readBoundedText(response, maxBytes), health: { name, ok: true, fetchedAt: new Date().toISOString(), latencyMs: Date.now() - started } };
  } catch (error) {
    return { data: null, health: { name, ok: false, fetchedAt: new Date().toISOString(), latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) } };
  } finally { clearTimeout(timer); }
}

export async function fetchCsvSource(name: string, spreadsheetId: string, gid: number): Promise<SourceResult<string[][]>> {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
  url.searchParams.set("format", "csv");
  url.searchParams.set("gid", String(gid));
  url.searchParams.set("_", String(Date.now()));
  const result = await timedFetch(name, url);
  if (!result.data) return { data: null, health: result.health };
  try { return { data: parseCsv(result.data), health: result.health }; }
  catch (error) { return { data: null, health: { ...result.health, ok: false, error: String(error) } }; }
}

export async function fetchGvizSource(name: string, spreadsheetId: string, options: { gid?: number; sheet?: string; range?: string; headers?: number; tq?: string }): Promise<SourceResult<GvizTable>> {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:json");
  if (options.gid !== undefined) url.searchParams.set("gid", String(options.gid));
  if (options.sheet) url.searchParams.set("sheet", options.sheet);
  if (options.range) url.searchParams.set("range", options.range);
  if (options.tq) url.searchParams.set("tq", options.tq);
  url.searchParams.set("headers", String(options.headers ?? 1));
  url.searchParams.set("_", String(Date.now()));
  const result = await timedFetch(name, url);
  if (!result.data) return { data: null, health: result.health };
  try { return { data: parseGviz(result.data), health: result.health }; }
  catch (error) { return { data: null, health: { ...result.health, ok: false, error: String(error) } }; }
}

function rowsToGvizTable(rows: string[][] | undefined): GvizTable | null {
  if (!rows?.length) return null;
  return {
    cols: rows[0].map((label) => ({ label })),
    rows: rows.slice(1).map((row) => ({ c: row.map((value) => ({ v: value })) })),
  };
}

async function fetchAppsScriptSnapshot(endpoint: string) {
  const url = new URL(endpoint);
  url.searchParams.set("action", "snapshot");
  url.searchParams.set("_", String(Date.now()));
  const result = await timedFetch("Apps Script Snapshot", url, MAX_GATEWAY_BYTES, 60_000);
  if (!result.data) return null;
  try {
    const payload = JSON.parse(result.data) as AppsScriptSnapshot;
    return payload.ok && payload.sources ? { payload, health: result.health } : null;
  } catch {
    return null;
  }
}

export async function fetchOperationalSources(appsScriptUrl?: string) {
  if (appsScriptUrl) {
    const gateway = await fetchAppsScriptSnapshot(appsScriptUrl);
    if (gateway) {
      const raw = gateway.payload.sources!;
      const effectiveOutbound = selectOutboundSource(raw.outbound ?? null, raw.trucking ?? null);
      const healthFor = (name: string, value: unknown) => ({
        name,
        ok: value !== null && value !== undefined,
        fetchedAt: gateway.payload.generatedAt || gateway.health.fetchedAt,
        latencyMs: gateway.health.latencyMs,
        error: value === null || value === undefined ? `${name} is missing from the Apps Script snapshot` : undefined,
      });
      const outboundHealth = effectiveOutbound.meta.fallback
        ? { ...healthFor("Outbound Shipping Schedule", raw.outbound), ok: false, error: effectiveOutbound.meta.reason }
        : healthFor("Outbound Shipping Schedule", raw.outbound);
      const nationalTable = rowsToGvizTable(raw.nationalOutbound);
      const salesTable = rowsToGvizTable(raw.salesOutbound);
      const inventoryTable = rowsToGvizTable(raw.inventoryDashboardTable);
      const inboundTable = rowsToGvizTable(raw.skwInboundTable);
      const stockTable = rowsToGvizTable(raw.skwStockTable);
      // Code.gs returns pendingVerification in the snapshot; until the deployed
      // Apps Script catches up, fall back to reading the tab directly so review
      // events don't vanish from the feed in the meantime.
      const pendingFallback = raw.pendingVerification
        ? null
        : await fetchPendingVerificationDirect();
      const pendingTable = raw.pendingVerification
        ? rowsToGvizTable(raw.pendingVerification)
        : pendingFallback!.data;
      return {
        sourceHealth: [
          healthFor("IMPORTS", raw.imports),
          outboundHealth,
          healthFor("WH Trucking Request", raw.trucking),
          healthFor("TRANSFERS", raw.transfers),
          healthFor("Nationals", nationalTable),
          healthFor("WMS Stylekorean", salesTable),
          healthFor("Inventory", inventoryTable),
          healthFor("SKW Inbound", inboundTable),
          healthFor("SKW Stock", stockTable),
          pendingFallback ? pendingFallback.health : healthFor("Pending Verification", pendingTable),
        ],
        sources: {
          imports: raw.imports ? normalizeImportsParcelRows(raw.imports) : null,
          outbound: effectiveOutbound.rows,
          outboundMeta: effectiveOutbound.meta,
          nationalOutbound: nationalTable,
          salesOutbound: salesTable,
          inventoryDashboardTable: inventoryTable,
          skwInboundTable: inboundTable,
          skwStockTable: stockTable,
          // null (feed unavailable, shown as such by the card) when the pending
          // read failed — never an empty array, which would misreport "nothing
          // to review" and could be persisted to D1 over the last good feed.
          gmailIngestion: pendingTable
            ? deriveGmailIngestion({
                importsRows: raw.imports ?? null,
                outboundRows: effectiveOutbound.rows,
                pendingVerificationTable: pendingTable,
              })
            : null,
        },
        kpiRows: {
          nationalRows: raw.nationalOutbound ?? [],
          wmsRows: raw.salesOutbound ?? [],
          truckingRows: raw.trucking ?? [],
          transferRows: raw.transfers ?? [],
        },
      };
    }
  }

  const [imports, outbound, trucking, transfers, nationalOutbound, salesOutbound, inventoryDashboardTable, skwInboundTable, skwStockTable, pendingVerification] = await Promise.all([
    fetchCsvSource("IMPORTS", LOGISTICS_MASTER_ID, IMPORTS_GID),
    fetchCsvSource("Outbound Shipping Schedule", LOGISTICS_MASTER_ID, OUTBOUND_GID),
    fetchCsvSource("WH Trucking Request", LOGISTICS_MASTER_ID, TRUCKING_GID),
    fetchCsvSource("TRANSFERS", LOGISTICS_MASTER_ID, TRANSFERS_GID),
    fetchGvizSource("Nationals", NATIONAL_SHEET_ID, { gid: NATIONAL_GID, range: "A1:U3500", headers: 1 }),
    fetchGvizSource("WMS Stylekorean", WMS_SHEET_ID, { gid: WMS_GID, range: "A2:AG4200", headers: 1 }),
    fetchGvizSource("Inventory", LOGISTICS_MASTER_ID, { sheet: "INVENTORY", range: "A1:O6500", headers: 1 }),
    fetchGvizSource("SKW Inbound", LOGISTICS_MASTER_ID, { sheet: "SKW_Inbound", range: "A1:R2500", headers: 1 }),
    fetchGvizSource("SKW Stock", LOGISTICS_MASTER_ID, { sheet: "SKW_Stock", range: "A1:J2500", headers: 1 }),
    fetchPendingVerificationDirect(),
  ]);

  const effectiveOutbound = selectOutboundSource(outbound.data, trucking.data);
  const outboundHealth = effectiveOutbound.meta.fallback
    ? {
        ...outbound.health,
        ok: false,
        error: effectiveOutbound.meta.reason,
      }
    : outbound.health;

  return {
    sourceHealth: [imports, { health: outboundHealth }, trucking, transfers, nationalOutbound, salesOutbound, inventoryDashboardTable, skwInboundTable, skwStockTable, pendingVerification].map((entry) => entry.health),
    sources: {
      imports: imports.data ? normalizeImportsParcelRows(imports.data) : null,
      outbound: effectiveOutbound.rows,
      outboundMeta: effectiveOutbound.meta,
      nationalOutbound: nationalOutbound.data,
      salesOutbound: salesOutbound.data,
      inventoryDashboardTable: inventoryDashboardTable.data,
      skwInboundTable: skwInboundTable.data,
      skwStockTable: skwStockTable.data,
      // null when the pending read failed (its sourceHealth entry carries the
      // error) — an empty array would misreport "nothing to review".
      gmailIngestion: pendingVerification.data
        ? deriveGmailIngestion({
            importsRows: imports.data,
            outboundRows: effectiveOutbound.rows,
            pendingVerificationTable: pendingVerification.data,
          })
        : null,
    },
    kpiRows: {
      nationalRows: gvizTableRows(nationalOutbound.data),
      wmsRows: gvizTableRows(salesOutbound.data),
      truckingRows: trucking.data ?? [],
      transferRows: transfers.data ?? [],
    },
  };
}

// --- Gmail ingestion feed ----------------------------------------------------
// Derived entirely from data the pipeline already writes: GmailPipeline.gs tags
// every auto-committed row with "[auto: <gmail url>]" in the Notes/Remark
// column, and Validation.gs writes everything that fails validation to the
// PENDING VERIFICATION sheet. No schema changes anywhere.

export interface GmailIngestionEvent {
  status: "committed" | "needsReview" | "approved" | "rejected";
  kind: "inbound" | "outbound" | "";
  shipmentId: string;
  customer: string;
  invoice: string;
  blOrPro: string;
  container: string;
  shipDateOrEta: string;
  carrierOrVessel: string;
  note: string;
  issues: string;
  sourceEmailUrl: string;
  driveFileUrl: string;
  timestamp: string;
  // Present only on "needsReview" rows — the composite identifier
  // reviewPendingRow_ (Validation.gs) re-derives server-side from the live
  // PENDING VERIFICATION sheet to locate the exact row for an approve/reject
  // action. Deliberately excludes Timestamp: gviz's date rendering and Apps
  // Script's getDisplayValues() can format the same cell differently, so a
  // string-exact timestamp match would be fragile. Uniqueness instead comes
  // from requiring an exact match on kind+customer+invoice+blOrPro+container
  // among currently-open rows, and refusing (never guessing) if more than
  // one open row matches. Rows with no usable identifier get no reviewKey —
  // the UI disables review actions on those rather than risk acting on the
  // wrong shipment.
  reviewKey?: string;
}

const AUTO_TAG = /\[auto:\s*(https:\/\/mail\.google\.com\/[^\]\s]+)\]/i;

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.find((value) => value && value.trim())?.trim() ?? "";
}

/**
 * Scans a CSV-shaped sheet (header row first) for the GmailPipeline auto-commit tag.
 *
 * Note on production coverage: emailNoteV2_ was deliberately stubbed to keep
 * automation metadata out of the operational NOTES columns ("Keep automation
 * metadata out of operational NOTES"), so live sheets currently carry no
 * [auto: …] markers and this scan yields nothing there. The production feed is
 * driven by PENDING VERIFICATION (whose audit trail includes COMMITTED rows);
 * this scan stays as forward-compatible support for any pipeline or operator
 * that does record a Gmail permalink in a notes column.
 */
function committedEventsFromRows(rows: string[][] | null, kind: "inbound" | "outbound"): GmailIngestionEvent[] {
  if (!rows || rows.length < 2) return [];
  const header = rows[0].map((label) => String(label ?? "").trim().toUpperCase());
  const col = (...names: string[]) => names.map((name) => header.indexOf(name)).find((index) => index !== -1) ?? -1;
  const noteCol = col("NOTE", "NOTES", "REMARK", "REMARKS", "비고");
  const customerCol = col("CUSTOMER");
  const invoiceCol = col("INVOICE", "INVOICE NO.", "INVOICE#", "PI NO.");
  const blCol = col("B/L", "BL NO", "BL NO.", "BOL", "HBL", "PRO#", "PRO");
  const containerCol = col("CONTAINER", "CONTAINER NO", "CNTR");
  const dateCol = col("ETA", "SHIP DATE", "ARRIVAL");
  const carrierCol = col("VESSEL", "CARRIER", "VESSEL/VOY");
  if (noteCol === -1) return [];

  return rows.slice(1).flatMap((row) => {
    const note = String(row[noteCol] ?? "");
    const match = note.match(AUTO_TAG);
    if (!match) return [];
    const shipmentId = firstNonEmpty(
      invoiceCol !== -1 ? row[invoiceCol] : undefined,
      blCol !== -1 ? row[blCol] : undefined,
      containerCol !== -1 ? row[containerCol] : undefined,
    );
    return [{
      status: "committed",
      kind,
      shipmentId,
      customer: customerCol !== -1 ? String(row[customerCol] ?? "") : "",
      invoice: invoiceCol !== -1 ? String(row[invoiceCol] ?? "") : "",
      blOrPro: blCol !== -1 ? String(row[blCol] ?? "") : "",
      container: containerCol !== -1 ? String(row[containerCol] ?? "") : "",
      shipDateOrEta: dateCol !== -1 ? String(row[dateCol] ?? "") : "",
      carrierOrVessel: carrierCol !== -1 ? String(row[carrierCol] ?? "") : "",
      note: note.replace(AUTO_TAG, "").trim(),
      issues: "",
      sourceEmailUrl: match[1],
      driveFileUrl: "",
      timestamp: "",
    } satisfies GmailIngestionEvent];
  });
}

/** Reads the PENDING VERIFICATION gviz table into ingestion events. */
function pendingEventsFromTable(table: GvizTable | null): GmailIngestionEvent[] {
  if (!table) return [];
  const rows = gvizTableRows(table);
  if (rows.length < 2) return [];
  const header = rows[0].map((label) => String(label ?? "").trim().toUpperCase());
  const idx = (name: string) => header.indexOf(name.toUpperCase());
  const statusMap: Record<string, GmailIngestionEvent["status"]> = {
    "NEEDS REVIEW": "needsReview",
    APPROVED: "approved",
    REJECTED: "rejected",
    COMMITTED: "committed",
  };
  const cell = (row: string[], index: number) => (index === -1 ? "" : String(row[index] ?? ""));
  return rows.slice(1).map((row) => {
    const rawStatus = cell(row, idx("Status")).trim().toUpperCase();
    const kind = cell(row, idx("Kind")).trim().toLowerCase();
    const customer = cell(row, idx("Customer"));
    const invoice = cell(row, idx("Invoice / PI"));
    const blOrPro = cell(row, idx("BL / PRO"));
    const container = cell(row, idx("Container"));
    // Mirrors reviewKeyForRow_ in Validation.gs field-for-field (kind,
    // customer, invoice, BL/PRO, container — uppercased, pipe-joined). Only
    // NEEDS REVIEW rows get a key: approve/reject only ever targets an open
    // review item, and the Apps Script side only matches against open rows.
    const reviewKey = rawStatus === "NEEDS REVIEW" && (customer || invoice || blOrPro || container)
      ? [kind, customer, invoice, blOrPro, container].map((value) => value.trim().toUpperCase()).join("|")
      : undefined;
    return {
      status: statusMap[rawStatus] ?? "needsReview",
      kind: kind === "inbound" || kind === "outbound" ? kind : "",
      shipmentId: firstNonEmpty(invoice, blOrPro, container),
      customer,
      invoice,
      blOrPro,
      container,
      shipDateOrEta: cell(row, idx("Ship Date / ETA")),
      carrierOrVessel: cell(row, idx("Carrier / Vessel")),
      note: cell(row, idx("Note")),
      issues: cell(row, idx("Issues")),
      sourceEmailUrl: cell(row, idx("Source Email")),
      driveFileUrl: cell(row, idx("Drive File")),
      timestamp: cell(row, idx("Timestamp")),
      reviewKey,
    };
  });
}

export function deriveGmailIngestion(input: {
  importsRows: string[][] | null;
  outboundRows: string[][] | null;
  pendingVerificationTable: GvizTable | null;
}): GmailIngestionEvent[] {
  const committed = [
    ...committedEventsFromRows(input.importsRows, "inbound"),
    ...committedEventsFromRows(input.outboundRows, "outbound"),
  ];
  // Validation.gs appends PENDING VERIFICATION rows chronologically and keeps
  // approved/rejected rows as an audit trail, so newest entries live at the
  // bottom. Sort newest-first (timestamped rows by timestamp, the rest by
  // reverse sheet order) BEFORE applying the cap, or new actionable review
  // items would fall off the feed once the tab exceeds 200 rows.
  const pendingSorted = pendingEventsFromTable(input.pendingVerificationTable)
    .map((event, index) => ({ event, sortKey: Date.parse(event.timestamp) || index }))
    .sort((a, b) => b.sortKey - a.sortKey)
    .map(({ event }) => event);
  // Status transitions happen IN PLACE on existing rows (an old NEEDS REVIEW
  // row keeps its original timestamp when approved/rejected), so actionable
  // review items rank ahead of resolved audit rows — the cap must never hide
  // an open review item behind newer resolved history.
  const actionable = pendingSorted.filter((event) => event.status === "needsReview");
  const resolved = pendingSorted.filter((event) => event.status !== "needsReview");
  // Committed rows carry no timestamp (Sheets doesn't store one) so they sort
  // after pending.
  return [...actionable, ...resolved, ...committed].slice(0, 200);
}
