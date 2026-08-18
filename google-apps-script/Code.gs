/**
 * ============================================================================
 *  SKW LOGISTICS — GMAIL → DRIVE → SHEETS INGESTION PIPELINE
 *  StyleKorean US · Apps Script backend for the logistics board
 *  (bobo61480/logistics → https://stylekorean.dpdns.org/)
 * ----------------------------------------------------------------------------
 *  Features:
 *   · Time-driven Gmail scan (label-based) with idempotent message tracking
 *   · Attachment archival to organized Drive folders (YYYY/MM)
 *   · CSV parsing + XLSX→Sheet conversion via Drive Advanced Service
 *   · Validation layer: hard failures → Review sheet ("PENDING VERIFICATION",
 *     orange); soft warnings → committed with yellow annotation
 *   · Relational append to Inbound / Outbound with provenance (msg ID)
 *   · Inventory SKU-master rebuild + KPI freshness stamp
 *   · Review approval workflow (onEdit promotion)
 *   · LockService, per-attachment error isolation, Log sheet, daily digest
 *
 *  SETUP:
 *   1. Fill CONFIG below.
 *   2. Services (left panel) → add "Drive API" (Advanced Drive Service).
 *   3. Run setup() once and authorize.
 *   4. Deploy → Web App (Execute as Me / Anyone with link) for the JSON API.
 * ============================================================================
 */


const SPREADSHEET_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const WMS_SPREADSHEET_ID = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";
const NATIONAL_SPREADSHEET_ID = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";

const OUTBOUND_STATUS = ["", "SCHEDULED", "WORK IN PROGRESS", "PENDING", "SHIPPING", "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED"];
const INBOUND_STATUS = ["", "SCHEDULED", "WORK IN PROGRESS", "PENDING", "SHIPPING", "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED", "N/A", "Customs Clearance", "FDA Review / Hold", "FWS Review / Hold", "RECEIVED/FDA HOLD/REVIEW", "FDA Detained", "AQI Examination", "Delayed"];
const ALLOWED_SHEETS = ["WH Trucking Request", "B2B/E-COM TRUCKING", "TRANSFERS", "ULTA", "IHERB", "IMPORTS", "NATIONAL ORDER PROGRESS", "Outbound Shipping Schedule", "TJX/ROSS"];

const COMPLETED_STATUSES = ["SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED"];

// Required by transferInboundInventory_ -- restored from the pre-2026-08-07 version
// of this file after it was dropped during a source reconciliation. See
// DEPLOYMENT_NOTE.md. Do not remove without confirming SKW_Inbound -> SKW_Stock
// auto-transfer is no longer needed.
const INVENTORY_TRANSFER_STATUSES = ["DELIVERED", "RECEIVED", "COMPLETED"];
const SKW_INBOUND_SHEET = "SKW_Inbound";
const SKW_STOCK_SHEET = "SKW_Stock";
const WMS_TRUCKING_LEDGER_SHEET = "WMS Trucking Processed";

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "").trim().toLowerCase();
    if (action !== "snapshot") return json_({ ok: false, error: "Unsupported action." });
    const master = SpreadsheetApp.openById(SPREADSHEET_ID);
    const national = SpreadsheetApp.openById(NATIONAL_SPREADSHEET_ID);
    const wms = SpreadsheetApp.openById(WMS_SPREADSHEET_ID);
    return json_({
      ok: true,
      generatedAt: new Date().toISOString(),
      sources: {
        imports: readSnapshotRows_(master, "IMPORTS", null, 1, 2500, 30),
        outbound: readSnapshotRows_(master, "Outbound Shipping Schedule", null, 1, 1500, 30),
        trucking: readSnapshotRows_(master, "WH Trucking Request", null, 1, 25000, 32),
        transfers: readSnapshotRows_(master, "TRANSFERS", null, 1, 2500, 29),
        nationalOutbound: readSnapshotRows_(national, null, 99300389, 1, 3500, 21),
        salesOutbound: readSnapshotRows_(wms, null, 0, 2, 4199, 32),
        inventoryDashboardTable: readSnapshotRows_(master, "INVENTORY", null, 1, 6500, 15),
        skwInboundTable: readSnapshotRows_(master, "SKW_Inbound", null, 1, 2500, 18),
        skwStockTable: readSnapshotRows_(master, "SKW_Stock", null, 1, 2500, 10),
        // Optional: Validation.gs creates this tab lazily, so its absence must
        // not fail the whole snapshot. Feeds the dashboard's Gmail Ingestion card.
        // Sanitized to columns A..N — column O (Raw JSON) carries raw extraction
        // text and must not be exposed through this anonymously reachable
        // endpoint — and read from the tail, because the tab is an append-only
        // audit trail whose newest rows matter most.
        pendingVerification: readPendingVerificationTail_(master, "PENDING VERIFICATION", 2000, 14)
      }
    });
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  }
}

