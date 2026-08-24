/**
 * Triggers.gs — single owner for every production time-driven job.
 *
 * Run setupAllTriggers() once after deployment (and again after changing
 * schedules). It removes both legacy aliases and current handlers before
 * provisioning exactly one trigger for each desired job.
 */

/* eslint-disable no-unused-vars */

var GMAIL_PIPELINE_TRIGGER_SYNC_VERSION = "2026-08-12-central-v1";
var APPS_SCRIPT_DEPLOY_SYNC_VERSION = "2026-08-12-stabilization-v1";

var TRIGGER_PLAN = [
  { handler: "processLogisticsEmailsV2", minutes: 15 },
  { handler: "processApprovedPending", minutes: 30 },
  { handler: "scanAndImportWmsTruckingOrdersV2", minutes: 15 },
  { handler: "trackSmallParcelsStatusUpdates", hours: 1 },
  { handler: "syncInventoryModule", hours: 1 },
  { handler: "enrichImportsFromContainerLog", daily: 6 },
  { handler: "reconcileCustomerBackfill", daily: 5 }
];

// Installable onEdit triggers, kept separate from TRIGGER_PLAN's time-based
// jobs since they're provisioned via a different ScriptApp builder chain
// (.forSpreadsheet(...).onEdit() instead of .timeBased()). customerLookupOnEdit
// (CustomerLookup.gs) is deliberately NOT a bare global `onEdit` — that would
// auto-install as a restricted "simple trigger" that can't call
// SpreadsheetApp.openById (which logPipeline_ needs) — see that file's
// comment on the function. This is the trigger that gives it full
// authorization instead.
var EDIT_TRIGGER_PLAN = [
  { handler: "customerLookupOnEdit" }
];

var TRIGGER_CLEANUP_HANDLERS = [
  "processLogisticsEmails",
  "processLogisticsEmailsV2",
  "scanAndImportWmsTruckingOrders",
  "scanAndImportWmsTruckingOrdersV2",
  "trackSmallParcelsStatusUpdates",
  "syncInventoryModule",
  "enrichImportsFromContainerLog",
  "reconcileCustomerBackfill",
  "customerLookupOnEdit",
  "requestSiteRedeploy"
];

function setupAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (TRIGGER_CLEANUP_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  TRIGGER_PLAN.forEach(function (t) {
    var builder = ScriptApp.newTrigger(t.handler).timeBased();
    if (t.minutes) builder.everyMinutes(t.minutes).create();
    else if (t.hours) builder.everyHours(t.hours).create();
    else builder.everyDays(1).atHour(t.daily).create();
  });

  EDIT_TRIGGER_PLAN.forEach(function (t) {
    ScriptApp.newTrigger(t.handler).forSpreadsheet(SPREADSHEET_ID).onEdit().create();
  });

  Logger.log(
    "Provisioned " + TRIGGER_PLAN.length + " canonical triggers and " +
    EDIT_TRIGGER_PLAN.length + " edit trigger(s)."
  );
  return TRIGGER_PLAN.concat(EDIT_TRIGGER_PLAN);
}

/**
 * Legacy safety shim only. This handler is intentionally absent from
 * TRIGGER_PLAN, but retaining the function prevents a stale installed trigger
 * from failing before setupAllTriggers() has a chance to delete it.
 */
function requestSiteRedeploy() {
  Logger.log("requestSiteRedeploy is obsolete; live operational data no longer requires a code redeploy.");
  return { skipped: "obsolete" };
}
