/**
 * Runtime compatibility helpers for GmailPipelineV2.gs.
 * Keep v2 audit/error logging on the existing PIPELINE LOG implementation.
 */

/* eslint-disable no-unused-vars */

var GMAIL_V2_RUNTIME_VERSION = "2026-08-10-logger-v1";

function writeLog_(event, subject, detail) {
  return logPipeline_(event, subject, detail);
}