function readPendingVerificationTail_(spreadsheet, sheetName, maxRows, maxColumns) {
  try {
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      // Validation.gs creates this tab lazily on the first record that fails
      // validation, so on a clean install its absence is a legitimately EMPTY
      // feed, not a read failure. Return the canonical header row (sanitized
      // to the same column bound) so downstream sees "empty", never "degraded".
      if (typeof VALIDATION !== "undefined" && VALIDATION.pendingHeaders) {
        return [VALIDATION.pendingHeaders.slice(0, Math.max(1, Number(maxColumns) || 1))];
      }
      return null;
    }
    const lastRow = sheet.getLastRow();
    const lastColumn = Math.min(sheet.getLastColumn(), Math.max(1, Number(maxColumns) || 1));
    if (lastRow < 1 || lastColumn < 1) return null;
    const header = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues();
    if (lastRow === 1) return header;
    const firstDataRow = Math.max(2, lastRow - Math.max(1, Number(maxRows) || 1) + 1);
    const rows = sheet.getRange(firstDataRow, 1, lastRow - firstDataRow + 1, lastColumn).getDisplayValues();
    // Review status transitions happen IN PLACE on existing rows, so an old
    // NEEDS REVIEW row that predates the tail would otherwise never surface.
    // One column-C read covers the pre-tail region cheaply; unresolved rows
    // are prepended (bounded, normally zero).
    if (firstDataRow > 2) {
      const statuses = sheet.getRange(2, 3, firstDataRow - 2, 1).getDisplayValues();
      const straggler = [];
      for (let index = 0; index < statuses.length && straggler.length < 200; index += 1) {
        if (String(statuses[index][0]).trim().toUpperCase() === "NEEDS REVIEW") straggler.push(index);
      }
      if (straggler.length) {
        // Bounded batched recovery: merge nearby rows into ranged reads (a
        // ≤50-row gap costs less than another Spreadsheet-service call) and
        // cap the number of reads, so neither a review backlog nor a huge
        // pre-tail audit can stall the snapshot the Worker aborts after 60s.
        // Only open NEEDS REVIEW rows are recovered — resolved pre-tail
        // transitions are historical audit, deliberately left to the sheet.
        const runs = [];
        straggler.forEach(function (offset) {
          const last = runs[runs.length - 1];
          if (last && offset - last.end <= 50) last.end = offset;
          else runs.push({ start: offset, end: offset });
        });
        runs.slice(0, 20).forEach(function (run) {
          const block = sheet.getRange(run.start + 2, 1, run.end - run.start + 1, lastColumn).getDisplayValues();
          block.forEach(function (row) {
            if (String(row[2]).trim().toUpperCase() === "NEEDS REVIEW") rows.unshift(row);
          });
        });
      }
    }
    return header.concat(rows);
  } catch (error) {
    return null;
  }
}

