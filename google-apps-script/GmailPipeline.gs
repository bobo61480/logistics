/**
 * GmailPipeline.gs — shared configuration and logging for GmailIngestionV2.
 *
 * The canonical ingestion implementation lives in GmailPipelineV2.gs.
 * This file intentionally contains no parser, trigger entry point, archive
 * helper, or sheet-upsert logic so there is only one Gmail ingestion path.
 */

/* eslint-disable no-unused-vars */

var GMAIL_PIPELINE = {
  masterId: "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc",
  inboundSheet: "IMPORTS",
  outboundSheet: "WH Trucking Request",
  warehouseDocumentsFolderId: "1YBWV9lXAasRt7JolWxk199dPkGbx60M9",
  importShipmentsFolderId: "1AhGI2qM2pGFXSb406OY6dsOaN8unlGDM",
  outboundShipmentsFolderId: "1i054OYAhOR169cUUSqyRlSEVgboUx0X4",
  labels: {
    processed: "sk-logistics/processed",
    pending: "sk-logistics/pending-verification",
    error: "sk-logistics/error"
  }
};

/**
 * Shared bounded audit logger used by Gmail V2 and related logistics jobs.
 * Logging must never interrupt a production ingestion run.
 */
function logPipeline_(event, subject, detail) {
  try {
    var ss = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);
    var log = ss.getSheetByName("PIPELINE LOG") || ss.insertSheet("PIPELINE LOG");
    if (log.getLastRow() === 0) log.appendRow(["Timestamp", "Event", "Subject", "Detail"]);
    log.appendRow([new Date(), event, subject, detail]);
    if (log.getLastRow() > 2000) log.deleteRows(2, 500);
  } catch (e) { /* logging must never break the pipeline */ }
}
