/**
 * GmailPipelineV2.gs — resilient email -> LOGISTICS MASTER 2026 ingestion.
 *
 * Design goals:
 *  - process messages, not whole threads, so later replies/status changes are not hidden
 *    by a thread-level processed label;
 *  - parse shipment metadata from subject/body as well as attachments;
 *  - support ZIP bundles and use Drive REST conversion as the XLSX/PDF fallback;
 *  - update an existing source row by strong identifiers before applying append validation;
 *  - insert new inbound rows immediately above the literal SCHEDULING marker;
 *  - never silently mark an unsupported/empty extraction as processed.
 */

/* eslint-disable no-unused-vars */

var GMAIL_PIPELINE_V2_VERSION = "2026-08-10-v1";
var GMAIL_V2_LOOKBACK_DAYS = 4;
var GMAIL_V2_MAX_THREADS = 12;
var GMAIL_V2_RUNTIME_BUDGET_MS = 210000;
var GMAIL_V2_SEEN_PREFIX = "GMAIL_V2_SEEN_";

function processLogisticsEmailsV2() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: "locked" };
  var runStarted = Date.now();
  try {
    ensureGmailV2Trigger_();
    var labels = gmailV2Labels_();
    var queries = gmailV2Queries_();
    var threadsById = {};
    queries.forEach(function (query) {
      GmailApp.search(query, 0, GMAIL_V2_MAX_THREADS).forEach(function (thread) {
        threadsById[thread.getId()] = thread;
      });
    });

    var stats = {
      threads: 0, messages: 0, inserted: 0, updated: 0, noop: 0,
      pending: 0, errors: 0, deferredThreads: 0, budgetHit: false
    };
    var threadIds = Object.keys(threadsById).slice(0, GMAIL_V2_MAX_THREADS);
    for (var ti = 0; ti < threadIds.length; ti++) {
      if (Date.now() - runStarted >= GMAIL_V2_RUNTIME_BUDGET_MS) {
        stats.budgetHit = true;
        stats.deferredThreads += threadIds.length - ti;
        break;
      }
      var thread = threadsById[threadIds[ti]];
      stats.threads++;
      var threadPending = false;
      var threadError = false;
      var threadFinished = true;
      var messages = thread.getMessages();
      for (var mi = 0; mi < messages.length; mi++) {
        if (Date.now() - runStarted >= GMAIL_V2_RUNTIME_BUDGET_MS) {
          stats.budgetHit = true;
          stats.deferredThreads += 1 + Math.max(0, threadIds.length - ti - 1);
          threadFinished = false;
          break;
        }
        var message = messages[mi];
        if (gmailV2Seen_(message.getId())) continue;
        if (Date.now() - message.getDate().getTime() > GMAIL_V2_LOOKBACK_DAYS * 86400000) continue;
        stats.messages++;
        try {
          var result = processLogisticsMessageV2_(message);
          stats.inserted += result.inserted;
          stats.updated += result.updated;
          stats.noop += result.noop;
          stats.pending += result.pending;
          threadPending = threadPending || result.pending > 0;
          gmailV2MarkSeen_(message.getId());
        } catch (err) {
          stats.errors++;
          threadError = true;
          writeLog_("GMAIL V2 ERROR", message.getId(), String(err && err.stack || err));
        }
      }
      if (threadError) thread.addLabel(labels.error);
      if (threadPending) thread.addLabel(labels.pending);
      if (threadFinished && !threadError) thread.addLabel(labels.processed);
      if (!threadFinished) break;
    }

    if (stats.inserted || stats.updated) {
      SpreadsheetApp.flush();
      // Inventory has its own hourly trigger. Run the immediate rebuild only when there is
      // enough budget left to finish cleanly and still record this cycle's audit entry.
      if (Date.now() - runStarted < GMAIL_V2_RUNTIME_BUDGET_MS - 45000) {
        try { syncInventoryModule(); } catch (syncErr) { writeLog_("GMAIL V2 INVENTORY FOLLOWUP", "warn", String(syncErr)); }
      } else {
        writeLog_("GMAIL V2 INVENTORY FOLLOWUP", "deferred", "Hourly inventory sync will pick up Gmail source updates.");
      }
    }
    stats.elapsedMs = Date.now() - runStarted;
    writeLog_("GMAIL V2 RUN", GMAIL_PIPELINE_V2_VERSION, JSON.stringify(stats));
    return stats;
  } finally {
    lock.releaseLock();
  }
}

function gmailV2Queries_() {
  var base = "newer_than:" + GMAIL_V2_LOOKBACK_DAYS + "d -in:spam -in:trash ";
  return [
    base + '{subject:출고 subject:해상 subject:해운 subject:항공 subject:선적 subject:입고 subject:"AIR SHIPMENT" subject:"OCEAN SHIPMENT" subject:"SILICON2 LIST" subject:"arrival notice" subject:"bill of lading" subject:BOL subject:"entry summary" subject:"shipping documents" subject:ISF subject:"delivery order" subject:POD subject:MAWB subject:HAWB}',
    base + '{from:info@cargomatic.com from:mcinfo@ups.com from:ups.com from:fedex.com from:usps.com from:dhl.com} {subject:shipment subject:delivery subject:delivered subject:completed subject:rescheduled subject:pickup}'
  ];
}