function readSnapshotRows_(spreadsheet, sheetName, sheetId, startRow, maxRows, maxColumns) {
  let sheet = sheetName ? spreadsheet.getSheetByName(sheetName) : null;
  if (!sheet && sheetId !== null && sheetId !== undefined) {
    sheet = spreadsheet.getSheets().find(function (candidate) { return candidate.getSheetId() === sheetId; }) || null;
  }
  if (!sheet) throw new Error("Snapshot source sheet is unavailable.");
  const firstRow = Math.max(1, Number(startRow) || 1);
  const lastRow = Math.min(sheet.getLastRow(), firstRow + Math.max(1, Number(maxRows) || 1) - 1);
  const lastColumn = Math.min(sheet.getLastColumn(), Math.max(1, Number(maxColumns) || 1));
  if (lastRow < firstRow || lastColumn < 1) return [];
  return sheet.getRange(firstRow, 1, lastRow - firstRow + 1, lastColumn).getDisplayValues();
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let haveLock = false;
  try {
    haveLock = lock.tryLock(20000);
    if (!haveLock) {
      return json_({ ok: false, error: "Server busy, please retry." });
    }
    let rawContents = (e && e.postData && e.postData.contents) || "";
    if (!rawContents && e && e.parameter && e.parameter.postData) {
      rawContents = e.parameter.postData;
    }
    const request = JSON.parse(rawContents || "{}");

    // Dashboard-driven Gmail-ingestion approve/reject. Kept as an explicit
    // "action" discriminator so the pre-existing status-update callers
    // (which never send "action") are completely unaffected.
    if (request.action === "reviewPending") {
      return json_(reviewPendingRow_(request));
    }

    validateRequest_(request);
    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName(request.sourceSheet);
    if (!sheet) throw new Error("Source sheet not found.");

    const target = request.kind === "inbound"
      ? findInboundTarget_(sheet, request)
      : findOutboundTarget_(sheet, request);

    const status = canonicalLogisticsStatus_(request.status);
    if (!status) throw new Error("Status is not allowed.");
    const allowed = (request.kind === "inbound" ? INBOUND_STATUS : OUTBOUND_STATUS)
      .map((value) => String(value).toUpperCase());
    if (!allowed.includes(status.toUpperCase())) throw new Error("Status is not allowed for this relation.");

    const current = String(target.getDisplayValue() || "").trim();
    const requestCurrent = String(request.currentStatus || "").trim();
    const normCurrent = canonicalLogisticsStatus_(current).toUpperCase();
    const normRequest = canonicalLogisticsStatus_(requestCurrent).toUpperCase();

    // Check concurrency, tolerating default status fallbacks ("" vs "SCHEDULED").
    const DEFAULT_EQUIVALENT = ["", "SCHEDULED"];
    const bothDefaults = DEFAULT_EQUIVALENT.indexOf(normCurrent) !== -1 && DEFAULT_EQUIVALENT.indexOf(normRequest) !== -1;
    if (requestCurrent && normCurrent !== normRequest && !bothDefaults) {
      throw new Error("Status changed in the source. Refresh before saving again.");
    }

    target.setValue(status);

    let inventoryTransfer = null;
    if (request.kind === "inbound" && INVENTORY_TRANSFER_STATUSES.includes(status.toUpperCase())) {
      inventoryTransfer = transferInboundInventory_(spreadsheet, request);
    }

    // Format row in Google Sheets: grey out completed rows, reset active rows.
    const rowIdx = target.getRow();
    const rowRange = sheet.getRange(rowIdx, 1, 1, Math.max(sheet.getLastColumn(), 1));
    const isCompleted = COMPLETED_STATUSES.includes(status.toUpperCase());
    if (isCompleted) {
      rowRange.setBackground("#E8EAED").setFontColor("#5F6368");
    } else {
      rowRange.setBackground(null).setFontColor(null);
    }

    SpreadsheetApp.flush();
    return json_({ ok: true, sheet: sheet.getName(), row: rowIdx, status, isCompleted, inventoryTransfer });
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  } finally {
    if (haveLock) lock.releaseLock();
  }
}

