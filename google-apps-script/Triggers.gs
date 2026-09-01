/**
 * Triggers.gs — single owner for every production time-driven job.
 *
 * Run setupAllTriggers() once after deployment (and again after changing
 * schedules). It removes both legacy aliases and current handlers before
 * provisioning exactly one trigger for each desired job.
 */

/* eslint-disable no-unused-vars */

var GMAIL_PIPELINE_TRIGGER_SYNC_VERSION = "2026-08-31-central-v7-yixi-location-selfheal";
var APPS_SCRIPT_DEPLOY_SYNC_VERSION = "2026-08-29-d1-canonical-v4";

var TRIGGER_PLAN = [
  { handler: "processLogisticsEmailsV2", minutes: 15 },
  { handler: "processXpoTrackingEmailsV2", minutes: 15 },
  { handler: "processApprovedPending", minutes: 30 },
  { handler: "scanAndImportWmsTruckingOrdersV2", minutes: 15 },
  { handler: "dedupeWhTruckingLocationSafeV5", minutes: 1 },
  { handler: "trackSmallParcelsStatusUpdates", hours: 1 },
  { handler: "syncInventoryModule", hours: 1 },
  { handler: "dedupeAllOperationalSheetsV4", daily: 4 },
  { handler: "enrichImportsFromContainerLog", daily: 6 },
  { handler: "reconcileCustomerBackfill", daily: 5 }
];

var TRIGGER_PLAN_PROPERTY = "CANONICAL_TRIGGER_PLAN_APPLIED_VERSION";
var TRIGGER_LOCK_SKIP_PREFIX = "TRIGGER_LOCK_SKIPS_";

function recordTriggerLockSkip_(handler) {
  var props = PropertiesService.getScriptProperties();
  var key = TRIGGER_LOCK_SKIP_PREFIX + String(handler || "unknown");
  props.setProperty(key, String(Number(props.getProperty(key) || 0) + 1));
}

function consumeTriggerLockSkips_(handler) {
  var props = PropertiesService.getScriptProperties();
  var key = TRIGGER_LOCK_SKIP_PREFIX + String(handler || "unknown");
  var count = Number(props.getProperty(key) || 0);
  props.deleteProperty(key);
  return count;
}

function ensureCanonicalTriggersForVersion_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(TRIGGER_PLAN_PROPERTY) === GMAIL_PIPELINE_TRIGGER_SYNC_VERSION) return false;
  setupAllTriggers();
  try {
    logPipeline_("TRIGGER PLAN REPAIRED", GMAIL_PIPELINE_TRIGGER_SYNC_VERSION, JSON.stringify({ handlers: TRIGGER_PLAN.length }));
  } catch (e) {
    Logger.log("Trigger repair logging failed: " + e.message);
  }
  return true;
}

var TRIGGER_CLEANUP_HANDLERS = [
  "processLogisticsEmails",
  "processLogisticsEmailsV2",
  "processXpoTrackingEmailsV2",
  "scanAndImportWmsTruckingOrders",
  "scanAndImportWmsTruckingOrdersV2",
  "dedupeWhTruckingLocationSafeV5",
  "trackSmallParcelsStatusUpdates",
  "syncInventoryModule",
  "dedupeAllOperationalSheetsV4",
  "enrichImportsFromContainerLog",
  "reconcileCustomerBackfill",
  "customerLookupOnEdit",
  "requestSiteRedeploy"
];

function setupAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (TRIGGER_CLEANUP_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });

  TRIGGER_PLAN.forEach(function (t) {
    var builder = ScriptApp.newTrigger(t.handler).timeBased();
    if (t.minutes) builder.everyMinutes(t.minutes).create();
    else if (t.hours) builder.everyHours(t.hours).create();
    else builder.everyDays(1).atHour(t.daily).create();
  });

  PropertiesService.getScriptProperties().setProperty(TRIGGER_PLAN_PROPERTY, GMAIL_PIPELINE_TRIGGER_SYNC_VERSION);
  Logger.log("Provisioned " + TRIGGER_PLAN.length + " canonical triggers for " + GMAIL_PIPELINE_TRIGGER_SYNC_VERSION + ".");
  return TRIGGER_PLAN;
}

function requestSiteRedeploy() {
  Logger.log("requestSiteRedeploy is obsolete; live operational data no longer requires a code redeploy.");
  return { skipped: "obsolete" };
}