function gmailV2Labels_() {
  function getOrCreate(name) { return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name); }
  return {
    processed: getOrCreate(GMAIL_PIPELINE.labels.processed),
    pending: getOrCreate(GMAIL_PIPELINE.labels.pending),
    error: getOrCreate(GMAIL_PIPELINE.labels.error)
  };
}

function gmailV2Seen_(messageId) {
  return Boolean(PropertiesService.getScriptProperties().getProperty(GMAIL_V2_SEEN_PREFIX + messageId));
}

function gmailV2MarkSeen_(messageId) {
  PropertiesService.getScriptProperties().setProperty(GMAIL_V2_SEEN_PREFIX + messageId, String(Date.now()));
}

function ensureGmailV2Trigger_() {
  var props = PropertiesService.getScriptProperties();
  var wanted = "15m-" + GMAIL_PIPELINE_V2_VERSION;
  if (props.getProperty("GMAIL_V2_TRIGGER_VERSION") === wanted) return;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "processLogisticsEmails" || trigger.getHandlerFunction() === "processLogisticsEmailsV2") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger("processLogisticsEmailsV2").timeBased().everyMinutes(15).create();
  props.setProperty("GMAIL_V2_TRIGGER_VERSION", wanted);
}

function processLogisticsMessageV2_(message) {
  var subject = String(message.getSubject() || "").trim();
  var body = String(message.getPlainBody() || "");
  var meta = {
    messageId: message.getId(),
    subject: subject,
    body: body,
    from: message.getFrom(),
    date: message.getDate(),
    permalink: "https://mail.google.com/mail/u/0/#all/" + message.getId()
  };
  var context = extractEmailContextV2_(subject, body);
  var attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true }) || [];
  var records = [];
  var archived = [];
  var supportedSeen = false;

  attachments.forEach(function (attachment) {
    var name = String(attachment.getName() || "attachment");
    if (/\.(png|jpe?g|gif|ics|vcf)$/i.test(name)) return;
    var archiveUrl = archiveEmailAttachmentV2_(attachment, meta, context.kind || "other");
    if (archiveUrl) archived.push(archiveUrl);
    var parsed = extractAttachmentRecordsV2_(attachment, name, context, meta);
    if (parsed.supported) supportedSeen = true;
    parsed.records.forEach(function (record) {
      record._driveFile = archiveUrl || "";
      records.push(record);
    });
  });

  if (!records.length && hasStrongLogisticsContextV2_(context)) {
    records.push(mergeRecordContextV2_({}, context, meta));
  }

  records = collapseShipmentRecordsV2_(records.map(function (record) {
    return mergeRecordContextV2_(record, context, meta);
  }));

  if (!records.length) {
    addPendingRow_({
      kind: context.kind || "inbound",
      issues: [supportedSeen ? "No reliable shipment record could be extracted." : "No supported logistics attachment or strong shipment identifiers were extracted."],
      record: mergeRecordContextV2_({ parseError: "Email extraction produced no shipment-level record." }, context, meta),
      meta: meta,
      driveUrl: archived[0] || ""
    });
    return { inserted: 0, updated: 0, noop: 0, pending: 1 };
  }

  var result = { inserted: 0, updated: 0, noop: 0, pending: 0 };
  records.forEach(function (record) {
    var kind = record.kind || context.kind || guessKindFromRecordV2_(record);
    record.kind = kind;
    var upsert = kind === "outbound" ? upsertOutboundEmailV2_(record, false) : upsertInboundEmailV2_(record, false);
    if (upsert.matched) {
      result[upsert.action] = (result[upsert.action] || 0) + 1;
      return;
    }
    var validation = validateRecord_(record, kind);
    if (!validation.ok) {
      addPendingRow_({ kind: kind, issues: validation.issues, record: record, meta: meta, driveUrl: record._driveFile || archived[0] || "" });
      result.pending++;
      return;
    }
    var inserted = kind === "outbound" ? upsertOutboundEmailV2_(record, true) : upsertInboundEmailV2_(record, true);
    if (inserted.action === "inserted") result.inserted++;
    else if (inserted.matched) result[inserted.action]++;
    else {
      addPendingRow_({ kind: kind, issues: ["Validated record could not be matched or safely inserted."], record: record, meta: meta, driveUrl: record._driveFile || "" });
      result.pending++;
    }
  });
  return result;
}

