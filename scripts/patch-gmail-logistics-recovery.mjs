import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, from, to) {
  const source = readFileSync(path, "utf8");
  if (!source.includes(from)) throw new Error(`Expected patch anchor missing in ${path}: ${from.slice(0, 120)}`);
  const next = source.replace(from, to);
  if (next === source) throw new Error(`Patch made no change in ${path}`);
  writeFileSync(path, next);
}

// Gmail pipeline: visible lock starvation, self-healing triggers, and safe IMPORTS placement.
replaceOnce(
  "google-apps-script/GmailPipelineV2.gs",
  'var GMAIL_PIPELINE_V2_VERSION = "2026-08-12-v4-status-retry-stabilization";',
  'var GMAIL_PIPELINE_V2_VERSION = "2026-08-31-v5-trigger-boundary-recovery";',
);

replaceOnce(
  "google-apps-script/GmailPipelineV2.gs",
  `  var lock = LockService.getScriptLock();\n  if (!lock.tryLock(5000)) return { skipped: "locked" };\n  var runStarted = Date.now();\n  try {\n    var labels = gmailV2Labels_();`,
  `  var lock = LockService.getScriptLock();\n  if (!lock.tryLock(5000)) {\n    recordTriggerLockSkip_("processLogisticsEmailsV2");\n    return { skipped: "locked" };\n  }\n  var runStarted = Date.now();\n  try {\n    ensureCanonicalTriggersForVersion_();\n    var labels = gmailV2Labels_();`,
);

replaceOnce(
  "google-apps-script/GmailPipelineV2.gs",
  `      threads: 0, messages: 0, inserted: 0, updated: 0, noop: 0,\n      pending: 0, errors: 0, deferredThreads: 0, retryDeferred: 0, budgetHit: false\n    };`,
  `      threads: 0, messages: 0, inserted: 0, updated: 0, noop: 0,\n      pending: 0, errors: 0, deferredThreads: 0, retryDeferred: 0, budgetHit: false,\n      priorLockSkips: consumeTriggerLockSkips_("processLogisticsEmailsV2")\n    };`,
);

replaceOnce(
  "google-apps-script/GmailPipelineV2.gs",
  `function upsertInboundEmailV2_(record, allowInsert) {\n  var ss = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);\n  var sheet = ss.getSheetByName("IMPORTS");\n  if (!sheet) throw new Error("IMPORTS sheet not found.");\n  var data = sheet.getDataRange().getDisplayValues();\n  var schedulingIndex = data.findIndex(function (row) { return String(row[0] || "").trim().toUpperCase() === "SCHEDULING"; });\n  var end = schedulingIndex === -1 ? data.length : schedulingIndex;`,
  `function chooseInboundInsertRowV2_(data, schedulingIndex) {\n  if (schedulingIndex < 0) throw new Error("IMPORTS SCHEDULING marker is missing; cannot safely insert an import shipment.");\n  var lastOccupiedIndex = 1;\n  for (var i = 2; i < schedulingIndex; i++) {\n    var occupied = (data[i] || []).some(function (cell) { return String(cell || "").trim() !== ""; });\n    if (occupied) lastOccupiedIndex = i;\n  }\n  var markerRow = schedulingIndex + 1;\n  var candidateRow = lastOccupiedIndex + 2;\n  if (candidateRow < markerRow) return { row: candidateRow, insertBeforeMarker: false };\n  return { row: markerRow, insertBeforeMarker: true };\n}\n\nfunction upsertInboundEmailV2_(record, allowInsert) {\n  var ss = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);\n  var sheet = ss.getSheetByName("IMPORTS");\n  if (!sheet) throw new Error("IMPORTS sheet not found.");\n  var data = sheet.getDataRange().getDisplayValues();\n  var schedulingIndex = data.findIndex(function (row) { return String(row[0] || "").trim().toUpperCase() === "SCHEDULING"; });\n  if (schedulingIndex < 0) throw new Error("IMPORTS SCHEDULING marker is missing; ingestion stopped before the small-parcel section.");\n  var end = schedulingIndex;`,
);

