/**
 * FulfillmentRouting.gs
 *
 * Canonical Fulfillment -> Logistics Master synchronization.
 * - Method TK -> WH Trucking Request
 * - FedEx / UPS / USPS / Amazon / DHL -> IMPORTS / PARCELS section
 * - Stable source tokens make repeated 15-minute runs idempotent.
 * - The same Fulfillment source record is never inserted into both destinations.
 * - Finished source jobs update an existing linked row but do not create historical
 *   clutter when the source was never previously synchronized.
 */

var FULFILLMENT_ROUTING = {
  sourceUrl: "https://script.google.com/macros/s/AKfycbykK9DWjem9ORHxfR_mpdZl5DVh-en0D6JpCdIuel305QmfqxoNU_NqSnjkhFk401hI/exec",
  sourceWebUrl: "https://sk-b2b-mobile.github.io/fulfillment/sales.html",
  parcelCarriers: ["FEDEX", "UPS", "USPS", "AMAZON", "DHL"],
  maxDetailsPerRun: 30,
  cursorProperty: "FULFILLMENT_LOGISTICS_CURSOR_V1"
};

function syncFulfillmentLogistics() {
  var lock = LockService.getScriptLock();
  var haveLock = false;
  var started = Date.now();
  var summary = { checked: 0, inserted: 0, updated: 0, noop: 0, skipped: 0, conflicts: 0, errors: 0 };
  try {
    haveLock = lock.tryLock(5000);
    if (!haveLock) {
      fulfillmentLog_("FULFILLMENT ROUTING LOCK SKIP", "busy", JSON.stringify(summary));
      return { ok: false, skipped: "lock", summary: summary };
    }

    var overview = fulfillmentFetchJson_({ op: "getSalesOverview" });
    var jobs = Array.isArray(overview.jobs) ? overview.jobs : [];
    if (!jobs.length) throw new Error("Fulfillment overview returned no jobs.");

    var candidates = jobs.filter(function (job) {
      var method = normalizeFulfillmentMethod_(job && job.method);
      return Boolean(method === "TK" || fulfillmentParcelCarrier_(method));
    });
    candidates.sort(function (a, b) {
      return fulfillmentDateSort_(b && b.shipDate) - fulfillmentDateSort_(a && a.shipDate);
    });

    var props = PropertiesService.getScriptProperties();
    var cursor = Math.max(0, Number(props.getProperty(FULFILLMENT_ROUTING.cursorProperty) || 0));
    if (cursor >= candidates.length) cursor = 0;
    var batch = [];
    if (candidates.length) {
      for (var n = 0; n < Math.min(FULFILLMENT_ROUTING.maxDetailsPerRun, candidates.length); n++) {
        batch.push(candidates[(cursor + n) % candidates.length]);
      }
      props.setProperty(FULFILLMENT_ROUTING.cursorProperty, String((cursor + batch.length) % candidates.length));
    }

    var master = SpreadsheetApp.openById(SPREADSHEET_ID);
    var trucking = master.getSheetByName("WH Trucking Request");
    var imports = master.getSheetByName("IMPORTS");
    if (!trucking || !imports) throw new Error("Canonical trucking/import destination sheet is unavailable.");
    var parcelsMarker = fulfillmentSectionMarkerRow_(imports, "PARCELS");
    if (!parcelsMarker) throw new Error("IMPORTS PARCELS section marker is missing.");

    batch.forEach(function (job) {
      summary.checked++;
      try {
        var invoice = String(job && job.invoice || "").trim();
        if (!invoice) { summary.skipped++; return; }
        var detail = fulfillmentFetchJson_({ op: "getSalesInvoiceDetail", invoice: invoice });
        var record = buildFulfillmentLogisticsRecord_(job || {}, detail || {});
        var method = normalizeFulfillmentMethod_(record.method);
        var parcelCarrier = fulfillmentParcelCarrier_(method);
        var stableId = fulfillmentStableId_(job || {}, detail || {}, record);
        var token = "[FULFILLMENT:" + stableId + "]";
        var finished = fulfillmentFinishedStatus_(record.status);

        var whExisting = findFulfillmentTokenRow_(trucking, token, 1);
        var parcelExisting = findFulfillmentTokenRow_(imports, token, parcelsMarker + 1);

        var result;
        if (method === "TK") {
          if (parcelExisting && !whExisting) {
            summary.conflicts++;
            fulfillmentLog_("FULFILLMENT ROUTING CONFLICT", invoice, JSON.stringify({ token: token, intended: "WH Trucking Request", existing: "IMPORTS/PARCELS", row: parcelExisting }));
            return;
          }
          result = upsertFulfillmentTrucking_(trucking, record, token, whExisting, !finished);
        } else if (parcelCarrier) {
          if (whExisting && !parcelExisting) {
            summary.conflicts++;
            fulfillmentLog_("FULFILLMENT ROUTING CONFLICT", invoice, JSON.stringify({ token: token, intended: "IMPORTS/PARCELS", existing: "WH Trucking Request", row: whExisting }));
            return;
          }
          record.carrier = parcelCarrier;
          result = upsertFulfillmentParcel_(imports, parcelsMarker, record, token, parcelExisting, !finished);
        } else {
          summary.skipped++;
          return;
        }

        if (result.action === "inserted") summary.inserted++;
        else if (result.action === "updated") summary.updated++;
        else if (result.action === "noop") summary.noop++;
        else summary.skipped++;
      } catch (rowError) {
        summary.errors++;
        fulfillmentLog_("FULFILLMENT ROUTING ERROR", String(job && job.invoice || "unknown"), String(rowError && rowError.message || rowError));
      }
    });

    SpreadsheetApp.flush();
    fulfillmentLog_("FULFILLMENT ROUTING RUN", "ok", JSON.stringify({ summary: summary, candidates: candidates.length, batch: batch.length, elapsedMs: Date.now() - started }));
    return { ok: true, summary: summary, candidates: candidates.length, batch: batch.length };
  } catch (error) {
    summary.errors++;
    fulfillmentLog_("FULFILLMENT ROUTING RUN", "error", JSON.stringify({ error: String(error && error.message || error), summary: summary, elapsedMs: Date.now() - started }));
    return { ok: false, error: String(error && error.message || error), summary: summary };
  } finally {
    if (haveLock) lock.releaseLock();
  }
}

