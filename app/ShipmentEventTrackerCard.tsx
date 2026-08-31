"use client";

/**
 * The former Tracked Shipment Updates panel duplicated the live Gmail ingestion
 * feed with a manually-curated snapshot frozen on 2026-08-22. Keeping a second
 * operational truth on the page allowed already-resolved shipments to remain
 * visible as active exceptions.
 *
 * GmailIngestionCard is now the single live reconciliation surface. This
 * compatibility component intentionally renders nothing until the parent page
 * removes the legacy mount in a later layout-only cleanup.
 */
export default function ShipmentEventTrackerCard() {
  return null;
}