replaceOnce(
  "google-apps-script/GmailPipelineV2.gs",
  `  var markerRow = schedulingIndex === -1 ? sheet.getLastRow() + 1 : schedulingIndex + 1;\n  sheet.insertRowBefore(markerRow);\n  var targetRow = markerRow;`,
  `  var insertPlan = chooseInboundInsertRowV2_(data, schedulingIndex);\n  if (insertPlan.insertBeforeMarker) sheet.insertRowBefore(insertPlan.row);\n  var targetRow = insertPlan.row;`,
);

// WMS: only current/future schedules, destination-aware grouping, and operational-date precedence.
replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `var WMS_TRUCKING_IMPORT_MIN_DATE = "2026-08-01";\nvar WMS_TRUCKING_SYNC_ENABLED = true;\n// Re-enabled 2026-08-23 after fixing the customer-canonicalization bug that\n// caused the 2026-08-12 KORHEIM wrong-merge incident (canonicalWmsCustomer_\n// in Code.gs used an unanchored prefix match, not the word-boundary check it\n// has now). Ships in dry-run first: real scans run and log exactly what they\n// would insert/update to PIPELINE LOG without touching WH Trucking Request,\n// so the fix can be validated against live data before trusting it with\n// writes again. Flip to false only after reviewing several dry-run cycles.\nvar WMS_TRUCKING_DRY_RUN = true;\n\nfunction wmsImportEligible_(dateInfo) {\n  var key = String(dateInfo && dateInfo.key || "").trim();\n  return /^\\d{4}-\\d{2}-\\d{2}$/.test(key) && key >= WMS_TRUCKING_IMPORT_MIN_DATE;\n}\n\nfunction wmsExactGroupKey_(customer, dateInfo) {\n  return normalizeWmsCustomerKey_(canonicalWmsCustomer_(customer)) + "___" + String(dateInfo && dateInfo.key || "");\n}`,
  `var WMS_TRUCKING_IMPORT_MIN_DATE = "2026-08-01";\nvar WMS_TRUCKING_SYNC_ENABLED = true;\n// Production writes are safe only after destination-aware grouping and\n// operational-date precedence. Current/future rows are synchronized; historic\n// freight is left as audit history instead of being recreated as new schedules.\nvar WMS_TRUCKING_DRY_RUN = false;\n\nfunction wmsTodayKey_() {\n  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");\n}\n\nfunction wmsImportEligible_(dateInfo, todayKey) {\n  var key = String(dateInfo && dateInfo.key || "").trim();\n  var floor = String(todayKey || wmsTodayKey_()).trim();\n  return /^\\d{4}-\\d{2}-\\d{2}$/.test(key) && key >= WMS_TRUCKING_IMPORT_MIN_DATE && key >= floor;\n}\n\nfunction normalizeWmsDestinationHint_(value) {\n  var text = String(value || "").trim();\n  if (!text || /^(?:YES|NO|TRUE|FALSE|Y|N)$/i.test(text)) return "";\n  if (/\\b(?:OOS|ADD[ -]?ON|FREE SAMPLE|TOTAL|SKU)\\b|A-SKU|총량|재고|문제/i.test(text)) return "";\n  if (/^IN\\d{6,}$/i.test(text)) return "";\n  if (/^[A-Z0-9._-]{3,25}$/i.test(text) && text.indexOf(" ") === -1) return "";\n  if (!/[A-Za-z가-힣]{3}/.test(text)) return "";\n  return normalizeWmsCustomerKey_(text);\n}\n\nfunction wmsDestinationHint_(row, map) {\n  var fields = ["REMARKS (WAREHOUSE)", "REMARKS (SALES)", "SKU 2", "SKU 1"];\n  for (var i = 0; i < fields.length; i++) {\n    var index = map[fields[i]];\n    if (index === undefined) continue;\n    var hint = normalizeWmsDestinationHint_(row[index]);\n    if (hint) return hint;\n  }\n  return "";\n}\n\nfunction wmsExactGroupKey_(customer, dateInfo, destinationHint) {\n  var key = normalizeWmsCustomerKey_(canonicalWmsCustomer_(customer)) + "___" + String(dateInfo && dateInfo.key || "");\n  var destination = normalizeWmsCustomerKey_(destinationHint || "");\n  return destination ? key + "___DEST_" + destination : key;\n}\n\nfunction shouldWmsOverwriteShipDate_(currentRow, map) {\n  var status = map["STATUS"] !== undefined ? String(currentRow[map["STATUS"]] || "").trim().toUpperCase() : "";\n  var pro = map["PRO#"] !== undefined ? String(currentRow[map["PRO#"]] || "").trim() : "";\n  if (status === "ROUTED/BOOKED" || pro) return false;\n  return true;\n}`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `  for (var i = 0; i < rows.length; i++) {\n    var row = rows[i];\n    if (row.key !== groupKey) continue;\n    for (var j = 0; j < row.invoices.length; j++) {\n      if (wanted.has(String(row.invoices[j] || "").trim().toUpperCase())) return row;\n    }\n  }`,
  `  for (var i = 0; i < rows.length; i++) {\n    var row = rows[i];\n    for (var j = 0; j < row.invoices.length; j++) {\n      if (wanted.has(String(row.invoices[j] || "").trim().toUpperCase())) return row;\n    }\n  }`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `    var groups = new Map();\n    var sourceByInvoice = new Map();\n    var skippedBeforeCutoff = 0;`,
  `    var groups = new Map();\n    var sourceByInvoice = new Map();\n    var skippedBeforeCutoff = 0;\n    var importTodayKey = wmsTodayKey_();`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `      var customer = canonicalWmsCustomer_(rawCustomer);\n      var dateInfo = normalizeWmsShipDate_(rawShipDate);\n      if (!wmsImportEligible_(dateInfo)) {\n        skippedBeforeCutoff++;\n        continue;\n      }\n\n      var key = wmsExactGroupKey_(customer, dateInfo);\n      sourceByInvoice.set(invoice, {\n        customer: customer,\n        dateInfo: dateInfo,\n        sourceRow: r + 1,\n        key: key\n      });`,
  `      var customer = canonicalWmsCustomer_(rawCustomer);\n      var dateInfo = normalizeWmsShipDate_(rawShipDate);\n      if (!wmsImportEligible_(dateInfo, importTodayKey)) {\n        skippedBeforeCutoff++;\n        continue;\n      }\n\n      var destinationHint = wmsDestinationHint_(row, sourceMap);\n      var key = wmsExactGroupKey_(customer, dateInfo, destinationHint);\n      sourceByInvoice.set(invoice, {\n        customer: customer,\n        dateInfo: dateInfo,\n        destinationHint: destinationHint,\n        sourceRow: r + 1,\n        key: key\n      });`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `          shipDate: dateInfo.display,\n          invoices: [],`,
  `          shipDate: dateInfo.display,\n          destinationHint: destinationHint,\n          invoices: [],`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `        if (WMS_TRUCKING_DRY_RUN) {\n          changed = wouldChangeMappedValue_(current, targetMap, "CUSTOMER", group.customer) ||\n            wouldChangeMappedValue_(current, targetMap, "INVOICE NO.", mergedInvoices.join("\\n")) ||\n            wouldChangeMappedValue_(current, targetMap, "SHIP DATE", group.shipDate) ||\n            (totalAmount > 0 && targetMap["VALUE"] !== undefined && !current[targetMap["VALUE"]]) ||`,
  `        if (WMS_TRUCKING_DRY_RUN) {\n          var mayUpdateShipDate = shouldWmsOverwriteShipDate_(current, targetMap);\n          changed = wouldChangeMappedValue_(current, targetMap, "CUSTOMER", group.customer) ||\n            wouldChangeMappedValue_(current, targetMap, "INVOICE NO.", mergedInvoices.join("\\n")) ||\n            (mayUpdateShipDate && wouldChangeMappedValue_(current, targetMap, "SHIP DATE", group.shipDate)) ||\n            (totalAmount > 0 && targetMap["VALUE"] !== undefined && !current[targetMap["VALUE"]]) ||`,
);