function fulfillmentFetchJson_(params) {
  var url = FULFILLMENT_ROUTING.sourceUrl + "?" + Object.keys(params || {}).map(function (key) {
    return encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key] == null ? "" : params[key]));
  }).concat(["t=" + Date.now()]).join("&");
  var response = UrlFetchApp.fetch(url, {
    method: "get",
    followRedirects: true,
    muteHttpExceptions: true,
    headers: { Accept: "application/json" }
  });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) throw new Error("Fulfillment source HTTP " + status);
  var payload = JSON.parse(response.getContentText() || "{}");
  if (payload.ok !== true) throw new Error(String(payload.error || "Fulfillment source rejected request."));
  return payload;
}

function normalizeFulfillmentMethod_(value) {
  var text = String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (text === "TK" || /^TK\b/.test(text)) return "TK";
  for (var i = 0; i < FULFILLMENT_ROUTING.parcelCarriers.length; i++) {
    if (text.indexOf(FULFILLMENT_ROUTING.parcelCarriers[i]) !== -1) return FULFILLMENT_ROUTING.parcelCarriers[i];
  }
  return text;
}

function fulfillmentParcelCarrier_(method) {
  var normalized = normalizeFulfillmentMethod_(method);
  return FULFILLMENT_ROUTING.parcelCarriers.indexOf(normalized) !== -1 ? normalized : "";
}

