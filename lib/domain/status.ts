export type LogisticsStatus =
  | "Scheduled"
  | "Schedule Requested"
  | "Picked Up/Shipped"
  | "In Transit"
  | "In Transit/Stopover"
  | "Work in Progress"
  | "Pending"
  | "Shipping"
  | "Shipped"
  | "Delivered"
  | "Received"
  | "Cancelled"
  | "Completed"
  | "N/A"
  | "Customs Clearance"
  | "FDA Review / Hold"
  | "FWS Review / Hold"
  | "FDA Detained"
  | "AQI Examination"
  | "Delayed";

const aliases = new Map<string, LogisticsStatus>([
  ["SCHEDULED", "Scheduled"],
  ["SCHEDULE REQUESTED", "Schedule Requested"],
  ["READY", "Scheduled"],
  ["ROUTED/BOOKED", "Scheduled"],
  ["PICKED UP", "Picked Up/Shipped"],
  ["PICKED UP/SHIPPED", "Picked Up/Shipped"],
  ["WORK IN PROGRESS", "Work in Progress"],
  ["WIP", "Work in Progress"],
  ["PENDING", "Pending"],
  ["SHIPPING", "Shipping"],
  ["IN TRANSIT", "In Transit"],
  ["ARRIVED AT INTERIM", "In Transit/Stopover"],
  ["IN TRANSIT/STOPOVER", "In Transit/Stopover"],
  ["SHIPPED", "Shipped"],
  ["DELIVERED", "Delivered"],
  ["RECEIVED", "Received"],
  ["CANCELLED", "Cancelled"],
  ["CANCELED", "Cancelled"],
  ["COMPLETED", "Completed"],
  ["N/A", "N/A"],
  ["CUSTOMS CLEARANCE", "Customs Clearance"],
  ["FDA HOLD", "FDA Review / Hold"],
  ["FDA REVIEW", "FDA Review / Hold"],
  ["FDA REVIEW/HOLD", "FDA Review / Hold"],
  ["FDA REVIEW / HOLD", "FDA Review / Hold"],
  ["FWS HOLD", "FWS Review / Hold"],
  ["FWS REVIEW", "FWS Review / Hold"],
  ["FWS REVIEW/HOLD", "FWS Review / Hold"],
  ["FWS REVIEW / HOLD", "FWS Review / Hold"],
  ["FDA DETAINED", "FDA Detained"],
  ["AQI EXAMINATION", "AQI Examination"],
  ["DELAYED", "Delayed"],
]);

const terminal = new Set<LogisticsStatus>([
  "Received",
  "Cancelled",
  "Completed",
]);

export function normalizeLogisticsStatus(value: unknown): LogisticsStatus | "" {
  const key = String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return aliases.get(key) ?? "";
}

export function isTerminalLogisticsStatus(value: unknown) {
  const normalized = normalizeLogisticsStatus(value);
  return Boolean(normalized && terminal.has(normalized));
}

export function canAutoTransitionStatus(current: unknown, next: unknown) {
  const from = normalizeLogisticsStatus(current);
  const to = normalizeLogisticsStatus(next);
  if (!to) return false;
  if (!from || from === to) return true;
  return !terminal.has(from);
}

export const LOGISTICS_STATUS_OPTIONS = Array.from(new Set(aliases.values()));