function validateRequest_(request) {
  if (!["outbound", "inbound"].includes(request.kind)) throw new Error("Invalid relation kind.");
  if (!ALLOWED_SHEETS.includes(request.sourceSheet)) throw new Error("Source sheet is not allowed.");
}

function importsSectionMarkerRow_(values, marker) {
  const wanted = String(marker || "").trim().toUpperCase();
  for (let r = 0; r < values.length; r++) {
    if (String(values[r][0] || "").trim().toUpperCase() === wanted) return r + 1;
  }
  return 0;
}

function inboundWriteToken_(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function inboundWriteTokens_(value) {
  return String(value || "")
    .split(/[\r\n,;|/]+/)
    .map(inboundWriteToken_)
    .filter(Boolean);
}

function findInboundTarget_(sheet, request) {
  const row = Number(request.sourceRow);
  if (!Number.isInteger(row) || row < 3 || row > sheet.getLastRow()) throw new Error("Invalid IMPORTS source row.");

  const values = sheet.getDataRange().getDisplayValues();
  const schedulingRow = importsSectionMarkerRow_(values, "SCHEDULING");
  const parcelsRow = importsSectionMarkerRow_(values, "PARCELS");
  const isParcel = Boolean(request.isSmallParcel);

  if (sheet.getName() === "IMPORTS") {
    if (isParcel) {
      if (!parcelsRow || row <= parcelsRow) throw new Error("Parcel write-back row is outside the PARCELS section.");
      const wantedTracking = inboundWriteToken_(request.trackingNumber || request.pro || request.shipmentNo);
      // B is the canonical tracking column, C occasionally contains a carrier
      // tracking number in malformed legacy rows, and K carries the tracked value.
      const rowTracking = [values[row - 1][1], values[row - 1][2], values[row - 1][10]]
        .flatMap(inboundWriteTokens_);
      if (!wantedTracking || rowTracking.indexOf(wantedTracking) === -1) {
        throw new Error("Parcel source row no longer matches the selected tracking number.");
      }
    } else {
      if (schedulingRow && row >= schedulingRow) throw new Error("Import write-back row is at or below SCHEDULING.");
      const wanted = [request.shipmentNo, request.invoice, request.container, request.mbl, request.hbl]
        .flatMap(inboundWriteTokens_)
        .filter(Boolean);
      const rowTokens = values[row - 1].slice(0, 18)
        .flatMap(inboundWriteTokens_)
        .filter(Boolean);
      if (!wanted.length || !wanted.some(function (token) { return rowTokens.indexOf(token) !== -1; })) {
        throw new Error("Import source row no longer matches the selected shipment.");
      }
    }
  }

  const headers = values.slice(0, 3);
  const header = findHeader_(headers, ["WEBSITE STATUS", "STATUS", "INBOUND STATUS", "SHIPMENT STATUS"]);
  if (!header) throw new Error("Inbound status column not found.");
  return sheet.getRange(row, header.column);
}

function findOutboundTarget_(sheet, request) {
  const values = sheet.getDataRange().getDisplayValues();
  const header = findHeader_(values.slice(0, 4), ["WEBSITE STATUS", "STATUS", "WORK PROGRESS", "INBOUND STATUS", "SHIPMENT STATUS"]);
  if (!header) throw new Error("Status column not found.");
  const map = headerMap_(values[header.row - 1]);
  const sourceRow = Number(request.sourceRow);
  if (Number.isInteger(sourceRow) && sourceRow > header.row && sourceRow <= values.length) {
    return sheet.getRange(sourceRow, header.column);
  }
  const candidates = [];
  for (let r = header.row; r < values.length; r++) {
    const row = values[r];
    let score = 0;
    score += exact_(row, map, ["PRO#", "BOL", "BOL#"], request.pro) ? 100 : 0;
    score += exact_(row, map, ["INVOICE", "INVOICE NO.", "PO#"], request.invoice) ? 50 : 0;
    score += exact_(row, map, ["CUSTOMER", "NOTE", "DC"], request.customer) ? 20 : 0;
    score += exact_(row, map, ["SHIP DATE", "PU", "DATE"], request.shipDate) ? 10 : 0;
    if (score) candidates.push({ row: r + 1, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score)) {
    throw new Error("Could not identify one unique source row.");
  }
  return sheet.getRange(candidates[0].row, header.column);
}

function findHeader_(rows, names) {
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (names.includes(String(rows[r][c] || "").trim().toUpperCase())) return { row: r + 1, column: c + 1 };
    }
  }
  return null;
}