function fulfillmentDeepValue_(value, wanted, depth) {
  if (!value || depth > 3) return "";
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var nestedArray = fulfillmentDeepValue_(value[i], wanted, depth + 1);
      if (nestedArray !== "") return nestedArray;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  var keys = Object.keys(value);
  for (var k = 0; k < keys.length; k++) {
    if (wanted.indexOf(String(keys[k]).toLowerCase()) !== -1) {
      var direct = value[keys[k]];
      if (direct !== null && direct !== undefined && direct !== "") return direct;
    }
  }
  for (var j = 0; j < keys.length; j++) {
    var nested = fulfillmentDeepValue_(value[keys[j]], wanted, depth + 1);
    if (nested !== "") return nested;
  }
  return "";
}

function fulfillmentFirstValue_(objects, keys) {
  var wanted = keys.map(function (key) { return String(key).toLowerCase(); });
  for (var i = 0; i < objects.length; i++) {
    var value = fulfillmentDeepValue_(objects[i], wanted, 0);
    if (value !== "") return value;
  }
  return "";
}

function normalizeFulfillmentDestination_(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeFulfillmentDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return Utilities.formatDate(value, Session.getScriptTimeZone(), "MM/dd/yy");
  var text = String(value || "").trim();
  if (!text) return "";
  var match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (match) {
    var year = Number(match[3]);
    if (year < 100) year += 2000;
    return Utilities.formatDate(new Date(year, Number(match[1]) - 1, Number(match[2])), Session.getScriptTimeZone(), "MM/dd/yy");
  }
  var date = new Date(text);
  return isNaN(date.getTime()) ? "" : Utilities.formatDate(date, Session.getScriptTimeZone(), "MM/dd/yy");
}

function fulfillmentDateSort_(value) {
  var normalized = normalizeFulfillmentDate_(value);
  var date = normalized ? new Date(normalized) : new Date(0);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}

function fulfillmentNumber_(value) {
  if (typeof value === "number") return isFinite(value) ? value : 0;
  var cleaned = String(value || "").replace(/[^0-9.-]/g, "");
  var n = Number(cleaned);
  return isFinite(n) ? n : 0;
}

function totalFulfillmentQuantity_(detail) {
  var items = Array.isArray(detail && detail.items) ? detail.items : [];
  var total = items.reduce(function (sum, item) { return sum + Math.max(0, fulfillmentNumber_(item && (item.qty != null ? item.qty : item.quantity))); }, 0);
  if (total) return total;
  return Math.max(0, fulfillmentNumber_(fulfillmentFirstValue_([detail], ["totalQty", "totalQuantity", "quantity", "qty"])));
}

function fulfillmentDimensionsArray_(detail) {
  var dims = detail && (detail.dimensions || detail.dims || detail.pallets || detail.packages);
  if (!Array.isArray(dims)) return [];
  return dims.map(function (dim) {
    return {
      l: fulfillmentNumber_(dim && (dim.l != null ? dim.l : dim.length)),
      w: fulfillmentNumber_(dim && (dim.w != null ? dim.w : dim.width)),
      h: fulfillmentNumber_(dim && (dim.h != null ? dim.h : dim.height)),
      wt: fulfillmentNumber_(dim && (dim.wt != null ? dim.wt : (dim.weight != null ? dim.weight : dim.weightLbs)))
    };
  }).filter(function (dim) { return dim.l || dim.w || dim.h || dim.wt; });
}

function formatFulfillmentDimensions_(dimensions) {
  return (dimensions || []).map(function (dim, index) {
    var size = [dim.l || "?", dim.w || "?", dim.h || "?"].join("x");
    return (index + 1) + ":" + size + (dim.wt ? "@" + dim.wt + "lb" : "");
  }).join("; ");
}

function fulfillmentDimensionSummary_(dimensions) {
  var result = { length: 0, width: 0, height: 0, weight: 0, volume: 0 };
  (dimensions || []).forEach(function (dim) {
    result.length = Math.max(result.length, dim.l || 0);
    result.width = Math.max(result.width, dim.w || 0);
    result.height = Math.max(result.height, dim.h || 0);
    result.weight += dim.wt || 0;
    if (dim.l && dim.w && dim.h) result.volume += dim.l * dim.w * dim.h;
  });
  return result;
}

