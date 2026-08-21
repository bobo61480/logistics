/*
 * Canonical operational status vocabulary shared by Gmail, tracking, manual
 * writeback, and strict Google Sheets validation.
 */
var LOGISTICS_STATUS_VOCABULARY_VERSION = "2026-08-12-v1";

var LOGISTICS_STATUS_ALIASES_ = {
  "SCHEDULED": "Scheduled",
  "READY": "Scheduled",
  "ROUTED/BOOKED": "Scheduled",
  "PICKED UP": "Scheduled",
  "WORK IN PROGRESS": "Work in Progress",
  "WIP": "Work in Progress",
  "PENDING": "Pending",
  "SHIPPING": "Shipping",
  "IN TRANSIT": "Shipping",
  "SHIPPED": "Shipped",
  "DELIVERED": "Delivered",
  "RECEIVED": "Received",
  "CANCELLED": "Cancelled",
  "CANCELED": "Cancelled",
  "COMPLETED": "Completed",
  "CUSTOMS CLEARANCE": "Customs Clearance",
  "FDA HOLD": "FDA Review / Hold",
  "FDA REVIEW": "FDA Review / Hold",
  "FDA REVIEW/HOLD": "FDA Review / Hold",
  "FDA REVIEW / HOLD": "FDA Review / Hold",
  "RECEIVED/FDA HOLD/REVIEW": "RECEIVED/FDA HOLD/REVIEW",
  "FDA DETAINED": "FDA Detained",
  "FWS HOLD": "FWS Review / Hold",
  "FWS REVIEW": "FWS Review / Hold",
  "FWS REVIEW/HOLD": "FWS Review / Hold",
  "FWS REVIEW / HOLD": "FWS Review / Hold",
  "AQI EXAMINATION": "AQI Examination",
  "DELAYED": "Delayed"
};

function canonicalLogisticsStatus_(value) {
  var key = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
  return LOGISTICS_STATUS_ALIASES_[key] || "";
}

function isTerminalLogisticsStatus_(value) {
  var status = canonicalLogisticsStatus_(value);
  return /^(Shipped|Delivered|Received|Cancelled|Completed)$/.test(status);
}

function canAutoTransitionLogisticsStatus_(current, next) {
  var from = canonicalLogisticsStatus_(current);
  var to = canonicalLogisticsStatus_(next);
  if (!to) return false;
  if (!from || from === to) return true;
  if (isTerminalLogisticsStatus_(from)) return false;
  return true;
}