function headerMap_(headers) {
  return headers.reduce((map, value, index) => {
    map[String(value || "").trim().toUpperCase()] = index;
    return map;
  }, {});
}

function exact_(row, map, names, expected) {
  const wanted = String(expected || "").trim().toUpperCase();
  if (!wanted) return false;
  const wantedParts = wanted.split(/[\r\n,;·]+/).map(p => p.trim()).filter(Boolean);

  for (const name of names) {
    if (map[name] === undefined) continue;
    const cellVal = String(row[map[name]] || "").trim().toUpperCase();
    if (cellVal === wanted) return true;
    const parts = cellVal.split(/[\r\n,;·]+/).map(p => p.trim()).filter(Boolean);
    if (parts.some(p => wantedParts.includes(p))) return true;
  }
  return false;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

// ─── Inventory transfer (SKW_Inbound -> SKW_Stock) ─────────────────────────────
// Restored 2026-08-07 after being dropped during a Code.gs source reconciliation.
// See DEPLOYMENT_NOTE.md.

/**
 * Atomically posts matching SKW_Inbound product rows into SKW_Stock. Stock_Posted
 * and the composite Source_IB_ID make repeated completed-status requests idempotent.
 */
function transferInboundInventory_(spreadsheet, request) {
  const inbound = spreadsheet.getSheetByName(SKW_INBOUND_SHEET);
  const stock = spreadsheet.getSheetByName(SKW_STOCK_SHEET);
  if (!inbound || !stock) throw new Error("SKW inventory backend tabs are missing.");
  if (inbound.getLastRow() < 2) return { movedRows: 0, quantity: 0 };

  const values = inbound.getDataRange().getDisplayValues();
  const map = headerMap_(values[0]);
  ["IB_ID", "SKU", "PRODUCT_DESCRIPTION", "QTY_EA", "STATUS", "STOCK_POSTED"].forEach(function (header) {
    if (map[header] === undefined) throw new Error(SKW_INBOUND_SHEET + " is missing " + header + ".");
  });
  const references = [request.shipmentNo, request.invoice, request.container, request.mbl, request.hbl]
    .flatMap(referenceTokens_)
    .filter(Boolean);
  if (!references.length) throw new Error("Inventory transfer requires a shipment reference.");

  const rows = [];
  for (let index = 1; index < values.length; index++) {
    const row = values[index];
    const posted = String(row[map["STOCK_POSTED"]] || "").trim().toUpperCase();
    if (/^(TRUE|YES|POSTED|1)$/.test(posted)) continue;
    const rowStatus = String(row[map["STATUS"]] || "").trim().toUpperCase();
    if (COMPLETED_STATUSES.includes(rowStatus)) continue;
    const candidates = [row[map["IB_ID"]], row[map["PO_NUMBER"]], row[map["SOURCE_MSG_ID"]]]
      .flatMap(referenceTokens_)
      .filter(Boolean);
    if (references.some(function (reference) { return candidates.some(function (candidate) { return referencesMatch_(reference, candidate); }); })) {
      rows.push({ rowNumber: index + 1, values: row });
    }
  }
  if (!rows.length) return { movedRows: 0, quantity: 0 };

  const stockValues = stock.getDataRange().getDisplayValues();
  const stockMap = headerMap_(stockValues[0]);
  ["SKU", "UPC", "PRODUCT_DESCRIPTION", "BATCH_NO", "EXPIRY_DATE", "QTY_EA", "LOCATION", "SOURCE_IB_ID", "RECEIVED_AT", "UPDATED_AT"].forEach(function (header) {
    if (stockMap[header] === undefined) throw new Error(SKW_STOCK_SHEET + " is missing " + header + ".");
  });
  const postedKeys = new Set(stockValues.slice(1).map(function (row) {
    return String(row[stockMap["SOURCE_IB_ID"]] || "").trim().toUpperCase();
  }).filter(Boolean));

  let totalQuantity = 0;
  let movedRows = 0;
  const now = new Date();
  rows.forEach(function (record) {
    const row = record.values;
    const ibId = row[map["IB_ID"]] || request.shipmentNo || request.invoice || "";
    const sku = row[map["SKU"]] || "";
    const upc = row[map["UPC"]] || "";
    const product = row[map["PRODUCT_DESCRIPTION"]] || "";
    const batch = row[map["BATCH_NO"]] || "";
    const expiration = row[map["EXPIRY_DATE"]] || "";
    const quantity = Number(String(row[map["QTY_EA"]] || "0").replace(/,/g, "")) || 0;
    if (quantity <= 0) return;
    const location = row[map["LOCATION"]] || "UNASSIGNED";
    const sourceKey = [ibId, sku || upc, batch, expiration]
      .map(function (value) { return String(value || "").trim().toUpperCase(); })
      .join("::");
    if (postedKeys.has(sourceKey)) {
      inbound.getRange(record.rowNumber, map["STOCK_POSTED"] + 1).setValue(true);
      return;
    }
    stock.appendRow([sku, upc, product, batch, expiration, quantity, location, sourceKey, now, now]);
    postedKeys.add(sourceKey);
    if (map["RECEIVED_DATE"] !== undefined) inbound.getRange(record.rowNumber, map["RECEIVED_DATE"] + 1).setValue(now);
    inbound.getRange(record.rowNumber, map["STATUS"] + 1).setValue("Received");
    inbound.getRange(record.rowNumber, map["STOCK_POSTED"] + 1).setValue(true);
    totalQuantity += quantity;
    movedRows++;
  });
  return { movedRows, quantity: totalQuantity };
}

function referenceTokens_(value) {
  return String(value || "")
    .split(/[\r\n,;|]+/)
    .map(function (token) { return token.trim().toUpperCase(); })
    .filter(Boolean);
}

function referencesMatch_(left, right) {
  const a = String(left || "").replace(/[^A-Z0-9]/g, "");
  const b = String(right || "").replace(/[^A-Z0-9]/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (shorter < 8) return false;
  if (shorter / longer < 0.6) return false;
  return a.includes(b) || b.includes(a);
}

// The legacy WMS importer was removed on 2026-08-12. The only callable legacy
// handler name now lives in zz_WmsTruckingCompatibility.gs and delegates to V2.

function findWmsTruckingHeader_(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const map = headerMap_(rows[r]);
    if (map["INVOICE#"] !== undefined && map["CUSTOMER NAME"] !== undefined &&
        map["SHIP OUT DATE"] !== undefined && map["SHIPPING METHOD"] !== undefined) {
      return { rowIndex: r, map: map };
    }
  }
  throw new Error("Could not locate the WMS Stylekorean header row.");
}

function findWhTruckingHeader_(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const map = headerMap_(rows[r]);
    if (map["CUSTOMER"] !== undefined && map["INVOICE NO."] !== undefined && map["SHIP DATE"] !== undefined) {
      return { rowIndex: r, map: map };
    }
  }
  throw new Error("Could not locate the WH Trucking Request header row.");
}