function fulfillmentLocationHint_(job, detail, customer) {
  var raw = fulfillmentFirstValue_([detail, job], ["locationHint", "location", "store", "storeName", "destination", "shipToName", "department"]);
  if (!raw) {
    var match = String(customer || "").match(/\(([^)]+)\)\s*$/);
    if (match) raw = match[1];
  }
  return String(raw || "").trim();
}

function buildFulfillmentLogisticsRecord_(job, detail) {
  var invoice = String(fulfillmentFirstValue_([detail, job], ["invoice", "invoiceNo", "invoiceNumber"]) || job.invoice || "").trim();
  var customer = String(fulfillmentFirstValue_([detail, job], ["customer", "customerName", "client", "account", "department"]) || job.remarks || "").trim();
  var deliveryAddress = String(fulfillmentFirstValue_([detail, job], ["deliveryAddress", "shipToAddress", "shippingAddress", "address", "destinationAddress"]) || "").trim();
  var shipDate = normalizeFulfillmentDate_(fulfillmentFirstValue_([detail, job], ["shipDate", "shipOutDate", "shippingDate", "date"]));
  var amount = fulfillmentNumber_(fulfillmentFirstValue_([detail, job], ["amount", "invoiceAmount", "orderAmount", "totalAmount"]));
  var trackingNumber = String(fulfillmentFirstValue_([detail, job], ["trackingNumber", "tracking", "trackingNo", "shipmentNo", "pro", "proNumber"]) || "").trim();
  var dimensions = fulfillmentDimensionsArray_(detail);
  var summary = fulfillmentDimensionSummary_(dimensions);
  var weight = summary.weight || fulfillmentNumber_(fulfillmentFirstValue_([detail, job], ["weight", "weightLbs", "totalWeight"]));
  var quantity = totalFulfillmentQuantity_(detail);
  var status = String(fulfillmentFirstValue_([detail, job], ["status", "shippingStatus", "shipmentStatus"]) || job.status || "").trim();
  var method = normalizeFulfillmentMethod_(fulfillmentFirstValue_([detail, job], ["method", "shippingMethod", "deliveryMethod"]) || job.method);
  var locationHint = fulfillmentLocationHint_(job, detail, customer);
  var sourceRef = String(fulfillmentFirstValue_([detail, job], ["sourceRef", "sourceRow", "rowId", "jobId", "orderId", "id"]) || "").trim();
  var freightClass = String(fulfillmentFirstValue_([detail, job], ["freightClass", "class"]) || "").trim();
  var subclass = String(fulfillmentFirstValue_([detail, job], ["subclass", "subClass"]) || "").trim();
  return {
    customer: customer,
    deliveryAddress: deliveryAddress,
    invoice: invoice,
    shipDate: shipDate,
    amount: amount,
    trackingNumber: trackingNumber,
    dimensions: dimensions,
    weight: weight,
    quantity: quantity,
    status: status,
    method: method,
    locationHint: locationHint,
    sourceRef: sourceRef,
    freightClass: freightClass,
    subclass: subclass,
    length: summary.length,
    width: summary.width,
    height: summary.height,
    volume: summary.volume
  };
}

function fulfillmentHash_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text || ""), Utilities.Charset.UTF_8);
  return bytes.map(function (value) { var v = value < 0 ? value + 256 : value; return ("0" + v.toString(16)).slice(-2); }).join("").slice(0, 24).toUpperCase();
}

function fulfillmentStableId_(job, detail, record) {
  var immutable = String(record.sourceRef || fulfillmentFirstValue_([detail, job], ["sourceId", "sourceRow", "rowId", "jobId", "orderId", "id"]) || "").trim();
  if (immutable) return fulfillmentHash_("SOURCE|" + immutable);
  var fallback = [
    record.invoice,
    normalizeFulfillmentDestination_(record.customer),
    normalizeFulfillmentDestination_(record.locationHint)
  ].join("|");
  if (!record.invoice) throw new Error("Fulfillment source record has no stable invoice/source identifier.");
  return fulfillmentHash_("FALLBACK|" + fallback);
}

