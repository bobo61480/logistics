/*
 * Compatibility entry point for the already-installed time trigger.
 *
 * Keep the legacy handler name alive while routing execution to the hardened
 * V2 importer. The zz_ filename intentionally sorts after Code.gs in clasp
 * source order so this declaration wins during Apps Script load.
 */
function scanAndImportWmsTruckingOrders() {
  return scanAndImportWmsTruckingOrdersV2();
}