function normalizeWmsCustomerKey_(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(INC|INCORPORATED|LLC|L L C|CORP|CORPORATION)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalWmsCustomer_(value) {
  const raw = String(value || "").trim();
  const key = normalizeWmsCustomerKey_(raw);
  const aliases = {
    "BEAUTIFYME COSMETICS": "BEAUTIFYME",
    "BEAUTIFYME": "BEAUTIFYME",
    "TOKTOK BEAUTY TEAMZL LC": "TOKTOK BEAUTY",
    "TOKTOK BEAUTY": "TOKTOK BEAUTY",
    "ROYAL IMEX": "ROYAL IMEX INC",
    "PPIH GUAM": "Great Luck Inc. (PPIH - GUAM)",
    "GLOWISS": "GLOWISS",
    "GLOWISS LLC": "GLOWISS"
  };
  if (key.indexOf("MEGA MART") === 0) return "MEGA MART";
  if (key.indexOf("TOKTOK BEAUTY") === 0) return "TOKTOK BEAUTY";
  if (key.indexOf("ROYAL IMEX") === 0) return "ROYAL IMEX INC";
  if (key === "PPIH GUAM" || key === "GREAT LUCK PPIH GUAM") return "Great Luck Inc. (PPIH - GUAM)";
  return aliases[key] || raw.toUpperCase().replace(/\s+/g, " ").trim();
}

function isWmsFreightMethod_(value) {
  const method = String(value || "").trim().toUpperCase();
  if (!method) return false;
  if (/\b(UPS|USPS|DHL|FEDEX|AMAZON)\b/.test(method)) return false;
  return /\b(TRUCKING|LTL|FREIGHT)\b/.test(method) || method.indexOf("LOCAL DELIVERY") !== -1;
}

function isWmsActiveStatus_(value) {
  const status = String(value || "").trim().toUpperCase();
  return ["SHIPPED", "DELIVERED", "RECEIVED", "COMPLETED", "CANCELLED"].indexOf(status) === -1;
}

function mergeWmsInvoices_(existing, additions) {
  const result = [];
  [].concat(existing || [], additions || []).forEach(function (invoice) {
    const clean = String(invoice || "").trim().toUpperCase();
    if (clean && result.indexOf(clean) === -1) result.push(clean);
  });
  return result;
}

function earliestWmsSourceDateForInvoices_(invoices, sourceByInvoice, fallback) {
  const candidates = [];
  (invoices || []).forEach(function (invoice) {
    const source = sourceByInvoice.get(invoice);
    if (source && source.dateInfo && source.dateInfo.key) candidates.push(source.dateInfo);
  });
  if (fallback) candidates.push(normalizeWmsShipDate_(fallback));
  candidates.sort(function (a, b) { return a.key.localeCompare(b.key); });
  return candidates.length ? candidates[0].display : fallback;
}

function writeMappedValue_(sheet, rowNumber, map, header, value) {
  const index = map[header];
  if (index === undefined || value === undefined || value === null) return false;
  const range = sheet.getRange(rowNumber, index + 1);
  if (String(range.getDisplayValue() || "").trim() === String(value).trim()) return false;
  range.setValue(value);
  return true;
}

function normalizeWmsShipDate_(value) {
  const text = String(value || "").trim();
  // Some ledger rows are appended as raw Google Sheets serial numbers without
  // a date number format. Decode those explicitly so reconciliation still
  // compares the correct calendar day.
  if (/^\d{4,5}(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial >= 20000 && serial <= 80000) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      return { key: year + "-" + month + "-" + day, display: month + "/" + day + "/" + year };
    }
  }
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) {
    return { key: text.toUpperCase(), display: text };
  }
  const zone = Session.getScriptTimeZone() || "America/Los_Angeles";
  return {
    key: Utilities.formatDate(parsed, zone, "yyyy-MM-dd"),
    display: Utilities.formatDate(parsed, zone, "MM/dd/yyyy")
  };
}