function fulfillmentFinishedStatus_(value) {
  var status = String(value || "").trim().toUpperCase();
  return ["COMPLETED", "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "CANCELED"].indexOf(status) !== -1;
}

function fulfillmentCanonicalStatus_(value) {
  var text = String(value || "").trim();
  if (typeof canonicalLogisticsStatus_ === "function") {
    var canonical = canonicalLogisticsStatus_(text);
    if (canonical) return canonical;
  }
  var upper = text.toUpperCase();
  if (!upper) return "WORK IN PROGRESS";
  if (upper.indexOf("DELIVER") !== -1) return "DELIVERED";
  if (upper.indexOf("SHIP") !== -1 || upper.indexOf("PICKED UP") !== -1) return "SHIPPING";
  if (upper.indexOf("CANCEL") !== -1) return "CANCELLED";
  if (upper.indexOf("COMPLETE") !== -1) return "COMPLETED";
  if (upper.indexOf("PENDING") !== -1) return "PENDING";
  return "WORK IN PROGRESS";
}

function fulfillmentStatusRank_(value) {
  var normalized = fulfillmentCanonicalStatus_(value).toUpperCase();
  var ranks = { "": 0, "SCHEDULED": 1, "WORK IN PROGRESS": 2, "PENDING": 2, "SHIPPING": 3, "SHIPPED": 4, "DELIVERED": 5, "RECEIVED": 6, "COMPLETED": 7, "CANCELLED": 8 };
  return ranks[normalized] == null ? 2 : ranks[normalized];
}

function fulfillmentNextStatus_(current, source) {
  var sourceStatus = fulfillmentCanonicalStatus_(source);
  var currentStatus = String(current || "").trim();
  if (!currentStatus) return sourceStatus;
  if (fulfillmentStatusRank_(sourceStatus) >= fulfillmentStatusRank_(currentStatus)) return sourceStatus;
  return currentStatus;
}

function fulfillmentManagedNote_(prior, token, record) {
  var details = [];
  if (record.quantity) details.push("QTY=" + record.quantity);
  if (record.dimensions.length) details.push("DIMS=" + formatFulfillmentDimensions_(record.dimensions));
  if (record.trackingNumber) details.push("TRACKING=" + record.trackingNumber);
  details.push("METHOD=" + record.method);
  details.push("SOURCE=" + FULFILLMENT_ROUTING.sourceWebUrl);
  var managed = token + " " + details.join(" | ");
  var lines = String(prior || "").split(/\r?\n/).filter(function (line) { return line && line.indexOf(token) === -1; });
  lines.push(managed);
  return lines.join("\n");
}

function findFulfillmentTokenRow_(sheet, token, minRow) {
  var matches = sheet.createTextFinder(token).matchCase(true).matchEntireCell(false).findAll();
  var start = Math.max(1, Number(minRow) || 1);
  for (var i = 0; i < matches.length; i++) if (matches[i].getRow() >= start) return matches[i].getRow();
  return 0;
}

function fulfillmentFindTrackingRow_(sheet, trackingNumber, startRow) {
  var wanted = String(trackingNumber || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!wanted) return 0;
  var lastRow = sheet.getLastRow();
  if (lastRow < startRow) return 0;
  var values = sheet.getRange(startRow, 2, lastRow - startRow + 1, 1).getDisplayValues();
  for (var r = 0; r < values.length; r++) {
    var current = String(values[r][0] || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (current && current === wanted) return startRow + r;
  }
  return 0;
}

function fulfillmentWhHeader_(sheet) {
  var rows = sheet.getRange(1, 1, Math.min(8, sheet.getLastRow()), sheet.getLastColumn()).getDisplayValues();
  for (var r = 0; r < rows.length; r++) {
    var map = {};
    rows[r].forEach(function (cell, index) { var key = String(cell || "").trim().toUpperCase(); if (key && map[key] === undefined) map[key] = index; });
    if (map["CUSTOMER"] !== undefined && map["INVOICE NO."] !== undefined && map["SHIP DATE"] !== undefined) return { rowIndex: r, map: map };
  }
  throw new Error("WH Trucking Request header not found.");
}

function fulfillmentSetArray_(row, map, name, value) {
  var index = map[String(name).toUpperCase()];
  if (index === undefined || value === null || value === undefined || value === "") return;
  row[index] = value;
}

function fulfillmentSetCell_(sheet, rowNumber, map, name, value) {
  var index = map[String(name).toUpperCase()];
  if (index === undefined || value === null || value === undefined || value === "") return false;
  var cell = sheet.getRange(rowNumber, index + 1);
  if (String(cell.getDisplayValue() || "").trim() === String(value).trim()) return false;
  cell.setValue(value);
  return true;
}

function upsertFulfillmentTrucking_(sheet, record, token, existingRow, allowInsert) {
  var header = fulfillmentWhHeader_(sheet);
  var map = header.map;
  existingRow = Number(existingRow) || 0;
  if (!record.customer || !record.invoice || !record.shipDate) return { action: "skipped", reason: "missing customer/invoice/ship date" };

  var cft = record.volume ? record.volume / 1728 : 0;
  var pcf = cft && record.weight ? record.weight / cft : 0;
  var dimWeight = record.volume ? record.volume / 166 : 0;

  if (existingRow) {
    var changed = false;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "CUSTOMER", record.customer) || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "INVOICE NO.", record.invoice) || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "ADDRESS", record.deliveryAddress) || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "SHIP DATE", record.shipDate) || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "VALUE", record.amount || "") || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "LENGTH (IN)", record.length || "") || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "WIDTH (IN)", record.width || "") || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "HEIGHT (IN)", record.height || "") || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "WEIGHT (LBS)", record.weight || "") || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "VOLUME (INCHES)", record.volume || "") || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "CFT", cft || "") || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "PCF", pcf || "") || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "DIMENSIONAL WEIGHT", dimWeight || "") || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "FREIGHT CLASS", record.freightClass || "") || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "SUB CLASS", record.subclass || "") || changed;
    changed = fulfillmentSetCell_(sheet, existingRow, map, "LOCATION / STORE", record.locationHint || "") || changed;
    if (map["NOTE"] !== undefined) {
      var noteCell = sheet.getRange(existingRow, map["NOTE"] + 1);
      var nextNote = fulfillmentManagedNote_(noteCell.getDisplayValue(), token, record);
      if (nextNote !== noteCell.getDisplayValue()) { noteCell.setValue(nextNote); changed = true; }
    }
    if (map["STATUS"] !== undefined) {
      var statusCell = sheet.getRange(existingRow, map["STATUS"] + 1);
      var nextStatus = fulfillmentNextStatus_(statusCell.getDisplayValue(), record.status);
      if (nextStatus && nextStatus !== statusCell.getDisplayValue()) { statusCell.setValue(nextStatus); changed = true; }
    }
    return { action: changed ? "updated" : "noop", row: existingRow };
  }

  if (!allowInsert) return { action: "skipped", reason: "finished source not previously linked" };
  var row = new Array(Math.max(sheet.getLastColumn(), 44)).fill("");
  fulfillmentSetArray_(row, map, "CUSTOMER", record.customer);
  fulfillmentSetArray_(row, map, "INVOICE NO.", record.invoice);
  fulfillmentSetArray_(row, map, "ADDRESS", record.deliveryAddress);
  fulfillmentSetArray_(row, map, "SHIP DATE", record.shipDate);
  fulfillmentSetArray_(row, map, "VALUE", record.amount || "");
  fulfillmentSetArray_(row, map, "LENGTH (IN)", record.length || "");
  fulfillmentSetArray_(row, map, "WIDTH (IN)", record.width || "");
  fulfillmentSetArray_(row, map, "HEIGHT (IN)", record.height || "");
  fulfillmentSetArray_(row, map, "WEIGHT (LBS)", record.weight || "");
  fulfillmentSetArray_(row, map, "VOLUME (INCHES)", record.volume || "");
  fulfillmentSetArray_(row, map, "CFT", cft || "");
  fulfillmentSetArray_(row, map, "PCF", pcf || "");
  fulfillmentSetArray_(row, map, "DIMENSIONAL WEIGHT", dimWeight || "");
  fulfillmentSetArray_(row, map, "FREIGHT CLASS", record.freightClass || "");
  fulfillmentSetArray_(row, map, "SUB CLASS", record.subclass || "");
  fulfillmentSetArray_(row, map, "NOTE", fulfillmentManagedNote_("", token, record));
  fulfillmentSetArray_(row, map, "STATUS", fulfillmentCanonicalStatus_(record.status));
  fulfillmentSetArray_(row, map, "LOCATION / STORE", record.locationHint || "");
  sheet.appendRow(row);
  return { action: "inserted", row: sheet.getLastRow() };
}

