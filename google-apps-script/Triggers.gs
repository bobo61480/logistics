/**
<<<<<<< HEAD
 * Triggers.gs — one-click provisioning of every time-driven job,
 * plus the GitHub Pages redeploy hook.
 *
 * Run setupAllTriggers() once (and again after changing schedules).
 *
 * Script Properties (File > Project properties > Script properties):
 *   GITHUB_TOKEN  — fine-grained PAT, repo bobo61480/logistics,
 *                   permission: Contents: Read & write (for repository_dispatch)
 *   GITHUB_REPO   — optional override, default "bobo61480/logistics"
=======
 * Triggers.gs — single owner for every production time-driven job.
 *
 * Run setupAllTriggers() once after deployment (and again after changing
 * schedules). It removes both legacy aliases and current handlers before
 * provisioning exactly one trigger for each desired job.
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
 */

/* eslint-disable no-unused-vars */

<<<<<<< HEAD
var TRIGGER_PLAN = [
  { handler: "processLogisticsEmails", minutes: 15 },          // Gmail ingestion
  { handler: "processApprovedPending", minutes: 30 },          // commit human-approved rows
  { handler: "scanAndImportWmsTruckingOrders", minutes: 30 },  // existing WMS trucking scanner (Code.gs)
  { handler: "trackSmallParcelsStatusUpdates", minutes: 45 },  // track inbound small parcels for status updates
  { handler: "syncInventoryModule", hours: 1 },                // inventory + KPI rebuild
  { handler: "enrichImportsFromContainerLog", daily: 6 },      // 6 AM daily
  { handler: "requestSiteRedeploy", daily: 7 }                 // 7 AM daily safety redeploy
];

function setupAllTriggers() {
  var handlers = TRIGGER_PLAN.map(function (t) { return t.handler; });
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
=======
var GMAIL_PIPELINE_TRIGGER_SYNC_VERSION = "2026-08-12-central-v1";
var APPS_SCRIPT_DEPLOY_SYNC_VERSION = "2026-08-12-stabilization-v1";

var TRIGGER_PLAN = [
  { handler: "processLogisticsEmailsV2", minutes: 15 },
  { handler: "processApprovedPending", minutes: 30 },
  { handler: "trackSmallParcelsStatusUpdates", hours: 1 },
  { handler: "syncInventoryModule", hours: 1 },
  { handler: "enrichImportsFromContainerLog", daily: 6 }
];

var TRIGGER_CLEANUP_HANDLERS = [
  "processLogisticsEmails",
  "processLogisticsEmailsV2",
  "scanAndImportWmsTruckingOrders",
  "scanAndImportWmsTruckingOrdersV2",
  "trackSmallParcelsStatusUpdates",
  "syncInventoryModule",
  "enrichImportsFromContainerLog",
  "requestSiteRedeploy"
];

function setupAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (TRIGGER_CLEANUP_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
  });

  TRIGGER_PLAN.forEach(function (t) {
    var builder = ScriptApp.newTrigger(t.handler).timeBased();
    if (t.minutes) builder.everyMinutes(t.minutes).create();
    else if (t.hours) builder.everyHours(t.hours).create();
    else builder.everyDays(1).atHour(t.daily).create();
  });

<<<<<<< HEAD
  Logger.log("Provisioned " + TRIGGER_PLAN.length + " triggers.");
=======
  Logger.log("Provisioned " + TRIGGER_PLAN.length + " canonical triggers.");
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
  return TRIGGER_PLAN;
}

/**
<<<<<<< HEAD
 * Fires a repository_dispatch event so GitHub Actions redeploys the site.
 * The frontend reads sheet data live at runtime, so this is only needed to
 * refresh statically-baked content and to keep Pages caches warm.
 */
function requestSiteRedeploy() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("GITHUB_TOKEN");
  if (!token) { Logger.log("GITHUB_TOKEN script property not set — skipping redeploy."); return; }
  var repo = props.getProperty("GITHUB_REPO") || "bobo61480/logistics";

  var response = UrlFetchApp.fetch("https://api.github.com/repos/" + repo + "/dispatches", {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    payload: JSON.stringify({ event_type: "sheet-data-changed", client_payload: { at: new Date().toISOString() } }),
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code >= 300) throw new Error("repository_dispatch failed: HTTP " + code + " " + response.getContentText().slice(0, 200));
  Logger.log("Redeploy requested (HTTP " + code + ").");
=======
 * Legacy safety shim only. This handler is intentionally absent from
 * TRIGGER_PLAN, but retaining the function prevents a stale installed trigger
 * from failing before setupAllTriggers() has a chance to delete it.
 */
function requestSiteRedeploy() {
  Logger.log("requestSiteRedeploy is obsolete; live operational data no longer requires a code redeploy.");
  return { skipped: "obsolete" };
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
}
