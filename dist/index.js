var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// lib/kpis/compute.ts
function dateCode(value) {
  const match = String(value ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return 0;
  let year = Number(match[3]);
  if (year < 100) year += 2e3;
  return year * 1e4 + Number(match[1]) * 100 + Number(match[2]);
}
__name(dateCode, "dateCode");
function amount(value, allowSuffix) {
  const text = String(value ?? "").trim().toUpperCase().replace(/[$,\s]/g, "");
  const match = text.match(allowSuffix ? /^(-?\d+(?:\.\d+)?)([KMB])?$/ : /^(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const multiplier = match[2] === "K" ? 1e3 : match[2] === "M" ? 1e6 : match[2] === "B" ? 1e9 : 1;
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) ? parsed : null;
}
__name(amount, "amount");
function freightAmount(value) {
  const text = String(value ?? "").trim().toUpperCase().replace(/\bUSD\b/g, "").trim();
  if (!text || /[A-Z]/.test(text) || !/^[\s$,\d().-]+$/.test(text)) return 0;
  const parsed = amount(text.replace(/[()]/g, ""), true) ?? 0;
  return parsed > 0 && parsed <= 25e4 ? parsed : 0;
}
__name(freightAmount, "freightAmount");
function freightDateCode(value, today) {
  const full = dateCode(value);
  if (full) return full;
  const match = String(value ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return 0;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const hasOccurred = month < today.month || month === today.month && day <= today.day;
  const year = hasOccurred ? today.year : today.year + 1;
  return year * 1e4 + month * 100 + day;
}
__name(freightDateCode, "freightDateCode");
function loadType(value) {
  const text = String(value ?? "").trim();
  if (/\bFTL\b|FULL\s*TRUCK|TRUCKLOAD/i.test(text)) return "FTL";
  return Number(text.match(/\d+/)?.[0] ?? 0) >= 10 ? "FTL" : "LTL";
}
__name(loadType, "loadType");
function isNewJerseyDestination(destination) {
  return /\b(?:NJ|NEW JERSEY)\b/i.test(String(destination ?? "").trim());
}
__name(isNewJerseyDestination, "isNewJerseyDestination");
function distanceBand(destination) {
  const text = String(destination ?? "").trim().toUpperCase();
  if (!text) return "unknown";
  const localCity = /\b(BUENA PARK|ANAHEIM|CERRITOS|LA MIRADA|FULLERTON|LA HABRA|BREA|ORANGE|SANTA ANA|IRVINE|COSTA MESA|HUNTINGTON BEACH|LONG BEACH|CARSON|TORRANCE|COMPTON|DOWNEY|NORWALK|WHITTIER|POMONA|ONTARIO|BLOOMINGTON|LOS ANGELES|GLENDALE|PASADENA)\b/;
  const localZip = /\b(90[0-8]\d{2}|91[0-2]\d{2}|917\d{2}|918\d{2}|92316|926\d{2}|927\d{2}|928\d{2})\b/;
  if (localCity.test(text) || localZip.test(text)) return "local";
  if (/\bCA\b|CALIFORNIA/.test(text)) return "california";
  if (/\b(AL|AK|AZ|AR|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/.test(text) || /\b(NEW JERSEY|NEW YORK|WASHINGTON|TEXAS|ILLINOIS|FLORIDA|GEORGIA|PENNSYLVANIA|MASSACHUSETTS|ARIZONA|NEVADA|OREGON|COLORADO)\b/.test(text)) return "out-of-state";
  return "unknown";
}
__name(distanceBand, "distanceBand");
function pacificToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(/* @__PURE__ */ new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, code: values.year * 1e4 + values.month * 100 + values.day };
}
__name(pacificToday, "pacificToday");
function computeKpisFromRows(input) {
  const today = input.today ?? pacificToday();
  const yearStart = today.year * 1e4 + 101;
  const monthStart = today.year * 1e4 + today.month * 100 + 1;
  const nationalSales = input.nationalRows.slice(1).flatMap((row) => {
    if ((row[0] ?? "").trim().toLowerCase() === "cancelled") return [];
    const date = dateCode(row[6] ?? "");
    const value = amount(row[4] ?? "", true);
    return date >= yearStart && date <= today.code && value !== null && value > 0 ? [{ date, value }] : [];
  });
  const wmsSales = input.wmsRows.slice(1).flatMap((row) => {
    const date = dateCode(row[0] ?? "");
    const value = amount(row[6] ?? "", false);
    return date >= yearStart && date <= today.code && value !== null ? [{ date, value }] : [];
  });
  const sum = /* @__PURE__ */ __name((records, start) => records.filter((r) => r.date >= start).reduce((total, r) => total + r.value, 0), "sum");
  const trucking = input.truckingRows.slice(2).flatMap((row) => {
    const date = freightDateCode(row[3] ?? "", today);
    if (!date) return [];
    return [{ date, cost: freightAmount(row[21] ?? "") || freightAmount(row[17] ?? ""), carrier: (row[16] ?? "").trim().replace(/\s+/g, " "), destination: (row[2] ?? "").trim(), loadType: loadType([row[4], row[5]].filter(Boolean).join(" ")), isTransfer: false }];
  });
  const transfer = input.transferRows.slice(1).flatMap((row) => {
    const date = freightDateCode(row[5] ?? "", today);
    if (!date) return [];
    return [{ date, cost: freightAmount(row[9] ?? "") || freightAmount(row[8] ?? ""), carrier: (row[6] ?? "").trim().replace(/\s+/g, " "), destination: (row[4] ?? "").trim(), loadType: loadType(row[1] ?? ""), isTransfer: true }];
  });
  const freight = [...trucking, ...transfer].filter((r) => r.date >= yearStart && r.date <= today.code);
  const freightMtd = freight.filter((r) => r.date >= monthStart);
  const transferYtd = freight.filter((r) => r.isTransfer);
  const transferMtd = freightMtd.filter((r) => r.isTransfer);
  const njTransferYtd = transferYtd.filter((r) => isNewJerseyDestination(r.destination));
  const njTransferMtd = transferMtd.filter((r) => isNewJerseyDestination(r.destination));
  const carrierTotals = freight.reduce((totals, record) => {
    if (!record.carrier) return totals;
    const key = record.carrier.toUpperCase();
    const current = totals.get(key) ?? { name: record.carrier, earnings: 0, moves: 0 };
    current.earnings += record.cost;
    current.moves += 1;
    totals.set(key, current);
    return totals;
  }, /* @__PURE__ */ new Map());
  const namedMoves = [...carrierTotals.values()].reduce((total, carrier) => total + carrier.moves, 0);
  const topCarriers = [...carrierTotals.values()].sort((a, b) => b.moves - a.moves || b.earnings - a.earnings).slice(0, 3).map((carrier) => ({ ...carrier, shipmentPercent: namedMoves ? Math.round(carrier.moves / namedMoves * 1e3) / 10 : 0 }));
  const classified = freight.filter((r) => !r.isTransfer || r.cost > 0);
  const ltl = classified.filter((r) => r.loadType === "LTL").length;
  const ftl = classified.filter((r) => r.loadType === "FTL").length;
  const splitTotal = ltl + ftl;
  const average = /* @__PURE__ */ __name((records, band) => {
    const matching = records.filter((r) => !r.isTransfer && r.cost > 0 && distanceBand(r.destination) === band);
    return matching.length ? matching.reduce((total, r) => total + r.cost, 0) / matching.length : 0;
  }, "average");
  return {
    nationalsSalesMtd: sum(nationalSales, monthStart),
    nationalsSalesYtd: sum(nationalSales, yearStart),
    wmsSalesMtd: sum(wmsSales, monthStart),
    wmsSalesYtd: sum(wmsSales, yearStart),
    shippingMtd: freightMtd.reduce((t, r) => t + r.cost, 0),
    shippingYtd: freight.reduce((t, r) => t + r.cost, 0),
    transfersMtd: transferMtd.reduce((t, r) => t + r.cost, 0),
    transfersYtd: transferYtd.reduce((t, r) => t + r.cost, 0),
    njTransferMtd: njTransferMtd.reduce((t, r) => t + r.cost, 0),
    njTransferYtd: njTransferYtd.reduce((t, r) => t + r.cost, 0),
    topCarriers,
    ltlPercent: splitTotal ? Math.round(ltl / splitTotal * 100) : 0,
    ftlPercent: splitTotal ? Math.round(ftl / splitTotal * 100) : 0,
    avgLocal: average(freight, "local"),
    avgCalifornia: average(freight, "california"),
    avgOutOfState: average(freight, "out-of-state"),
    avgLocalMtd: average(freightMtd, "local"),
    avgCaliforniaMtd: average(freightMtd, "california"),
    avgOutOfStateMtd: average(freightMtd, "out-of-state")
  };
}
__name(computeKpisFromRows, "computeKpisFromRows");

// worker/database.ts
var PART_BYTES = 512 * 1024;
var MAX_PARTS = 44;
var RETAINED_SNAPSHOTS = 4;
function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}
__name(byteLength, "byteLength");
function splitPayload(value) {
  const serialized = JSON.stringify(value);
  if (serialized === void 0) throw new Error("Snapshot value is not JSON serializable");
  const chunks = [];
  const encoder = new TextEncoder();
  let start = 0;
  while (start < serialized.length) {
    const buffer = new Uint8Array(PART_BYTES);
    const { read, written } = encoder.encodeInto(serialized.slice(start), buffer);
    if (!read || !written) throw new Error("Snapshot payload could not be chunked");
    const chunk = serialized.slice(start, start + read);
    if (byteLength(chunk) !== written) throw new Error("Snapshot chunk byte count is inconsistent");
    chunks.push(chunk);
    start += read;
  }
  return chunks.length ? chunks : [""];
}
__name(splitPayload, "splitPayload");
function joinPayload(chunks) {
  return JSON.parse(chunks.join(""));
}
__name(joinPayload, "joinPayload");
function payloadEntries(snapshot) {
  return [
    ["sourceHealth", snapshot.sourceHealth],
    ["sources", snapshot.sources],
    ["kpis", snapshot.kpis],
    ["kpiError", snapshot.kpiError ?? null]
  ];
}
__name(payloadEntries, "payloadEntries");
async function persistSnapshot(db, snapshot) {
  const id = crypto.randomUUID();
  const entries = payloadEntries(snapshot);
  const parts = entries.flatMap(
    ([name, value]) => splitPayload(value).map((payload, index) => ({ name, index, payload, bytes: byteLength(payload) }))
  );
  if (parts.length > MAX_PARTS) throw new Error(`Snapshot requires ${parts.length} database parts; limit is ${MAX_PARTS}`);
  const payloadBytes = parts.reduce((total, part) => total + part.bytes, 0);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const statements = [
    db.prepare(`INSERT INTO operational_snapshots
      (id, generated_at, version, source_count, part_count, payload_bytes)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(
      id,
      snapshot.generatedAt,
      snapshot.version,
      snapshot.sourceHealth.length,
      parts.length,
      payloadBytes
    ),
    ...parts.map((part) => db.prepare(`INSERT INTO operational_snapshot_parts
      (snapshot_id, part_name, part_index, payload_text, payload_bytes)
      VALUES (?, ?, ?, ?, ?)`).bind(id, part.name, part.index, part.payload, part.bytes)),
    db.prepare(`INSERT INTO operational_state (key, snapshot_id, updated_at)
      VALUES ('current_snapshot', ?, ?)
      ON CONFLICT(key) DO UPDATE SET snapshot_id = excluded.snapshot_id, updated_at = excluded.updated_at`).bind(id, now)
  ];
  await db.batch(statements);
  await db.prepare(`DELETE FROM operational_snapshots
    WHERE id NOT IN (
      SELECT id FROM operational_snapshots ORDER BY generated_at DESC LIMIT ?
    ) AND id NOT IN (SELECT snapshot_id FROM operational_state)`).bind(RETAINED_SNAPSHOTS).run();
  return { id, partCount: parts.length, payloadBytes };
}
__name(persistSnapshot, "persistSnapshot");
async function readCurrentSnapshot(db) {
  const [metadataResult, partsResult] = await db.batch([
    db.prepare(`SELECT s.id, s.generated_at, s.version, s.source_count, s.part_count,
      s.payload_bytes, s.created_at
      FROM operational_state state
      JOIN operational_snapshots s ON s.id = state.snapshot_id
      WHERE state.key = 'current_snapshot'`),
    db.prepare(`SELECT p.part_name, p.part_index, p.payload_text, p.payload_bytes
      FROM operational_state state
      JOIN operational_snapshot_parts p ON p.snapshot_id = state.snapshot_id
      WHERE state.key = 'current_snapshot'
      ORDER BY p.part_name, p.part_index`)
  ]);
  const metadata = metadataResult.results[0];
  if (!metadata) return null;
  const rows = partsResult.results;
  if (rows.length !== metadata.part_count) throw new Error("Current D1 snapshot is incomplete");
  const actualPayloadBytes = rows.reduce((total, row) => {
    const actualPartBytes = byteLength(row.payload_text);
    if (actualPartBytes !== row.payload_bytes) {
      throw new Error(`Current D1 snapshot part ${row.part_name}:${row.part_index} failed integrity validation`);
    }
    return total + actualPartBytes;
  }, 0);
  if (actualPayloadBytes !== metadata.payload_bytes) {
    throw new Error("Current D1 snapshot byte count failed integrity validation");
  }
  const grouped = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const chunks = grouped.get(row.part_name) ?? [];
    chunks[row.part_index] = row.payload_text;
    grouped.set(row.part_name, chunks);
  }
  const decode = /* @__PURE__ */ __name((name) => {
    const chunks = grouped.get(name);
    if (!chunks?.length || chunks.some((chunk) => chunk === void 0)) {
      throw new Error(`Current D1 snapshot is missing ${name}`);
    }
    return joinPayload(chunks);
  }, "decode");
  const sourceHealth = decode("sourceHealth");
  if (!Array.isArray(sourceHealth) || sourceHealth.length !== metadata.source_count) {
    throw new Error("Current D1 snapshot source count failed integrity validation");
  }
  return {
    ok: true,
    generatedAt: metadata.generated_at,
    version: metadata.version,
    sourceHealth,
    sources: decode("sources"),
    kpis: decode("kpis"),
    kpiError: decode("kpiError") ?? void 0,
    storage: "d1",
    storedAt: metadata.created_at
  };
}
__name(readCurrentSnapshot, "readCurrentSnapshot");
async function readDatabaseHealth(db) {
  const row = await db.prepare(`SELECT s.generated_at, s.created_at, s.source_count,
    s.part_count, s.payload_bytes
    FROM operational_state state
    JOIN operational_snapshots s ON s.id = state.snapshot_id
    WHERE state.key = 'current_snapshot'`).first();
  return row ? {
    ready: true,
    generatedAt: row.generated_at,
    storedAt: row.created_at,
    ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(row.generated_at)) / 1e3)),
    sourceCount: row.source_count,
    partCount: row.part_count,
    payloadBytes: row.payload_bytes
  } : { ready: false };
}
__name(readDatabaseHealth, "readDatabaseHealth");
async function recordPendingReviewDecision(db, event) {
  await db.prepare(`INSERT INTO automation_events
    (id, source, entity_type, entity_id, previous_json, proposed_json, decision,
      actor, correlation_id, verification, created_at)
    VALUES (?, 'gmail-review', 'gmail-review', ?, ?, ?, ?, 'operator', ?, 'source-confirmed', ?)`).bind(
    crypto.randomUUID(),
    event.shipmentId || event.reviewKey,
    JSON.stringify({ status: "NEEDS REVIEW" }),
    JSON.stringify({ status: event.resultingStatus }),
    event.decision === "approve" ? "confirmed" : "rejected",
    event.correlationId,
    (/* @__PURE__ */ new Date()).toISOString()
  ).run();
}
__name(recordPendingReviewDecision, "recordPendingReviewDecision");
async function recordConfirmedStatusWrite(db, event) {
  await db.prepare(`INSERT INTO automation_events
    (id, source, entity_type, entity_id, previous_json, proposed_json, decision,
      actor, correlation_id, verification, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'operator', ?, 'source-confirmed', ?)`).bind(
    crypto.randomUUID(),
    `${event.sourceSheet}:${event.sourceRow}`,
    event.entityType,
    event.entityId,
    JSON.stringify({ status: event.previousStatus ?? null }),
    JSON.stringify({ status: event.status }),
    event.correlationId,
    (/* @__PURE__ */ new Date()).toISOString()
  ).run();
}
__name(recordConfirmedStatusWrite, "recordConfirmedStatusWrite");

// lib/domain/carriers.ts
function clean(value) {
  return String(value ?? "").trim();
}
__name(clean, "clean");
function normalizedTracking(value) {
  return clean(value).replace(/^(TRACKING|TRACK|PRO)\s*#?\s*/i, "").replace(/[\s-]+/g, "").toUpperCase();
}
__name(normalizedTracking, "normalizedTracking");
function detectStrongCarrier(value) {
  const tracking = normalizedTracking(value);
  if (!tracking) return "";
  if (/^1Z[A-Z0-9]{16}$/.test(tracking)) return "UPS";
  if (/^TBA[A-Z0-9]{8,}$/.test(tracking)) return "AMAZON";
  if (/^(?:JJD|JD)[A-Z0-9]{8,}$/.test(tracking)) return "DHL";
  if (/^(?:92|93|94|95)\d{18,22}$/.test(tracking)) return "USPS";
  if (/^[A-Z]{2}\d{9}US$/.test(tracking)) return "USPS";
  return "";
}
__name(detectStrongCarrier, "detectStrongCarrier");
function trackingCandidate(...values) {
  const candidates = values.flatMap((value) => clean(value).split(/\r?\n|,\s*/)).map(normalizedTracking).filter(Boolean);
  const strong = candidates.find((value) => Boolean(detectStrongCarrier(value)));
  if (strong) return strong;
  return candidates.find((value) => /^\d{10,30}$/.test(value)) ?? "";
}
__name(trackingCandidate, "trackingCandidate");

// worker/sources.ts
var LOGISTICS_MASTER_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
var NATIONAL_SHEET_ID = "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8";
var WMS_SHEET_ID = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";
var IMPORTS_GID = 1497250700;
var OUTBOUND_GID = 20260708;
var TRUCKING_GID = 1418033635;
var TRANSFERS_GID = 1834454901;
var NATIONAL_GID = 99300389;
var WMS_GID = 0;
var MAX_SOURCE_BYTES = 4 * 1024 * 1024;
var MAX_GATEWAY_BYTES = 32 * 1024 * 1024;
async function readBoundedText(response, maxBytes = MAX_SOURCE_BYTES) {
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
__name(readBoundedText, "readBoundedText");
function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quoted) {
      if (ch === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(value);
      value = "";
    } else if (ch === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else value += ch;
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}
__name(parseCsv, "parseCsv");
function parseGviz(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Unreadable GViz response");
  const payload = JSON.parse(text.slice(start, end + 1));
  if (!payload?.table) throw new Error("GViz response missing table");
  return payload.table;
}
__name(parseGviz, "parseGviz");
function gvizTableRows(table) {
  if (!table) return [];
  const header = (table.cols ?? []).map((col) => String(col?.label ?? ""));
  const rows = (table.rows ?? []).map(
    (row) => (row.c ?? []).map((cell) => String(cell?.f ?? cell?.v ?? ""))
  );
  return [header, ...rows];
}
__name(gvizTableRows, "gvizTableRows");
function normalizeImportsParcelRows(rows) {
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
__name(normalizeImportsParcelRows, "normalizeImportsParcelRows");
function populatedOutboundRows(rows, headerRow) {
  if (!rows) return 0;
  return rows.slice(headerRow).filter((row) => {
    const customer = String(row[0] ?? "").trim();
    const shipDate = String(row[3] ?? "").trim();
    return Boolean(customer && shipDate);
  }).length;
}
__name(populatedOutboundRows, "populatedOutboundRows");
function selectOutboundSource(scheduleRows, truckingRows) {
  const scheduleRowCount = populatedOutboundRows(scheduleRows, 1);
  const truckingRowCount = populatedOutboundRows(truckingRows, 2);
  if (scheduleRowCount > 0) {
    return {
      rows: scheduleRows,
      meta: { sheetName: "Outbound Shipping Schedule", headerRow: 1, rowCount: scheduleRowCount, fallback: false }
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
        reason: "Outbound Shipping Schedule has no shipment rows"
      }
    };
  }
  return {
    rows: scheduleRows ?? truckingRows,
    meta: {
      sheetName: scheduleRows ? "Outbound Shipping Schedule" : "WH Trucking Request",
      headerRow: scheduleRows ? 1 : 2,
      rowCount: 0,
      fallback: Boolean(truckingRows),
      reason: "No populated outbound shipment rows are available"
    }
  };
}
__name(selectOutboundSource, "selectOutboundSource");
var PENDING_VERIFICATION_QUERY = {
  sheet: "PENDING VERIFICATION",
  range: "A:N",
  headers: 1,
  tq: "select * order by A desc limit 2000"
};
var PENDING_VERIFICATION_OPEN_QUERY = {
  sheet: "PENDING VERIFICATION",
  range: "A:N",
  headers: 1,
  tq: "select * where C = 'NEEDS REVIEW' order by A desc limit 200"
};
async function fetchPendingVerificationDirect() {
  const [tail, open] = await Promise.all([
    fetchGvizSource("Pending Verification", LOGISTICS_MASTER_ID, PENDING_VERIFICATION_QUERY),
    fetchGvizSource("Pending Verification (open)", LOGISTICS_MASTER_ID, PENDING_VERIFICATION_OPEN_QUERY)
  ]);
  if (!tail.data || !open.data) return tail;
  const seen = new Set(gvizTableRows(tail.data).slice(1).map((row) => JSON.stringify(row)));
  const extraRows = gvizTableRows(open.data).slice(1).filter((row) => !seen.has(JSON.stringify(row)));
  if (!extraRows.length) return tail;
  return {
    health: tail.health,
    data: {
      cols: tail.data.cols,
      rows: [...tail.data.rows ?? [], ...extraRows.map((row) => ({ c: row.map((value) => ({ v: value })) }))]
    }
  };
}
__name(fetchPendingVerificationDirect, "fetchPendingVerificationDirect");
async function timedFetch(name, url, maxBytes = MAX_SOURCE_BYTES, timeoutMs = 2e4) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "user-agent": "StyleKorean-Control-Tower/2026-08-12" }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { data: await readBoundedText(response, maxBytes), health: { name, ok: true, fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), latencyMs: Date.now() - started } };
  } catch (error) {
    return { data: null, health: { name, ok: false, fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) } };
  } finally {
    clearTimeout(timer);
  }
}
__name(timedFetch, "timedFetch");
async function fetchCsvSource(name, spreadsheetId, gid) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
  url.searchParams.set("format", "csv");
  url.searchParams.set("gid", String(gid));
  url.searchParams.set("_", String(Date.now()));
  const result = await timedFetch(name, url);
  if (!result.data) return { data: null, health: result.health };
  try {
    return { data: parseCsv(result.data), health: result.health };
  } catch (error) {
    return { data: null, health: { ...result.health, ok: false, error: String(error) } };
  }
}
__name(fetchCsvSource, "fetchCsvSource");
async function fetchGvizSource(name, spreadsheetId, options) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:json");
  if (options.gid !== void 0) url.searchParams.set("gid", String(options.gid));
  if (options.sheet) url.searchParams.set("sheet", options.sheet);
  if (options.range) url.searchParams.set("range", options.range);
  if (options.tq) url.searchParams.set("tq", options.tq);
  url.searchParams.set("headers", String(options.headers ?? 1));
  url.searchParams.set("_", String(Date.now()));
  const result = await timedFetch(name, url);
  if (!result.data) return { data: null, health: result.health };
  try {
    return { data: parseGviz(result.data), health: result.health };
  } catch (error) {
    return { data: null, health: { ...result.health, ok: false, error: String(error) } };
  }
}
__name(fetchGvizSource, "fetchGvizSource");
function rowsToGvizTable(rows) {
  if (!rows?.length) return null;
  return {
    cols: rows[0].map((label) => ({ label })),
    rows: rows.slice(1).map((row) => ({ c: row.map((value) => ({ v: value })) }))
  };
}
__name(rowsToGvizTable, "rowsToGvizTable");
async function fetchAppsScriptSnapshot(endpoint) {
  const url = new URL(endpoint);
  url.searchParams.set("action", "snapshot");
  url.searchParams.set("_", String(Date.now()));
  const result = await timedFetch("Apps Script Snapshot", url, MAX_GATEWAY_BYTES, 6e4);
  if (!result.data) return null;
  try {
    const payload = JSON.parse(result.data);
    return payload.ok && payload.sources ? { payload, health: result.health } : null;
  } catch {
    return null;
  }
}
__name(fetchAppsScriptSnapshot, "fetchAppsScriptSnapshot");
async function fetchOperationalSources(appsScriptUrl) {
  if (appsScriptUrl) {
    const gateway = await fetchAppsScriptSnapshot(appsScriptUrl);
    if (gateway) {
      const raw = gateway.payload.sources;
      const effectiveOutbound2 = selectOutboundSource(raw.outbound ?? null, raw.trucking ?? null);
      const healthFor = /* @__PURE__ */ __name((name, value) => ({
        name,
        ok: value !== null && value !== void 0,
        fetchedAt: gateway.payload.generatedAt || gateway.health.fetchedAt,
        latencyMs: gateway.health.latencyMs,
        error: value === null || value === void 0 ? `${name} is missing from the Apps Script snapshot` : void 0
      }), "healthFor");
      const outboundHealth2 = effectiveOutbound2.meta.fallback ? { ...healthFor("Outbound Shipping Schedule", raw.outbound), ok: false, error: effectiveOutbound2.meta.reason } : healthFor("Outbound Shipping Schedule", raw.outbound);
      const nationalTable = rowsToGvizTable(raw.nationalOutbound);
      const salesTable = rowsToGvizTable(raw.salesOutbound);
      const inventoryTable = rowsToGvizTable(raw.inventoryDashboardTable);
      const inboundTable = rowsToGvizTable(raw.skwInboundTable);
      const stockTable = rowsToGvizTable(raw.skwStockTable);
      const pendingFallback = raw.pendingVerification ? null : await fetchPendingVerificationDirect();
      const pendingTable = raw.pendingVerification ? rowsToGvizTable(raw.pendingVerification) : pendingFallback.data;
      return {
        sourceHealth: [
          healthFor("IMPORTS", raw.imports),
          outboundHealth2,
          healthFor("WH Trucking Request", raw.trucking),
          healthFor("TRANSFERS", raw.transfers),
          healthFor("Nationals", nationalTable),
          healthFor("WMS Stylekorean", salesTable),
          healthFor("Inventory", inventoryTable),
          healthFor("SKW Inbound", inboundTable),
          healthFor("SKW Stock", stockTable),
          pendingFallback ? pendingFallback.health : healthFor("Pending Verification", pendingTable)
        ],
        sources: {
          imports: raw.imports ? normalizeImportsParcelRows(raw.imports) : null,
          outbound: effectiveOutbound2.rows,
          outboundMeta: effectiveOutbound2.meta,
          nationalOutbound: nationalTable,
          salesOutbound: salesTable,
          inventoryDashboardTable: inventoryTable,
          skwInboundTable: inboundTable,
          skwStockTable: stockTable,
          // null (feed unavailable, shown as such by the card) when the pending
          // read failed — never an empty array, which would misreport "nothing
          // to review" and could be persisted to D1 over the last good feed.
          gmailIngestion: pendingTable ? deriveGmailIngestion({
            importsRows: raw.imports ?? null,
            outboundRows: effectiveOutbound2.rows,
            pendingVerificationTable: pendingTable
          }) : null
        },
        kpiRows: {
          nationalRows: raw.nationalOutbound ?? [],
          wmsRows: raw.salesOutbound ?? [],
          truckingRows: raw.trucking ?? [],
          transferRows: raw.transfers ?? []
        }
      };
    }
  }
  const [imports, outbound, trucking, transfers, nationalOutbound, salesOutbound, inventoryDashboardTable, skwInboundTable, skwStockTable, pendingVerification] = await Promise.all([
    fetchCsvSource("IMPORTS", LOGISTICS_MASTER_ID, IMPORTS_GID),
    fetchCsvSource("Outbound Shipping Schedule", LOGISTICS_MASTER_ID, OUTBOUND_GID),
    fetchCsvSource("WH Trucking Request", LOGISTICS_MASTER_ID, TRUCKING_GID),
    fetchCsvSource("TRANSFERS", LOGISTICS_MASTER_ID, TRANSFERS_GID),
    fetchGvizSource("Nationals", NATIONAL_SHEET_ID, { gid: NATIONAL_GID, range: "A1:U3500", headers: 1 }),
    fetchGvizSource("WMS Stylekorean", WMS_SHEET_ID, { gid: WMS_GID, range: "A2:AF4200", headers: 1 }),
    fetchGvizSource("Inventory", LOGISTICS_MASTER_ID, { sheet: "INVENTORY", range: "A1:O6500", headers: 1 }),
    fetchGvizSource("SKW Inbound", LOGISTICS_MASTER_ID, { sheet: "SKW_Inbound", range: "A1:R2500", headers: 1 }),
    fetchGvizSource("SKW Stock", LOGISTICS_MASTER_ID, { sheet: "SKW_Stock", range: "A1:J2500", headers: 1 }),
    fetchPendingVerificationDirect()
  ]);
  const effectiveOutbound = selectOutboundSource(outbound.data, trucking.data);
  const outboundHealth = effectiveOutbound.meta.fallback ? {
    ...outbound.health,
    ok: false,
    error: effectiveOutbound.meta.reason
  } : outbound.health;
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
      gmailIngestion: pendingVerification.data ? deriveGmailIngestion({
        importsRows: imports.data,
        outboundRows: effectiveOutbound.rows,
        pendingVerificationTable: pendingVerification.data
      }) : null
    },
    kpiRows: {
      nationalRows: gvizTableRows(nationalOutbound.data),
      wmsRows: gvizTableRows(salesOutbound.data),
      truckingRows: trucking.data ?? [],
      transferRows: transfers.data ?? []
    }
  };
}
__name(fetchOperationalSources, "fetchOperationalSources");
var AUTO_TAG = /\[auto:\s*(https:\/\/mail\.google\.com\/[^\]\s]+)\]/i;
function firstNonEmpty(...values) {
  return values.find((value) => value && value.trim())?.trim() ?? "";
}
__name(firstNonEmpty, "firstNonEmpty");
function committedEventsFromRows(rows, kind) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0].map((label) => String(label ?? "").trim().toUpperCase());
  const col = /* @__PURE__ */ __name((...names) => names.map((name) => header.indexOf(name)).find((index) => index !== -1) ?? -1, "col");
  const noteCol = col("NOTE", "NOTES", "REMARK", "REMARKS", "\uBE44\uACE0");
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
      invoiceCol !== -1 ? row[invoiceCol] : void 0,
      blCol !== -1 ? row[blCol] : void 0,
      containerCol !== -1 ? row[containerCol] : void 0
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
      timestamp: ""
    }];
  });
}
__name(committedEventsFromRows, "committedEventsFromRows");
function pendingEventsFromTable(table) {
  if (!table) return [];
  const rows = gvizTableRows(table);
  if (rows.length < 2) return [];
  const header = rows[0].map((label) => String(label ?? "").trim().toUpperCase());
  const idx = /* @__PURE__ */ __name((name) => header.indexOf(name.toUpperCase()), "idx");
  const statusMap = {
    "NEEDS REVIEW": "needsReview",
    APPROVED: "approved",
    REJECTED: "rejected",
    COMMITTED: "committed"
  };
  const cell = /* @__PURE__ */ __name((row, index) => index === -1 ? "" : String(row[index] ?? ""), "cell");
  return rows.slice(1).map((row) => {
    const rawStatus = cell(row, idx("Status")).trim().toUpperCase();
    const kind = cell(row, idx("Kind")).trim().toLowerCase();
    const customer = cell(row, idx("Customer"));
    const invoice = cell(row, idx("Invoice / PI"));
    const blOrPro = cell(row, idx("BL / PRO"));
    const container = cell(row, idx("Container"));
    const reviewKey = rawStatus === "NEEDS REVIEW" && (customer || invoice || blOrPro || container) ? [kind, customer, invoice, blOrPro, container].map((value) => value.trim().toUpperCase()).join("|") : void 0;
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
      reviewKey
    };
  });
}
__name(pendingEventsFromTable, "pendingEventsFromTable");
function deriveGmailIngestion(input) {
  const committed = [
    ...committedEventsFromRows(input.importsRows, "inbound"),
    ...committedEventsFromRows(input.outboundRows, "outbound")
  ];
  const pendingSorted = pendingEventsFromTable(input.pendingVerificationTable).map((event, index) => ({ event, sortKey: Date.parse(event.timestamp) || index })).sort((a, b) => b.sortKey - a.sortKey).map(({ event }) => event);
  const actionable = pendingSorted.filter((event) => event.status === "needsReview");
  const resolved = pendingSorted.filter((event) => event.status !== "needsReview");
  return [...actionable, ...resolved, ...committed].slice(0, 200);
}
__name(deriveGmailIngestion, "deriveGmailIngestion");

// lib/domain/status.ts
var aliases = /* @__PURE__ */ new Map([
  ["SCHEDULED", "Scheduled"],
  ["READY", "Scheduled"],
  ["ROUTED/BOOKED", "Scheduled"],
  ["PICKED UP", "Scheduled"],
  ["WORK IN PROGRESS", "Work in Progress"],
  ["WIP", "Work in Progress"],
  ["PENDING", "Pending"],
  ["SHIPPING", "Shipping"],
  ["IN TRANSIT", "Shipping"],
  ["SHIPPED", "Shipped"],
  ["DELIVERED", "Delivered"],
  ["RECEIVED", "Received"],
  ["CANCELLED", "Cancelled"],
  ["CANCELED", "Cancelled"],
  ["COMPLETED", "Completed"],
  ["CUSTOMS CLEARANCE", "Customs Clearance"],
  ["FDA HOLD", "FDA Review / Hold"],
  ["FDA REVIEW", "FDA Review / Hold"],
  ["FDA REVIEW/HOLD", "FDA Review / Hold"],
  ["FDA REVIEW / HOLD", "FDA Review / Hold"],
  ["FWS HOLD", "FWS Review / Hold"],
  ["FWS REVIEW", "FWS Review / Hold"],
  ["FWS REVIEW/HOLD", "FWS Review / Hold"],
  ["FWS REVIEW / HOLD", "FWS Review / Hold"],
  ["FDA DETAINED", "FDA Detained"],
  ["AQI EXAMINATION", "AQI Examination"],
  ["DELAYED", "Delayed"]
]);
function normalizeLogisticsStatus(value) {
  const key = String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return aliases.get(key) ?? "";
}
__name(normalizeLogisticsStatus, "normalizeLogisticsStatus");
var LOGISTICS_STATUS_OPTIONS = Array.from(new Set(aliases.values()));

// worker/status-command.ts
var MAX_COMMAND_BYTES = 16384;
var MAX_FIELD_LENGTH = 500;
var WRITE_TIMEOUT_MS = 2e4;
var EDITABLE_SHEETS = /* @__PURE__ */ new Map([
  ["inbound", /* @__PURE__ */ new Set(["IMPORTS"])],
  ["outbound", /* @__PURE__ */ new Set(["Outbound Shipping Schedule", "WH Trucking Request"])]
]);
function hasDatabase(env) {
  return "DB" in env;
}
__name(hasDatabase, "hasDatabase");
function json(value, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
__name(json, "json");
function hasOversizedField(command) {
  return Object.values(command).some((value) => typeof value === "string" && value.length > MAX_FIELD_LENGTH);
}
__name(hasOversizedField, "hasOversizedField");
async function handleStatusCommand(request, env, context) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ ok: false, error: "Cross-origin status writes are not allowed" }, 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return json({ ok: false, error: "Cross-site status writes are not allowed" }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ ok: false, error: "Content-Type must be application/json" }, 415);
  }
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const rateLimit = await env.STATUS_WRITE_RATE_LIMITER.limit({ key: `status-write:${clientIp}` });
  if (!rateLimit.success) {
    console.warn(JSON.stringify({ event: "status-write-rate-limited", clientIpPresent: clientIp !== "unknown" }));
    return Response.json(
      { ok: false, error: "Status write rate limit exceeded. Try again in one minute." },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } }
    );
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_COMMAND_BYTES) return json({ ok: false, error: "Command is too large" }, 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_COMMAND_BYTES) {
    return json({ ok: false, error: "Command is too large" }, 413);
  }
  const command = (() => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  })();
  if (!command || command.kind !== "inbound" && command.kind !== "outbound") {
    return json({ ok: false, error: "Invalid relation kind" }, 400);
  }
  if (!command.sourceSheet || !Number.isInteger(Number(command.sourceRow)) || Number(command.sourceRow) < 1) {
    return json({ ok: false, error: "A valid source sheet and row are required" }, 400);
  }
  if (!EDITABLE_SHEETS.get(command.kind)?.has(command.sourceSheet)) {
    return json({ ok: false, error: "That source sheet is not editable for this relation kind" }, 400);
  }
  if (hasOversizedField(command)) return json({ ok: false, error: "A command field is too large" }, 413);
  const status = normalizeLogisticsStatus(command.status);
  if (!status) return json({ ok: false, error: "Status is not allowed" }, 400);
  const correlationId = crypto.randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(env.APPS_SCRIPT_WRITE_URL, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...command, sourceRow: Number(command.sourceRow), status }),
      signal: controller.signal
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "status-write-upstream-failure", correlationId, error: String(error) }));
    return json({ ok: false, error: "Status source is unavailable", correlationId }, 502);
  } finally {
    clearTimeout(timer);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) {
    return json(
      { ok: false, error: result?.error || `Status source rejected the command (${response.status})`, correlationId },
      response.status >= 400 && response.status < 500 ? response.status : 502
    );
  }
  if (normalizeLogisticsStatus(result.status) !== status) {
    return json({ ok: false, error: "Persisted status did not match the command", correlationId }, 502);
  }
  console.log(JSON.stringify({
    event: "status-write-confirmed",
    correlationId,
    kind: command.kind,
    sourceSheet: command.sourceSheet,
    sourceRow: Number(command.sourceRow),
    previousStatus: command.currentStatus || null,
    status,
    auditedInD1: Boolean(hasDatabase(env) && context)
  }));
  if (hasDatabase(env) && context) {
    const entityId = command.shipmentNo || command.invoice || command.container || `${command.sourceSheet}:${command.sourceRow}`;
    context.waitUntil(recordConfirmedStatusWrite(env.DB, {
      correlationId,
      entityType: command.kind,
      entityId,
      previousStatus: command.currentStatus,
      status,
      sourceSheet: command.sourceSheet,
      sourceRow: Number(command.sourceRow)
    }).catch((error) => {
      console.error(JSON.stringify({ event: "status-write-audit-failure", correlationId, error: String(error) }));
    }));
  }
  return json({ ...result, status, correlationId });
}
__name(handleStatusCommand, "handleStatusCommand");

// worker/pending-review-command.ts
var MAX_COMMAND_BYTES2 = 4096;
var MAX_FIELD_LENGTH2 = 500;
var WRITE_TIMEOUT_MS2 = 2e4;
function hasDatabase2(env) {
  return "DB" in env;
}
__name(hasDatabase2, "hasDatabase");
function json2(value, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
__name(json2, "json");
function hasOversizedField2(command) {
  return Object.values(command).some((value) => typeof value === "string" && value.length > MAX_FIELD_LENGTH2);
}
__name(hasOversizedField2, "hasOversizedField");
async function handlePendingReviewCommand(request, env, context) {
  if (request.method !== "POST") return json2({ ok: false, error: "Method not allowed" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json2({ ok: false, error: "Cross-origin review writes are not allowed" }, 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return json2({ ok: false, error: "Cross-site review writes are not allowed" }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json2({ ok: false, error: "Content-Type must be application/json" }, 415);
  }
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const rateLimit = await env.STATUS_WRITE_RATE_LIMITER.limit({ key: `pending-review:${clientIp}` });
  if (!rateLimit.success) {
    console.warn(JSON.stringify({ event: "pending-review-rate-limited", clientIpPresent: clientIp !== "unknown" }));
    return Response.json(
      { ok: false, error: "Review rate limit exceeded. Try again in one minute." },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } }
    );
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_COMMAND_BYTES2) return json2({ ok: false, error: "Command is too large" }, 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_COMMAND_BYTES2) {
    return json2({ ok: false, error: "Command is too large" }, 413);
  }
  const command = (() => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  })();
  if (!command || !command.reviewKey || typeof command.reviewKey !== "string") {
    return json2({ ok: false, error: "A review key is required" }, 400);
  }
  if (command.decision !== "approve" && command.decision !== "reject") {
    return json2({ ok: false, error: "Decision must be approve or reject" }, 400);
  }
  if (hasOversizedField2(command)) return json2({ ok: false, error: "A command field is too large" }, 413);
  const correlationId = crypto.randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS2);
  let response;
  try {
    response = await fetch(env.APPS_SCRIPT_WRITE_URL, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "reviewPending", reviewKey: command.reviewKey, decision: command.decision }),
      signal: controller.signal
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "pending-review-upstream-failure", correlationId, error: String(error) }));
    return json2({ ok: false, error: "Review source is unavailable", correlationId }, 502);
  } finally {
    clearTimeout(timer);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) {
    return json2(
      { ok: false, error: result?.error || `Review source rejected the command (${response.status})`, correlationId },
      response.status >= 400 && response.status < 500 ? response.status : 502
    );
  }
  console.log(JSON.stringify({
    event: "pending-review-confirmed",
    correlationId,
    decision: command.decision,
    row: result.row,
    auditedInD1: Boolean(hasDatabase2(env) && context)
  }));
  if (hasDatabase2(env) && context) {
    context.waitUntil(recordPendingReviewDecision(env.DB, {
      correlationId,
      reviewKey: command.reviewKey,
      shipmentId: command.shipmentId,
      decision: command.decision,
      resultingStatus: result.status || ""
    }).catch((error) => {
      console.error(JSON.stringify({ event: "pending-review-audit-failure", correlationId, error: String(error) }));
    }));
  }
  return json2({ ...result, correlationId });
}
__name(handlePendingReviewCommand, "handlePendingReviewCommand");

// worker/index.ts
var WORKER_VERSION = "2026-08-13-worker-v8-public-guardrails";
var SNAPSHOT_CACHE_URL = "https://stylekorean.internal/api/logistics/snapshot";
var SNAPSHOT_CACHE_SECONDS = 60;
var SNAPSHOT_REFRESH_SECONDS = 15 * 60;
function hasDatabase3(env) {
  return "DB" in env;
}
__name(hasDatabase3, "hasDatabase");
function json3(value, status = 200, cacheControl = "no-store") {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json; charset=utf-8"
    }
  });
}
__name(json3, "json");
async function buildSnapshotPayload(env) {
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const snapshot = await fetchOperationalSources(env.APPS_SCRIPT_WRITE_URL);
  const outboundMeta = snapshot.sources.outboundMeta;
  const hasOutboundRows = Number(outboundMeta?.rowCount ?? 0) > 0;
  if (!snapshot.sources.imports || !hasOutboundRows) {
    throw new Error("Core Logistics Master sources are unavailable");
  }
  let kpis = null;
  let kpiError = "";
  try {
    kpis = computeKpisFromRows(snapshot.kpiRows);
  } catch (error) {
    kpiError = error instanceof Error ? error.message : String(error);
  }
  return {
    ok: true,
    generatedAt,
    version: WORKER_VERSION,
    sourceHealth: snapshot.sourceHealth,
    sources: snapshot.sources,
    kpis,
    kpiError: kpiError || void 0
  };
}
__name(buildSnapshotPayload, "buildSnapshotPayload");
async function refreshDatabaseSnapshot(env) {
  const startedAt = Date.now();
  const snapshot = await buildSnapshotPayload(env);
  const persisted = await persistSnapshot(env.DB, snapshot);
  console.log(JSON.stringify({
    event: "d1-snapshot-refreshed",
    generatedAt: snapshot.generatedAt,
    durationMs: Date.now() - startedAt,
    ...persisted
  }));
  return { ...snapshot, storage: "d1", storedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
__name(refreshDatabaseSnapshot, "refreshDatabaseSnapshot");
function snapshotResponse(payload) {
  return json3(payload, 200, `public, max-age=0, s-maxage=${SNAPSHOT_CACHE_SECONDS}`);
}
__name(snapshotResponse, "snapshotResponse");
function cacheSnapshot(context, response) {
  const cache = caches.default;
  const cachedResponse = response.clone();
  cachedResponse.headers.set("cache-control", `public, max-age=${SNAPSHOT_REFRESH_SECONDS}`);
  cachedResponse.headers.set("x-stylekorean-cached-at", String(Date.now()));
  context.waitUntil(cache.put(new Request(SNAPSHOT_CACHE_URL), cachedResponse));
}
__name(cacheSnapshot, "cacheSnapshot");
async function readFreshCache() {
  const cache = caches.default;
  const cached = await cache.match(new Request(SNAPSHOT_CACHE_URL));
  if (!cached) return null;
  const cachedAt = Number(cached.headers.get("x-stylekorean-cached-at") || 0);
  if (!cachedAt || Date.now() - cachedAt > SNAPSHOT_CACHE_SECONDS * 1e3) return { cached, fresh: false };
  const response = new Response(cached.body, cached);
  response.headers.set("cache-control", "public, max-age=0, must-revalidate");
  response.headers.set("x-stylekorean-cache", "HIT");
  return { cached: response, fresh: true };
}
__name(readFreshCache, "readFreshCache");
async function handleSnapshot(env, context) {
  const cacheState = await readFreshCache();
  if (cacheState?.fresh) return cacheState.cached;
  if (hasDatabase3(env)) {
    try {
      const stored = await readCurrentSnapshot(env.DB);
      if (stored) {
        const ageMs = Date.now() - Date.parse(stored.generatedAt);
        const stale = ageMs > SNAPSHOT_REFRESH_SECONDS * 1e3;
        if (stale) {
          context.waitUntil(refreshDatabaseSnapshot(env).catch((error) => {
            console.error(JSON.stringify({ event: "d1-background-refresh-failed", error: String(error) }));
          }));
        }
        const response = snapshotResponse({
          ...stored,
          stale: stale || void 0,
          staleReason: stale ? "The durable snapshot is refreshing in the background" : void 0,
          servedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
        if (!stale) cacheSnapshot(context, response);
        response.headers.set("x-stylekorean-cache", "D1");
        if (stale) response.headers.set("warning", '110 - "Response is stale"');
        return response;
      }
      const initialPayload = await buildSnapshotPayload(env);
      try {
        const persisted = await persistSnapshot(env.DB, initialPayload);
        console.log(JSON.stringify({
          event: "d1-snapshot-initialized",
          generatedAt: initialPayload.generatedAt,
          ...persisted
        }));
        const initial = snapshotResponse({
          ...initialPayload,
          storage: "d1",
          storedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
        cacheSnapshot(context, initial);
        initial.headers.set("x-stylekorean-cache", "D1-INITIALIZED");
        return initial;
      } catch (error) {
        console.error(JSON.stringify({ event: "d1-initialization-failed", error: String(error) }));
        const fallback = snapshotResponse({
          ...initialPayload,
          storage: "sheets",
          databaseInitializing: false,
          databaseError: "The durable snapshot could not be initialized"
        });
        fallback.headers.set("x-stylekorean-cache", "D1-INITIALIZATION-FAILED");
        return fallback;
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "d1-snapshot-read-failed", error: String(error) }));
    }
  }
  try {
    const live = snapshotResponse({ ...await buildSnapshotPayload(env), storage: "sheets" });
    cacheSnapshot(context, live);
    live.headers.set("x-stylekorean-cache", hasDatabase3(env) ? "D1-FALLBACK" : "MISS");
    return live;
  } catch (error) {
    const payload = cacheState?.cached ? await cacheState.cached.clone().json().catch(() => null) : null;
    if (payload?.ok === true) {
      const response = json3({
        ...payload,
        stale: true,
        staleReason: error instanceof Error ? error.message : "Live sources are temporarily unavailable",
        servedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      response.headers.set("warning", '110 - "Response is stale"');
      response.headers.set("x-stylekorean-cache", "STALE");
      return response;
    }
    return json3({ ok: false, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), error: "Core Logistics Master sources are unavailable" }, 503);
  }
}
__name(handleSnapshot, "handleSnapshot");
async function handleHealth(env) {
  let databaseState = "unbound";
  let databaseAgeSeconds;
  if (hasDatabase3(env)) {
    try {
      const health = await readDatabaseHealth(env.DB);
      databaseState = health.ready ? "ready" : "initializing";
      databaseAgeSeconds = health.ready ? health.ageSeconds : void 0;
    } catch (error) {
      databaseState = "unavailable";
      console.error(JSON.stringify({ event: "d1-health-summary-failed", error: String(error) }));
    }
  }
  return json3({
    ok: true,
    service: "stylekorean-logistics-control-tower",
    version: WORKER_VERSION,
    dataStore: databaseState === "ready" ? "Cloudflare D1 + Google Sheets fallback" : databaseState === "unbound" ? "Google Sheets" : `Google Sheets fallback (D1 ${databaseState})`,
    databaseConfigured: hasDatabase3(env),
    accessPolicy: "public",
    databaseReady: databaseState === "ready",
    databaseState,
    databaseAgeSeconds,
    statusWriteConfigured: Boolean(env.APPS_SCRIPT_WRITE_URL),
    statusWriteMode: "Apps Script source-confirmed proxy",
    statusWriteAuthentication: "none",
    statusWriteRateLimit: "30 requests per 60 seconds per client IP and Cloudflare location",
    checkedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
}
__name(handleHealth, "handleHealth");
async function handleReconciliation(env) {
  if (!hasDatabase3(env)) {
    return json3({ ok: true, databaseConfigured: false, ready: false, activationRequired: true });
  }
  try {
    return json3({ ok: true, databaseConfigured: true, ...await readDatabaseHealth(env.DB) });
  } catch (error) {
    console.error(JSON.stringify({ event: "d1-health-read-failed", error: String(error) }));
    return json3({ ok: false, databaseConfigured: true, ready: false, error: "Database health is unavailable" }, 503);
  }
}
__name(handleReconciliation, "handleReconciliation");
function withSecurityHeaders(response) {
  const secured = new Response(response.body, response);
  secured.headers.set("content-security-policy", "base-uri 'self'; frame-ancestors 'none'; object-src 'none'");
  secured.headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  secured.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  secured.headers.set("strict-transport-security", "max-age=31536000");
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("x-frame-options", "DENY");
  return secured;
}
__name(withSecurityHeaders, "withSecurityHeaders");
var index_default = {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    let response;
    if (url.pathname === "/api/logistics/snapshot") {
      response = request.method === "GET" ? await handleSnapshot(env, context) : json3({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname === "/api/logistics/reconciliation") {
      response = request.method === "GET" ? await handleReconciliation(env) : json3({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname === "/api/logistics/status") {
      response = await handleStatusCommand(request, env, context);
    } else if (url.pathname === "/api/logistics/pending-review") {
      response = await handlePendingReviewCommand(request, env, context);
    } else if (url.pathname === "/api/logistics/health") {
      response = request.method === "GET" ? await handleHealth(env) : json3({ ok: false, error: "Method not allowed" }, 405);
    } else if (url.pathname.startsWith("/api/")) {
      response = json3({ ok: false, error: "API route not found" }, 404);
    } else {
      response = await env.ASSETS.fetch(request);
    }
    return withSecurityHeaders(response);
  },
  async scheduled(_controller, env, context) {
    if (!hasDatabase3(env)) {
      console.log(JSON.stringify({ event: "d1-scheduled-refresh-skipped", reason: "binding-not-configured" }));
      return;
    }
    context.waitUntil(refreshDatabaseSnapshot(env).catch((error) => {
      console.error(JSON.stringify({ event: "d1-scheduled-refresh-failed", error: String(error) }));
      throw error;
    }));
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
