"use client";

/**
 * Compatibility shim retained temporarily so older page variants can import the
 * component without rendering a second shipment-event data source.
 *
 * The former implementation embedded a hand-curated August 2026 exception list
 * directly in the client bundle. Current shipment exceptions and Gmail review
 * events are supplied by the canonical Worker/D1 snapshot and rendered by
 * GmailIngestionCard, so duplicating those facts here would become stale by
 * design.
 */
export default function ShipmentEventTrackerCard() {
  return null;
}