function extractEmailContextV2_(subject, body) {
  var text = String(subject || "") + "\n" + String(body || "");
  var upper = text.toUpperCase();
  var context = { kind: "", shipmentNo: "", invoice: "", mbl: "", hbl: "", filing: "", container: "", vessel: "", etd: "", eta: "", shipDate: "", pro: "", status: "", carrier: "", note: "" };

  var sty = text.match(/\b(STY[- ]?\d{3,})\b/i);
  var isCarrierOutbound = Boolean(sty) || /CARGOMATIC|\bPRO\s*#|PICKUP|PICK UP|RATE RQ/i.test(text);
  var isInbound = /AIR SHIPMENT|OCEAN SHIPMENT|SILICON2 LIST|ARRIVAL NOTICE|MAWB|HAWB|\bETA\b|항공|해상|해운|선적서류|입고/i.test(text);
  context.kind = isCarrierOutbound && !/MAWB|HAWB|ARRIVAL NOTICE/i.test(text) ? "outbound" : (isInbound ? "inbound" : "");

  var shipment = text.match(/\b((?:ES|HJ|ER|OSL|MCI)\s*[- ]?\d{1,3})(?:\s*[- ]?2026)?\b/i);
  if (shipment) context.shipmentNo = shipment[1].replace(/\s+/g, "").replace(/-$/, "").toUpperCase().replace(/^([A-Z]+)(\d+)$/, "$1$2 - 2026");
  var step = text.match(/\b(ES|HJ|ER|OSL|MCI)\s*(\d{1,3})\s*차\b/i);
  if (!context.shipmentNo && step) context.shipmentNo = step[1].toUpperCase() + step[2] + " - 2026";
  var jsl = text.match(/\b(JSL\d{6,})\b/i);
  if (!context.shipmentNo && jsl) context.shipmentNo = jsl[1].toUpperCase();

  var mawb = text.match(/\bMAWB\s*#?\s*[:#]?\s*([0-9]{3}-?[0-9]{8})\b/i);
  var mbl = text.match(/\bMBL\s*#?\s*[:#]?\s*([A-Z0-9-]{7,})\b/i);
  if (mawb) context.mbl = mawb[1].toUpperCase();
  else if (mbl) context.mbl = mbl[1].toUpperCase();
  var hawb = text.match(/\b(?:HAWB|HBL)\s*#?\s*[:#]?\s*([A-Z0-9-]{5,})\b/i);
  if (hawb) context.hbl = hawb[1].toUpperCase();

  var containers = text.match(/\b[A-Z]{4}\d{7}\b/g);
  if (containers && containers.length === 1) context.container = containers[0].toUpperCase();
  var invoices = text.match(/\bIN\d{8}\b/gi);
  if (invoices && invoices.length) context.invoice = uniqueTextV2_(invoices.map(function (v) { return v.toUpperCase(); })).join("\n");
  var filing = text.match(/\bN8N-\d{6,}-\d+\b/i);
  if (filing) context.filing = filing[0].toUpperCase();
  if (sty) context.pro = sty[1].replace(/\s/g, "").toUpperCase();
  var pro = text.match(/\bPRO\s*#?\s*[:#]?\s*([A-Z0-9-]{6,})\b/i);
  if (!context.pro && pro) context.pro = pro[1].toUpperCase();

  context.eta = dateAfterLabelV2_(text, "ETA") || dateAfterLabelV2_(text, "ESTIMATED ARRIVAL");
  context.etd = dateAfterLabelV2_(text, "ETD");
  context.shipDate = dateAfterLabelV2_(text, "SHIP DATE") || dateAfterLabelV2_(text, "PICKUP DATE");

  var vessel = text.match(/\b(?:VSL|VESSEL(?:\s*\/\s*VOY)?)\b\s*[:#-]?\s*([^\r\n]{3,60})/i);
  if (vessel) {
    var vesselCandidate = cleanVesselV2_(vessel[1]);
    if (isPlausibleVesselV2_(vesselCandidate)) context.vessel = vesselCandidate;
  }

  // Never derive terminal status from a raw word anywhere in an email body. Legal
  // disclaimers commonly contain phrases such as "if you received this email in error".
  // Only explicit logistics-status phrases are allowed to change source status.
  context.status = explicitEmailStatusV2_(subject, body);

  if (/UPS/i.test(text)) context.carrier = "UPS";
  else if (/FEDEX/i.test(text)) context.carrier = "FedEx";
  else if (/CARGOMATIC/i.test(text)) context.carrier = "CARGOMATIC";
  context.note = String(subject || "").trim();
  return context;
}

function dateAfterLabelV2_(text, label) {
  var escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var re = new RegExp(escaped + "\\s*[:#=-]?\\s*(\\d{1,2}[\\/. -]\\d{1,2}(?:[\\/. -]\\d{2,4})?)", "i");
  var match = String(text || "").match(re);
  if (!match) return "";
  return normalizeEmailDateV2_(match[1]);
}

function normalizeEmailDateV2_(value) {
  var s = String(value || "").trim().replace(/[. -]+/g, "/");
  var m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return s;
  var year = m[3] ? (m[3].length === 2 ? "20" + m[3] : m[3]) : String(new Date().getFullYear());
  return String(Number(m[1])).padStart(2, "0") + "/" + String(Number(m[2])).padStart(2, "0") + "/" + year.slice(-2);
}

function cleanVesselV2_(value) {
  return String(value || "").replace(/\s{2,}/g, " ").replace(/[|,;].*$/, "").trim().slice(0, 60);
}

function isPlausibleVesselV2_(value) {
  var s = cleanVesselV2_(value);
  if (!s || s.length < 3) return false;
  if (/^(?:DELAY|DELAYS|DELAYED|STATUS|PENDING|RECEIVED|DELIVERED|COMPLETED|CUSTOMS|FDA|NOTES?|REMARKS?)$/i.test(s)) return false;
  // Air flight identifiers such as SQ-7408 / KE213 / OZ-202.
  if (/^[A-Z]{1,3}-?\d{2,4}$/i.test(s)) return true;
  // Ocean vessel+voyage strings such as HMM DAON 0022E / SM YANTIAN 2605E.
  if (/\b\d{3,4}[EW]\b/i.test(s) && /[A-Z]{2}/i.test(s)) return true;
  // Named vessels without a voyage must look like a real multi-token proper name,
  // not a prose/status fragment accidentally captured after the letters VSL.
  return s.length >= 6 && /\s/.test(s) && !/\b(?:ETA|ETD|DELAY|STATUS|CUSTOMS|FDA|DELIVERY|RECEIVED|COMPLETED)\b/i.test(s);
}

function explicitEmailStatusV2_(subject, body) {
  var subj = String(subject || "").trim();
  var lines = String(body || "").split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  // Only retain body lines that look operational. This deliberately excludes footer /
  // confidentiality prose even when it contains words such as received or delivered.
  var operational = lines.filter(function (line) {
    return /(?:STATUS|SHIPMENT|PACKAGE|DELIVER|TRANSIT|PICKED UP|PICKUP|FDA|CUSTOMS|HOLD|DETAIN|RELEASE|RESCHEDULE|DELAY|입고|배송|통관|보류|도착)/i.test(line);
  }).slice(0, 80);
  var signal = [subj].concat(operational).join("\n");

  if (/\bSHIPMENT\b[^\n]{0,60}\bHAS BEEN COMPLETED\b|\bSTATUS\s*[:=-]?\s*COMPLETED\b|배송\s*완료/i.test(signal)) return "Completed";
  if (/\b(?:PACKAGE|PACKAGES|SHIPMENT|DELIVERY)\b[^\n]{0,70}\b(?:HAS BEEN\s+)?DELIVERED\b|\bSTATUS\s*[:=-]?\s*DELIVERED\b|배송(?:이|은|는)?\s*완료/i.test(signal)) return "Delivered";
  if (/\b(?:STATUS|CURRENT STATUS|WAREHOUSE STATUS)\s*[:=-]?\s*RECEIVED\b|\bSHIPMENT\b[^\n]{0,50}\b(?:HAS BEEN\s+)?RECEIVED\b|입고\s*완료|창고\s*입고/i.test(signal)) return "Received";
  if (/FDA[^\n]{0,40}\b(?:HOLD|DETAINED?|REVIEW)\b|FDA[^\n]{0,30}보류/i.test(signal)) return "FDA Review/Hold";
  if (/CUSTOMS[^\n]{0,40}\b(?:HOLD|CLEARANCE PENDING|UNDER REVIEW)\b|통관[^\n]{0,30}(?:보류|검사|대기)/i.test(signal)) return "Customs Clearance";
  if (/\b(?:STATUS\s*[:=-]?\s*)?(?:IN TRANSIT|SHIPPED)\b|\bSHIPMENT\b[^\n]{0,40}\b(?:PICKED UP|SHIPPED)\b/i.test(signal)) return "Shipping";
  if (/\b(?:DELIVERY|ETA|SHIPMENT)\b[^\n]{0,60}\b(?:RESCHEDULED|DELAYED)\b|\bRESCHEDULED DELIVERY\b/i.test(signal)) return "Delayed";
  return "";
}

function hasStrongLogisticsContextV2_(record) {
  return Boolean(record.container || record.mbl || record.hbl || record.filing || record.invoice || record.pro || record.shipmentNo) &&
    Boolean(record.eta || record.etd || record.shipDate || record.status || record.kind);
}

function guessKindFromRecordV2_(record) {
  if (record.kind) return record.kind;
  if (record.container || record.mbl || record.hbl || record.eta) return "inbound";
  return "outbound";
}

function mergeRecordContextV2_(record, context, meta) {
  var out = {};
  Object.keys(record || {}).forEach(function (key) { out[key] = record[key]; });
  ["kind", "shipmentNo", "invoice", "mbl", "hbl", "filing", "container", "vessel", "etd", "eta", "shipDate", "pro", "status", "carrier"].forEach(function (key) {
    if (!out[key] && context[key]) out[key] = context[key];
  });
  if (!out.note) out.note = context.note || "";
  out._sourceEmail = meta.permalink;
  out._emailSubject = meta.subject;
  return out;
}

function extractAttachmentRecordsV2_(attachment, name, context, meta) {
  var lower = String(name || "").toLowerCase();
  var blob = attachment.copyBlob();
  blob.setName(name);
  if (/\.zip$/i.test(lower) || /zip/i.test(blob.getContentType())) {
    var records = [];
    var blobs;
    try { blobs = Utilities.unzip(blob); }
    catch (zipErr) { return { supported: true, records: [{ parseError: "ZIP could not be opened: " + zipErr.message }] }; }
    blobs.forEach(function (inner) {
      var parsed = extractBlobRecordsV2_(inner, inner.getName(), context, meta);
      parsed.records.forEach(function (r) { records.push(r); });
    });
    return { supported: true, records: records };
  }
  return extractBlobRecordsV2_(blob, name, context, meta);
}

function extractBlobRecordsV2_(blob, name, context, meta) {
  var lower = String(name || "").toLowerCase();
  try {
    if (/\.(csv|tsv)$/i.test(lower)) {
      var delimiter = /\.tsv$/i.test(lower) ? "\t" : ",";
      var rows = Utilities.parseCsv(blob.getDataAsString(), delimiter);
      return { supported: true, records: tableToShipmentRecordsV2_(rows, context, name) };
    }
    if (/\.(xlsx|xlsm|xls)$/i.test(lower) || /spreadsheet|excel/i.test(blob.getContentType())) {
      var tables = xlsxTablesV2_(blob);
      var xRecords = [];
      tables.forEach(function (table) {
        tableToShipmentRecordsV2_(table.rows, context, name + " / " + table.name).forEach(function (r) { xRecords.push(r); });
      });
      return { supported: true, records: xRecords };
    }
    if (/\.pdf$/i.test(lower) || /pdf/i.test(blob.getContentType())) {
      var text = pdfTextV2_(blob);
      var record = pdfTextRecordV2_(text, context, name);
      return { supported: true, records: hasStrongLogisticsContextV2_(record) ? [record] : [] };
    }
    return { supported: false, records: [] };
  } catch (err) {
    return { supported: true, records: [{ parseError: "Attachment parse failed: " + err.message, note: name }] };
  }
}

function tableToShipmentRecordsV2_(rows, context, sourceName) {
  if (!rows || !rows.length) return [];
  var headerRow = findLogisticsHeaderRowV2_(rows);
  if (headerRow < 0) return [];
  var headers = rows[headerRow].map(normalizeHeaderV2_);
  var map = {};
  headers.forEach(function (h, i) { if (h && map[h] === undefined) map[h] = i; });
  function idx(names) {
    for (var i = 0; i < names.length; i++) if (map[names[i]] !== undefined) return map[names[i]];
    return -1;
  }
  var cContainer = idx(["CONTAINER", "CONTAINER#", "CNTR", "CNTR#", "CNTRNO", "CONTAINERNO"]);
  var cInvoice = idx(["INVOICE", "INVOICE#", "INVOICENO", "PI", "PINO", "ENTRYNO", "ENTRYNUMBER"]);
  var cMbl = idx(["MBL", "MAWB", "MASTERBL", "MASTERB/L"]);
  var cHbl = idx(["HBL", "HAWB", "HOUSEBL", "HOUSEB/L"]);
  var cEta = idx(["ETA", "ESTIMATEDARRIVAL", "ARRIVALDATE"]);
  var cEtd = idx(["ETD", "DEPARTUREDATE"]);
  var cVessel = idx(["VSL", "VESSEL", "VESSEL/VOY", "VESSELVOY"]);
  var cQty = idx(["QTY", "QUANTITY", "TOTALQTY", "PCS", "UNITS"]);
  var cSku = idx(["SKU", "SKU#", "ITEM", "ITEMCODE"]);
  var cStatus = idx(["STATUS", "DELIVERY", "CUSTOMSSTATUS", "WEBSITESTATUS"]);
  var cNote = idx(["NOTE", "NOTES", "NOTES/REMARKS", "REMARKS"]);
  var cShipment = idx(["SHIPMENT", "SHIPMENT#", "차수"]);
  var records = [];

  rows.slice(headerRow + 1).forEach(function (row) {
    var record = { kind: context.kind || "inbound" };
    function val(index) { return index >= 0 ? String(row[index] == null ? "" : row[index]).trim() : ""; }
    record.container = normalizeContainerV2_(val(cContainer));
    record.invoice = val(cInvoice);
    record.mbl = val(cMbl);
    record.hbl = val(cHbl);
    record.eta = normalizeEmailDateV2_(val(cEta));
    record.etd = normalizeEmailDateV2_(val(cEtd));
    record.vessel = val(cVessel);
    record.qty = val(cQty);
    record.sku = val(cSku);
    record.status = normalizeEmailStatusV2_(val(cStatus));
    record.note = val(cNote) || sourceName;
    record.shipmentNo = val(cShipment);
    if (record.container || record.invoice || record.mbl || record.hbl || record.shipmentNo || record.sku) records.push(record);
  });
  return records;
}

function findLogisticsHeaderRowV2_(rows) {
  var best = -1, bestScore = 0;
  for (var r = 0; r < Math.min(rows.length, 40); r++) {
    var joined = rows[r].map(normalizeHeaderV2_);
    var score = 0;
    ["CONTAINER", "CONTAINER#", "CNTR#", "INVOICE", "INVOICE#", "MBL", "MAWB", "HBL", "HAWB", "ETA", "ETD", "VSL", "VESSEL", "SKU", "QTY"].forEach(function (name) {
      if (joined.indexOf(name) !== -1) score++;
    });
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore >= 2 ? best : -1;
}

function normalizeHeaderV2_(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "").replace(/NO\.?$/, "NO");
}

function normalizeContainerV2_(value) {
  var m = String(value || "").toUpperCase().replace(/\s/g, "").match(/[A-Z]{4}\d{7}/);
  return m ? m[0] : "";
}

function normalizeEmailStatusV2_(value) {
  var s = String(value || "").trim();
  if (!s) return "";
  if (/complete/i.test(s)) return "Completed";
  if (/deliver/i.test(s)) return "Delivered";
  if (/receive/i.test(s)) return "Received";
  if (/FDA.*(hold|detain|review)/i.test(s)) return "FDA Review/Hold";
  if (/custom/i.test(s)) return "Customs Clearance";
  if (/delay|resched/i.test(s)) return "Delayed";
  if (/ship|transit/i.test(s)) return "Shipping";
  return "";
}

function collapseShipmentRecordsV2_(records) {
  var groups = {};
  records.forEach(function (record) {
    if (record.parseError) {
      groups["ERROR_" + Object.keys(groups).length] = record;
      return;
    }
    var key = normalizedEmailKeyV2_(record.container || record.mbl || record.hbl || record.filing || record.shipmentNo || firstTokenV2_(record.invoice) || record.pro || record.sku);
    if (!key) key = "ROW_" + Object.keys(groups).length;
    if (!groups[key]) groups[key] = record;
    else groups[key] = mergeShipmentRecordV2_(groups[key], record);
  });
  return Object.keys(groups).map(function (key) { return groups[key]; });
}

function mergeShipmentRecordV2_(a, b) {
  var out = {};
  Object.keys(a).forEach(function (key) { out[key] = a[key]; });
  ["kind", "shipmentNo", "mbl", "hbl", "filing", "container", "vessel", "etd", "eta", "shipDate", "pro", "status", "carrier", "customer"].forEach(function (key) {
    if (!out[key] && b[key]) out[key] = b[key];
  });
  out.invoice = mergeMultilineV2_(out.invoice, b.invoice);
  if (a.qty || b.qty) out.qty = sumQtyV2_(a.qty, b.qty);
  if (!out.note && b.note) out.note = b.note;
  out._sourceEmail = out._sourceEmail || b._sourceEmail;
  out._driveFile = out._driveFile || b._driveFile;
  return out;
}

function sumQtyV2_(a, b) {
  var na = Number(String(a || "0").replace(/,/g, ""));
  var nb = Number(String(b || "0").replace(/,/g, ""));
  if (isNaN(na) && isNaN(nb)) return a || b || "";
  return String((isNaN(na) ? 0 : na) + (isNaN(nb) ? 0 : nb));
}

function uniqueTextV2_(values) {
  var seen = {};
  return values.filter(function (value) { var k = String(value || "").trim(); if (!k || seen[k]) return false; seen[k] = true; return true; });
}
function mergeMultilineV2_(a, b) { return uniqueTextV2_((String(a || "") + "\n" + String(b || "")).split(/[\n,;]+/).map(function (v) { return v.trim(); })).join("\n"); }
function firstTokenV2_(value) { return String(value || "").split(/[\n,;]+/)[0].trim(); }
function normalizedEmailKeyV2_(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

function xlsxTablesV2_(blob) {
  var id = convertBlobWithDriveRestV2_(blob, "application/vnd.google-apps.spreadsheet");
  try {
    var ss = SpreadsheetApp.openById(id);
    return ss.getSheets().map(function (sheet) { return { name: sheet.getName(), rows: sheet.getDataRange().getDisplayValues() }; });
  } finally {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {}
  }
}

function pdfTextV2_(blob) {
  var id = convertBlobWithDriveRestV2_(blob, "application/vnd.google-apps.document");
  try {
    var url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "/export?mimeType=text%2Fplain";
    var response = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (response.getResponseCode() >= 300) throw new Error("PDF text export failed HTTP " + response.getResponseCode());
    return response.getContentText();
  } finally {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {}
  }
}

function convertBlobWithDriveRestV2_(blob, targetMime) {
  var boundary = "sklogistics_" + Date.now() + "_" + Math.floor(Math.random() * 1000000);
  var metadata = JSON.stringify({ name: "TMP-email-import-" + Date.now(), mimeType: targetMime });
  var prefix = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + metadata +
    "\r\n--" + boundary + "\r\nContent-Type: " + (blob.getContentType() || "application/octet-stream") + "\r\n\r\n";
  var suffix = "\r\n--" + boundary + "--\r\n";
  var bytes = Utilities.newBlob(prefix).getBytes().concat(blob.getBytes()).concat(Utilities.newBlob(suffix).getBytes());
  var response = UrlFetchApp.fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "post",
    contentType: "multipart/related; boundary=" + boundary,
    payload: bytes,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() >= 300) throw new Error("Drive conversion failed HTTP " + response.getResponseCode() + ": " + response.getContentText().slice(0, 250));
  var parsed = JSON.parse(response.getContentText());
  if (!parsed.id) throw new Error("Drive conversion returned no file id.");
  return parsed.id;
}

function pdfTextRecordV2_(text, context, sourceName) {
  var record = extractEmailContextV2_(sourceName, text);
  record.kind = context.kind || record.kind || "inbound";
  var containers = String(text || "").toUpperCase().match(/\b[A-Z]{4}\d{7}\b/g);
  if (!record.container && containers && containers.length === 1) record.container = containers[0];
  if (!record.invoice) {
    var inv = String(text || "").match(/\bIN\d{8}\b/i);
    if (inv) record.invoice = inv[0].toUpperCase();
  }
  record.note = "Auto-extracted from " + sourceName;
  return record;
}

function archiveEmailAttachmentV2_(attachment, meta, kind) {
  try {
    var roots = DriveApp.getFoldersByName(GMAIL_PIPELINE.driveRootName);
    var root = roots.hasNext() ? roots.next() : DriveApp.createFolder(GMAIL_PIPELINE.driveRootName);
    var year = Utilities.formatDate(meta.date, "America/Los_Angeles", "yyyy");
    var month = Utilities.formatDate(meta.date, "America/Los_Angeles", "MM");
    var yf = childFolderV2_(root, year);
    var mf = childFolderV2_(yf, month);
    var kf = childFolderV2_(mf, kind || "other");
    var blob = attachment.copyBlob();
    var safe = Utilities.formatDate(meta.date, "America/Los_Angeles", "yyyyMMdd-HHmmss") + "__" + String(attachment.getName() || "attachment").replace(/[\\/:*?\"<>|]+/g, "_");
    blob.setName(safe);
    return kf.createFile(blob).getUrl();
  } catch (err) {
    writeLog_("GMAIL V2 ARCHIVE", meta.messageId, String(err));
    return "";
  }
}

function childFolderV2_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function upsertInboundEmailV2_(record, allowInsert) {
  var ss = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);
  var sheet = ss.getSheetByName("IMPORTS");
  if (!sheet) throw new Error("IMPORTS sheet not found.");
  var data = sheet.getDataRange().getDisplayValues();
  var schedulingIndex = data.findIndex(function (row) { return String(row[0] || "").trim().toUpperCase() === "SCHEDULING"; });
  var end = schedulingIndex === -1 ? data.length : schedulingIndex;
  var candidates = [];
  for (var r = 2; r < end; r++) {
    var score = inboundMatchScoreV2_(data[r], record);
    if (score) candidates.push({ row: r + 1, score: score });
  }
  candidates.sort(function (a, b) { return b.score - a.score; });
  if (candidates.length && (!candidates[1] || candidates[0].score > candidates[1].score)) {
    var changed = updateInboundRowV2_(sheet, candidates[0].row, data[candidates[0].row - 1], record);
    return { matched: true, action: changed ? "updated" : "noop", row: candidates[0].row };
  }
  if (!allowInsert) return { matched: false, action: "noop" };
  if (!record.eta || !(record.shipmentNo || record.container || record.mbl || record.hbl)) return { matched: false, action: "noop" };
  var markerRow = schedulingIndex === -1 ? sheet.getLastRow() + 1 : schedulingIndex + 1;
  sheet.insertRowBefore(markerRow);
  var targetRow = markerRow;
  if (targetRow > 3) sheet.getRange(targetRow - 1, 1, 1, 28).copyTo(sheet.getRange(targetRow, 1, 1, 28), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  var values = new Array(28).fill("");
  values[0] = record.shipmentNo || "EMAIL IMPORT";
  values[1] = record.shipmentNo || "";
  values[2] = record.invoice || "";
  values[3] = record.mbl || "";
  values[4] = record.hbl || "";
  values[7] = record.container || "";
  values[10] = record.filing || "";
  values[11] = emailNoteV2_(record);
  values[12] = isPlausibleVesselV2_(record.vessel) ? record.vessel : "";
  values[13] = record.etd || "";
  values[14] = record.eta || "";
  values[27] = record.status || "Work in Progress";
  sheet.getRange(targetRow, 1, 1, 28).setValues([values]);
  return { matched: true, action: "inserted", row: targetRow };
}

function inboundMatchScoreV2_(row, record) {
  var score = 0;
  if (sameEmailIdV2_(row[7], record.container)) score += 120;
  if (sameEmailIdV2_(row[3], record.mbl)) score += 100;
  if (sameEmailIdV2_(row[4], record.hbl)) score += 100;
  if (sameEmailIdV2_(row[10], record.filing)) score += 90;
  if (sameEmailIdV2_(row[0], record.shipmentNo) || sameEmailIdV2_(row[1], record.shipmentNo)) score += 85;
  if (multilineHasV2_(row[2], record.invoice)) score += 65;
  return score;
}

function updateInboundRowV2_(sheet, rowNumber, oldRow, record) {
  var changed = false;
  function set(col, value, overwrite) {
    if (!value) return;
    var old = String(oldRow[col - 1] || "").trim();
    if (old === String(value).trim()) return;
    if (old && !overwrite) return;
    sheet.getRange(rowNumber, col).setValue(value);
    oldRow[col - 1] = value;
    changed = true;
  }
  set(1, record.shipmentNo, false);
  if (record.invoice) {
    var mergedInvoices = mergeMultilineV2_(oldRow[2], record.invoice);
    if (mergedInvoices !== String(oldRow[2] || "").trim()) set(3, mergedInvoices, true);
  }
  set(4, record.mbl, false);
  set(5, record.hbl, false);
  set(8, record.container, false);
  set(11, record.filing, false);
  if (isPlausibleVesselV2_(record.vessel)) set(13, record.vessel, true);
  set(14, record.etd, true);
  set(15, record.eta, true);
  if (record.note || record._emailSubject) {
    var note = emailNoteV2_(record);
    var existing = String(oldRow[11] || "");
    if (note && existing.indexOf(note) === -1) set(12, existing ? existing + "\n" + note : note, true);
  }
  if (record.status) {
    var current = String(oldRow[27] || "").trim();
    var terminal = /^(SHIPPED|DELIVERED|RECEIVED|CANCELLED|COMPLETED)$/i.test(current);
    // Carrier/email automation may advance an active row, but never rewrite a source
    // row that is already terminal. This prevents Delivered/Received/Completed churn.
    if (!terminal) set(28, record.status, true);
  }
  if (changed) formatEmailStatusRowV2_(sheet, rowNumber, String(oldRow[27] || record.status || ""));
  return changed;
}

function upsertOutboundEmailV2_(record, allowInsert) {
  var ss = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);
  var sheet = ss.getSheetByName("WH Trucking Request");
  if (!sheet) throw new Error("WH Trucking Request sheet not found.");
  var data = sheet.getDataRange().getDisplayValues();
  var candidates = [];
  for (var r = 2; r < data.length; r++) {
    var score = 0;
    if (sameEmailIdV2_(data[r][18], record.pro)) score += 120;
    if (multilineHasV2_(data[r][1], record.invoice)) score += 80;
    if (score) candidates.push({ row: r + 1, score: score });
  }
  candidates.sort(function (a, b) { return b.score - a.score; });
  if (candidates.length && (!candidates[1] || candidates[0].score > candidates[1].score)) {
    var rowNumber = candidates[0].row;
    var old = data[rowNumber - 1];
    var changed = false;
    function set(col, value, overwrite) {
      if (!value) return;
      var prior = String(old[col - 1] || "").trim();
      if (prior === String(value).trim()) return;
      if (prior && !overwrite) return;
      sheet.getRange(rowNumber, col).setValue(value); old[col - 1] = value; changed = true;
    }
    if (record.invoice) set(2, mergeMultilineV2_(old[1], record.invoice), true);
    set(17, record.carrier, false);
    set(19, record.pro, false);
    if (record.shipDate) set(4, record.shipDate, true);
    if (record.status) {
      var currentOutbound = String(old[20] || "").trim();
      if (!/^(SHIPPED|DELIVERED|RECEIVED|CANCELLED|COMPLETED)$/i.test(currentOutbound)) set(21, record.status, true);
    }
    var note = emailNoteV2_(record);
    if (note && String(old[19] || "").indexOf(note) === -1) set(20, String(old[19] || "") ? String(old[19]) + "\n" + note : note, true);
    if (changed) formatEmailStatusRowV2_(sheet, rowNumber, String(old[20] || record.status || ""));
    return { matched: true, action: changed ? "updated" : "noop", row: rowNumber };
  }
  if (!allowInsert) return { matched: false, action: "noop" };
  if (!record.customer || !record.shipDate || !(record.invoice || record.pro)) return { matched: false, action: "noop" };
  var row = new Array(21).fill("");
  row[0] = record.customer; row[1] = record.invoice || ""; row[3] = record.shipDate;
  row[16] = record.carrier || ""; row[18] = record.pro || ""; row[19] = emailNoteV2_(record); row[20] = record.status || "Work in Progress";
  sheet.appendRow(row);
  return { matched: true, action: "inserted", row: sheet.getLastRow() };
}

function sameEmailIdV2_(a, b) {
  var aa = normalizedEmailKeyV2_(a), bb = normalizedEmailKeyV2_(b);
  return Boolean(aa && bb && aa === bb);
}
function multilineHasV2_(cellValue, wanted) {
  var wantedKeys = String(wanted || "").split(/[\n,;]+/).map(normalizedEmailKeyV2_).filter(Boolean);
  if (!wantedKeys.length) return false;
  var cellKeys = String(cellValue || "").split(/[\n,;]+/).map(normalizedEmailKeyV2_).filter(Boolean);
  return wantedKeys.some(function (key) { return cellKeys.indexOf(key) !== -1; });
}
function emailNoteV2_(record) {
  var subject = String(record._emailSubject || record.note || "").trim();
  if (!subject) return "";
  return "[EMAIL AUTO] " + subject.slice(0, 220);
}
function formatEmailStatusRowV2_(sheet, rowNumber, status) {
  var done = /^(SHIPPED|DELIVERED|RECEIVED|CANCELLED|COMPLETED)$/i.test(String(status || "").trim());
  var range = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn());
  if (done) range.setBackground("#E8EAED").setFontColor("#5F6368");
  else range.setBackground(null).setFontColor(null);
}
