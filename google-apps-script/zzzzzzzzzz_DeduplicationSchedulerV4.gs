/**
 * Activates V4 deduplication without requiring trigger reprovisioning.
 * The existing hourly syncInventoryModule trigger is already installed in
 * production; wrap it and run the heavier dedupe pass at most once per day.
 */
/* eslint-disable no-unused-vars */

var DEDUPE_V4_LAST_RUN_PROPERTY = "DEDUPLICATION_V4_LAST_SUCCESS";
var DEDUPE_V4_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

function maybeRunDailyDeduplicationV4_() {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty(DEDUPE_V4_LAST_RUN_PROPERTY) || 0);
  if (last && Date.now() - last < DEDUPE_V4_MIN_INTERVAL_MS) return { skipped: "recent" };
  var result = dedupeAllOperationalSheetsV4();
  if (result && result.ok) props.setProperty(DEDUPE_V4_LAST_RUN_PROPERTY, String(Date.now()));
  return result;
}

function installDeduplicationSchedulerV4_() {
  if (typeof syncInventoryModule !== "function" || syncInventoryModule._dedupeV4Scheduler) return "skipped";
  var baseSyncInventory = syncInventoryModule;
  var wrappedSyncInventory = function () {
    var result = baseSyncInventory.apply(this, arguments);
    try { maybeRunDailyDeduplicationV4_(); }
    catch (error) {
      try { writeLog_("DEDUP V4 SCHEDULER ERROR", DEDUPLICATION_V4_VERSION, String(error && error.stack || error)); }
      catch (ignored) {}
    }
    return result;
  };
  wrappedSyncInventory._dedupeV4Scheduler = true;
  syncInventoryModule = wrappedSyncInventory;
  return DEDUPLICATION_V4_VERSION;
}

var DEDUPLICATION_V4_SCHEDULER_INSTALLED = installDeduplicationSchedulerV4_();