replaceOnce(
  "google-apps-script/WmsTruckingSyncV2.gs",
  `          changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "CUSTOMER", group.customer) || changed;\n          changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "INVOICE NO.", mergedInvoices.join("\\n")) || changed;\n          changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "SHIP DATE", group.shipDate) || changed;`,
  `          changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "CUSTOMER", group.customer) || changed;\n          changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "INVOICE NO.", mergedInvoices.join("\\n")) || changed;\n          if (shouldWmsOverwriteShipDate_(current, targetMap)) {\n            changed = writeMappedValue_(targetSheet, match.rowNumber, targetMap, "SHIP DATE", group.shipDate) || changed;\n          }`,
);

// Trigger plan: repair deployed cadence automatically once per version and surface lock starvation.
replaceOnce(
  "google-apps-script/Triggers.gs",
  'var GMAIL_PIPELINE_TRIGGER_SYNC_VERSION = "2026-08-29-central-v4-dedupe";',
  'var GMAIL_PIPELINE_TRIGGER_SYNC_VERSION = "2026-08-31-central-v5-gmail-recovery";',
);

replaceOnce(
  "google-apps-script/Triggers.gs",
  `var TRIGGER_CLEANUP_HANDLERS = [\n  "processLogisticsEmails",`,
  `var TRIGGER_PLAN_PROPERTY = "CANONICAL_TRIGGER_PLAN_APPLIED_VERSION";\nvar TRIGGER_LOCK_SKIP_PREFIX = "TRIGGER_LOCK_SKIPS_";\n\nfunction recordTriggerLockSkip_(handler) {\n  var props = PropertiesService.getScriptProperties();\n  var key = TRIGGER_LOCK_SKIP_PREFIX + String(handler || "unknown");\n  props.setProperty(key, String(Number(props.getProperty(key) || 0) + 1));\n}\n\nfunction consumeTriggerLockSkips_(handler) {\n  var props = PropertiesService.getScriptProperties();\n  var key = TRIGGER_LOCK_SKIP_PREFIX + String(handler || "unknown");\n  var count = Number(props.getProperty(key) || 0);\n  props.deleteProperty(key);\n  return count;\n}\n\nfunction ensureCanonicalTriggersForVersion_() {\n  var props = PropertiesService.getScriptProperties();\n  if (props.getProperty(TRIGGER_PLAN_PROPERTY) === GMAIL_PIPELINE_TRIGGER_SYNC_VERSION) return false;\n  setupAllTriggers();\n  try {\n    logPipeline_("TRIGGER PLAN REPAIRED", GMAIL_PIPELINE_TRIGGER_SYNC_VERSION, JSON.stringify({ handlers: TRIGGER_PLAN.length }));\n  } catch (e) {\n    Logger.log("Trigger repair logging failed: " + e.message);\n  }\n  return true;\n}\n\nvar TRIGGER_CLEANUP_HANDLERS = [\n  "processLogisticsEmails",`,
);