function parseWmsAmount_(value) {
  const text = String(value || "").replace(/[$,\s]/g, "");
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

function splitWmsInvoices_(value) {
  return String(value || "")
    .toUpperCase()
    .split(/[\r\n,;·/]+/)
    .map(function (item) { return item.trim(); })
    .filter(Boolean);
}

function setMappedValue_(row, map, header, value) {
  const index = map[header];
  if (index === undefined || value === undefined || value === null) return false;
  if (String(row[index] || "").trim() === String(value).trim()) return false;
  row[index] = value;
  return true;
}

function exactVal_(row, map, names) {
  for (const n of names) {
    if (map[n] !== undefined && row[map[n]]) return String(row[map[n]]).trim();
  }
  return "";
}

/**
 * Backward-compatible trigger setup entry point. Trigger ownership is centralized
 * in Triggers.gs so this helper can no longer recreate the unsafe legacy handler.
 */
function createTimeDrivenTrigger() {
  return setupAllTriggers();
}

/** Backward-compatible entry point for anyone who previously used this name. */
function create30MinTrigger() {
  return setupAllTriggers();
}

/**
 * Adds "WEBSITE STATUS" dropdown data validation column at the end of each source sheet
 * in LOGISTICS MASTER 2026, applying the same validation rules as Column AE of IMPORTS.
 * Explicitly excludes external sheets 14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I and 12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8.
 */
function addWebsiteStatusDropdownToAllSourceSheets() {
  const EXCLUDED_SPREADSHEET_IDS = [
    "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I",
    "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8"
  ];
  
  const targetSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  if (EXCLUDED_SPREADSHEET_IDS.includes(targetSpreadsheet.getId())) {
    Logger.log("Target spreadsheet is in excluded list. Skipping.");
    return { ok: false, error: "Spreadsheet excluded." };
  }

  const TARGET_SOURCE_TABS = [
    "TRANSFERS",
    "ULTA",
    "IHERB",
    "B2B/E-COM TRUCKING",
    "WH Trucking Request",
    "NATIONAL ORDER PROGRESS",
    "Outbound Shipping Schedule",
    "TJX/ROSS"
  ];

  const STATUS_LIST = [
    "SCHEDULED",
    "WORK IN PROGRESS",
    "PENDING",
    "SHIPPING",
    "SHIPPED",
    "DELIVERED",
    "RECEIVED",
    "CANCELLED",
    "COMPLETED"
  ];

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_LIST, true)
    .setAllowInvalid(false)
    .setHelpText("Select a valid Website Status from the list.")
    .build();

  let modifiedCount = 0;

  TARGET_SOURCE_TABS.forEach((tabName) => {
    const sheet = targetSpreadsheet.getSheetByName(tabName);
    if (!sheet) {
      Logger.log("Sheet tab not found: " + tabName);
      return;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return;

    // Detect header row and column
    const headers = sheet.getRange(1, 1, Math.min(3, lastRow), sheet.getLastColumn()).getDisplayValues();
    let headerRowIdx = 1;
    let colIdx = -1;

    for (let r = 0; r < headers.length; r++) {
      const row = headers[r].map(c => String(c || "").trim().toUpperCase());
      const foundIdx = row.indexOf("WEBSITE STATUS");
      if (foundIdx !== -1) {
        headerRowIdx = r + 1;
        colIdx = foundIdx + 1;
        break;
      }
    }

    // If column doesn't exist, append header to last column + 1
    if (colIdx === -1) {
      colIdx = sheet.getLastColumn() + 1;
      headerRowIdx = 2; // Default header row index for standard tabs
      sheet.getRange(headerRowIdx, colIdx).setValue("WEBSITE STATUS").setFontWeight("bold");
    }

    // Apply data validation rule down the column
    const startRow = headerRowIdx + 1;
    const numRows = Math.max(lastRow - headerRowIdx, 100);
    const range = sheet.getRange(startRow, colIdx, numRows, 1);
    range.setDataValidation(rule);

    modifiedCount++;
    Logger.log("Applied WEBSITE STATUS dropdown to sheet: " + tabName + " (Col " + colIdx + ")");
  });

  SpreadsheetApp.flush();
  return { ok: true, sheetsUpdated: modifiedCount };
}
