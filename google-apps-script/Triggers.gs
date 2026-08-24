/**
 * Triggers.gs — single owner for every production time-driven job.
 *
 * Run setupAllTriggers() once after deployment (and again after changing
 * schedules). It removes both legacy aliases and current handlers before
 * provisioning exactly one trigger for each desired job.
 */

/* eslint-disable no-unused-vars */

var GMAIL_PIPELINE_TRIGGER_SYNC_VERSION = "2026-08-24-central-v2-xpo";
var APPS_SCRIPT_DEPLOY_SYNC_VERSION = "2026-08-12-stabilization-v1";

var TRIGGER_PLAN = [
  { handler: "processLogisticsEmailsV2", minutes: 15 },
  { handler: "processXpoTrackingEmailsV2", minutes: 15 },
  { handler: "processApprovedPending", minutes: 30 },
  { handler: "scanAndImportWmsTruckingOrdersV2", minutes: 15 },
  { handler: "trackSmallParcelsStatusUpdates", hours: 1 },
  { handler: "syncInventoryModule", hours: 1 },
  { handler: "enrichImportsFromContainerLog", daily: 6 },
  { handler: "reconcileCustomerBackfill", daily: 5 }
];

// customerLookupOnEdit is retained here ONLY as a cleanup target: an earlier
// revision of PR #92 registered it as an installable trigger, but
// deploy-apps-script.yml never runs setupAllTriggers(), so that trigger
// would have silently disabled the customer-lookup automation after every
// deploy until a human manually re-ran setup. Reverted — CustomerLookup.gs's
// onEdit(e) is a bare, zero-config simple trigger again (see that file's
// header comment for how it now avoids the authorization-requiring calls a
// simple trigger can't make). This entry just ensures setupAllTriggers()
// deletes any stray installable trigger left over from that revision.
var TRIGGER_CLEANUP_HANDLERS = [
  "processLogisticsEmails",
  "processLogisticsEmailsV2",
  "processXpoTrackingEmailsV2",
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

  Logger.log("Provisioned " + TRIGGER_PLAN.length + " canonical triggers.");
  return TRIGGER_PLAN;
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