function fulfillmentSectionMarkerRow_(sheet, marker) {
  var wanted = String(marker || "").trim().toUpperCase();
  var values = sheet.getRange(1, 1, sheet.getLastRow(), 1).getDisplayValues();
  for (var r = 0; r < values.length; r++) if (String(values[r][0] || "").trim().toUpperCase() === wanted) return r + 1;
  return 0;
}

function upsertFulfillmentParcel_(sheet, parcelsMarker, record, token, existingRow, allowInsert) {
  existingRow = Number(existingRow) || fulfillmentFindTrackingRow_(sheet, record.trackingNumber, parcelsMarker + 1);
  if (!record.trackingNumber || !record.invoice) return { action: "skipped", reason: "missing parcel tracking/invoice" };
  var status = fulfillmentCanonicalStatus_(record.status);
  var note = fulfillmentManagedNote_(existingRow ? sheet.getRange(existingRow, 12).getDisplayValue() : "", token, record);

  if (existingRow) {
    var values = [record.carrier, record.trackingNumber, record.invoice, record.customer, record.shipDate];
    var changed = false;
    for (var c = 0; c < values.length; c++) {
      if (!values[c]) continue;
      var cell = sheet.getRange(existingRow, c + 1);
      if (String(cell.getDisplayValue() || "").trim() !== String(values[c]).trim()) { cell.setValue(values[c]); changed = true; }
    }
    var trackCell = sheet.getRange(existingRow, 11);
    var trackText = "TRACK# " + record.trackingNumber;
    if (trackCell.getDisplayValue() !== trackText) { trackCell.setValue(trackText); changed = true; }
    var noteCell = sheet.getRange(existingRow, 12);
    if (noteCell.getDisplayValue() !== note) { noteCell.setValue(note); changed = true; }
    var statusCell = sheet.getRange(existingRow, 28); // AB = WEBSITE STATUS in IMPORTS.
    var nextStatus = fulfillmentNextStatus_(statusCell.getDisplayValue(), status);
    if (nextStatus && statusCell.getDisplayValue() !== nextStatus) { statusCell.setValue(nextStatus); changed = true; }
    return { action: changed ? "updated" : "noop", row: existingRow };
  }

  if (!allowInsert) return { action: "skipped", reason: "finished parcel not previously linked" };
  var row = new Array(Math.max(sheet.getLastColumn(), 30)).fill("");
  row[0] = record.carrier;
  row[1] = record.trackingNumber;
  row[2] = record.invoice;
  row[3] = record.customer;
  row[4] = record.shipDate;
  row[10] = "TRACK# " + record.trackingNumber;
  row[11] = fulfillmentManagedNote_("", token, record);
  row[27] = status;
  sheet.appendRow(row);
  var insertedRow = sheet.getLastRow();
  if (insertedRow <= parcelsMarker) throw new Error("Parcel insert escaped the PARCELS section.");
  return { action: "inserted", row: insertedRow };
}

function fulfillmentLog_(event, key, detail) {
  try {
    if (typeof logPipeline_ === "function") logPipeline_(event, key, detail);
    else Logger.log(event + " | " + key + " | " + detail);
  } catch (error) {
    Logger.log(event + " logging failed: " + String(error && error.message || error));
  }
}