replaceOnce(
  "google-apps-script/Triggers.gs",
  `  Logger.log("Provisioned " + TRIGGER_PLAN.length + " canonical triggers.");\n  return TRIGGER_PLAN;`,
  `  PropertiesService.getScriptProperties().setProperty(TRIGGER_PLAN_PROPERTY, GMAIL_PIPELINE_TRIGGER_SYNC_VERSION);\n  Logger.log("Provisioned " + TRIGGER_PLAN.length + " canonical triggers for " + GMAIL_PIPELINE_TRIGGER_SYNC_VERSION + ".");\n  return TRIGGER_PLAN;`,
);

replaceOnce(
  "google-apps-script/GmailXpoV2.gs",
  `  var lock = LockService.getScriptLock();\n  if (!lock.tryLock(5000)) return { skipped: "locked" };\n  try {\n    var query = "newer_than:" + GMAIL_XPO_V2_LOOKBACK_DAYS +`,
  `  var lock = LockService.getScriptLock();\n  if (!lock.tryLock(5000)) {\n    recordTriggerLockSkip_("processXpoTrackingEmailsV2");\n    return { skipped: "locked" };\n  }\n  try {\n    ensureCanonicalTriggersForVersion_();\n    var query = "newer_than:" + GMAIL_XPO_V2_LOOKBACK_DAYS +`,
);

replaceOnce(
  "google-apps-script/GmailXpoV2.gs",
  `    var stats = { messages: 0, updated: 0, noop: 0, pending: 0, errors: 0 };`,
  `    var stats = { messages: 0, updated: 0, noop: 0, pending: 0, errors: 0, priorLockSkips: consumeTriggerLockSkips_("processXpoTrackingEmailsV2") };`,
);

console.log("Applied Gmail logistics recovery patch.");
