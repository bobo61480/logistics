"use client";

import { useMemo } from "react";
import type { GmailIngestionEvent } from "./gmail-ingestion-card";
import type { ScheduleItem } from "./page";

/**
 * Tracked Shipment Updates — email → canonical sheet reconciliation.
 *
 * A predecessor of this panel shipped a hand-curated list frozen on
 * 2026-08-22 and was removed by the 2026-08-31 production audit: a second,
 * static operational truth kept already-resolved shipments on screen as live
 * exceptions. This rebuild keeps that layout but derives every value from the
 * D1 snapshot the rest of the page already loaded:
 *
 *   - the events are `sources.gmailIngestion` (the live PENDING VERIFICATION
 *     feed), not a checked-in array;
 *   - the "reviewed through" date is the snapshot's own generation time;
 *   - each row's source sheet and row number are resolved by matching the
 *     event's identifiers against the live schedule items, so a link always
 *     points at the row that currently holds the shipment — and an event that
 *     matches nothing is reported as missing rather than silently dropped;
 *   - the continuity banner appears only while the snapshot is actually stale.
 *
 * It therefore cannot disagree with the rest of the dashboard, and it goes
 * empty on its own as operators clear the feed.
 */

type Priority = "urgent" | "high" | "monitor";

const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  monitor: "Monitor",
};

const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, monitor: 2 };

/** Holds and cancellations block the shipment until someone acts. */
const URGENT_PATTERN = /\b(CANCELL?ED|ON HOLD|FDA REVIEW|FDA HOLD|FWS REVIEW|FWS HOLD|REVIEW\/HOLD|DO NOT (DISTRIBUTE|SHIP|INCLUDE)|CUSTOMS CLEARANCE|DETAINED|EXAM)\b/;
/** State changes an operator still has to reflect in the workbook. */
const HIGH_PATTERN = /\b(RELEASED|CLEARED|DELIVERED|RESCHEDULED|RESCHEDULE|PICKUP|MOVED TO|NEW ETA|ETA CHANGED|ARRIVED)\b/;

const MAX_ROWS = 24;

function normalizeId(value: unknown) {
  return String(value ?? "").trim().replace(/[\s-]+/g, "").toUpperCase();
}

export function priorityFor(event: GmailIngestionEvent, matched: boolean): Priority {
  const haystack = `${event.note} ${event.issues} ${event.status}`.toUpperCase();
  if (URGENT_PATTERN.test(haystack)) return "urgent";
  // An event nobody can file is actionable even when its wording is calm.
  if (event.status === "needsReview" && !matched) return "urgent";
  if (event.status === "needsReview" || HIGH_PATTERN.test(haystack)) return "high";
  return "monitor";
}

/**
 * Index every identifier a schedule row can be recognized by. Later rows do not
 * overwrite earlier ones: a duplicated identifier is ambiguous, so the match is
 * dropped rather than guessed at (`null`), and the event is reported as missing.
 */
export function buildRowIndex(items: ScheduleItem[]) {
  const index = new Map<string, ScheduleItem | null>();
  for (const item of items) {
    for (const raw of [item.container, item.invoice, item.mbl, item.hbl, item.pro, item.po, item.shipmentNo]) {
      const key = normalizeId(raw);
      if (!key || key.length < 4) continue;
      index.set(key, index.has(key) && index.get(key) !== item ? null : item);
    }
  }
  return index;
}

export function matchItem(index: Map<string, ScheduleItem | null>, event: GmailIngestionEvent) {
  for (const raw of [event.container, event.blOrPro, event.invoice, event.shipmentId]) {
    const key = normalizeId(raw);
    if (!key || key.length < 4) continue;
    const found = index.get(key);
    if (found) return found;
  }
  return null;
}

export function identifiers(event: GmailIngestionEvent) {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of [event.shipmentId, event.container, event.blOrPro, event.invoice, event.customer]) {
    const value = String(raw ?? "").trim();
    const key = normalizeId(value);
    if (!value || !key || seen.has(key)) continue;
    seen.add(key);
    parts.push(value);
    if (parts.length === 2) break;
  }
  return parts.length ? parts : ["Unidentified shipment"];
}

/**
 * The one-line headline. The pipeline writes "Received: …" / "Changed: …"
 * notes; anything else falls back to the issues text so a row is never blank.
 */
export function headline(event: GmailIngestionEvent) {
  const note = event.note.replace(/^(Received|Changed):\s*/i, "").trim();
  const primary = note || event.issues.trim();
  if (!primary) return event.status === "needsReview" ? "Routed for review" : "Update recorded";
  const [first] = primary.split(/(?<=\.)\s+/);
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

/**
 * The supporting line. `shown` is the headline already rendered above: when the
 * headline fell back to the issues text there is nothing left to repeat, so the
 * issue is dropped here rather than printed twice.
 */
export function detail(event: GmailIngestionEvent, shown: string) {
  const facts = [
    event.shipDateOrEta && `ETA/Ship ${event.shipDateOrEta}`,
    event.carrierOrVessel && `Carrier ${event.carrierOrVessel}`,
    event.customer && `Customer ${event.customer}`,
  ].filter(Boolean).join(" · ");
  const issues = event.issues.trim();
  if (issues && !shown.includes(issues) && !issues.includes(shown)) {
    return facts ? `${issues} — ${facts}` : issues;
  }
  return facts;
}

function reviewedThrough(generatedAt: string | null) {
  if (!generatedAt) return null;
  const parsed = Date.parse(generatedAt);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  }).format(parsed);
}

export function TrackedShipmentUpdatesCard({
  events,
  items,
  loading = false,
  generatedAt = null,
  stale = false,
  staleReason,
  sheetUrl,
}: {
  /** `sources.gmailIngestion` — null while loading or when the feed is degraded. */
  events: GmailIngestionEvent[] | null;
  /** Live schedule rows, used to resolve each event's canonical sheet + row. */
  items: ScheduleItem[];
  loading?: boolean;
  /** Snapshot generation time — the real "reviewed through" moment. */
  generatedAt?: string | null;
  stale?: boolean;
  staleReason?: string;
  sheetUrl?: string;
}) {
  const rows = useMemo(() => {
    if (!events) return [];
    const index = buildRowIndex(items);
    return events
      .map((event) => {
        const item = matchItem(index, event);
        return { event, item, priority: priorityFor(event, Boolean(item)) };
      })
      // Resolved history is not an exception; keep the panel to what still
      // needs a decision or a workbook edit.
      .filter((row) => row.event.status !== "rejected" && (row.priority !== "monitor" || !row.item))
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }, [events, items]);

  const urgentCount = rows.filter((row) => row.priority === "urgent").length;
  const missingCount = rows.filter((row) => !row.item).length;
  const visible = rows.slice(0, MAX_ROWS);
  const reviewed = reviewedThrough(generatedAt);
  const unavailable = !loading && events === null;

  return (
    <section className="tracked-updates-panel" aria-labelledby="tracked-updates-heading">
      <div className="panel-heading tracked-updates-heading">
        <div>
          <p className="eyebrow">Email → Canonical Sheet Reconciliation</p>
          <h2 id="tracked-updates-heading">Tracked Shipment Updates</h2>
          <p className="tracked-updates-sub">
            {unavailable
              ? "Feed unavailable — check the sync strip and source health for the degraded source."
              : loading && events === null
                ? "Loading the reconciliation feed…"
                : rows.length === 0
                  ? "Every tracked email update is reconciled against its source row. Nothing to resolve."
                  : `Unmatched and open events${reviewed ? ` reviewed through ${reviewed}` : ""}. Resolve the urgent items first.`}
          </p>
        </div>
        {rows.length > 0 && (
          <div className="tracked-updates-counts">
            {urgentCount > 0 && <span className="tracked-count urgent">{urgentCount} urgent</span>}
            {missingCount > 0 && <span className="tracked-count missing">{missingCount} missing</span>}
            <span className="tracked-count total">{rows.length} tracked</span>
          </div>
        )}
      </div>

      {stale && rows.length > 0 && (
        <p className="tracked-updates-alert" role="status">
          This feed comes from the last verified D1 snapshot while the Worker refreshes it, so some
          of these may already be resolved. Re-check each row against the <strong>source sheet</strong>{" "}
          before acting on it.{staleReason ? ` ${staleReason}` : ""}
        </p>
      )}

      {visible.length > 0 && (
        <ul className="tracked-updates-grid">
          {visible.map(({ event, item, priority }, position) => (
            <li key={`${event.sourceEmailUrl || event.shipmentId}-${position}`} className="tracked-update">
              <div className="tracked-update-top">
                <p className="tracked-update-id">
                  {identifiers(event).map((value, i) => (
                    <span key={value}>
                      {i > 0 && <span className="tracked-update-sep"> · </span>}
                      {value}
                    </span>
                  ))}
                </p>
                <span className={`tracked-priority ${priority}`}>{PRIORITY_LABEL[priority]}</span>
              </div>

              {(() => {
                const summary = headline(event);
                const supporting = detail(event, summary);
                return (
                  <>
                    <p className={`tracked-update-headline ${priority}`}>{summary}</p>
                    {supporting && <p className="tracked-update-detail">{supporting}</p>}
                  </>
                );
              })()}

              <div className="tracked-update-foot">
                <span className={item ? "tracked-update-state" : "tracked-update-state missing"}>
                  {item ? "Needs re-verification" : "No matching source row"}
                </span>
                {item ? (
                  <a
                    className="tracked-update-source"
                    href={item.sourceUrl ?? sheetUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.sourceSheet} · row {item.sourceRow} <span aria-hidden="true">↗</span>
                  </a>
                ) : event.sourceEmailUrl ? (
                  <a className="tracked-update-source" href={event.sourceEmailUrl} target="_blank" rel="noreferrer">
                    Source email <span aria-hidden="true">↗</span>
                  </a>
                ) : (
                  <span className="tracked-update-source muted">No source link</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {rows.length > visible.length && (
        <p className="panel-note tracked-updates-note">
          Showing the {visible.length} highest-priority of {rows.length} open events.{" "}
          {sheetUrl && (
            <a href={sheetUrl} target="_blank" rel="noreferrer">
              Review the rest in the PENDING VERIFICATION sheet ↗
            </a>
          )}
        </p>
      )}
    </section>
  );
}

export default TrackedShipmentUpdatesCard;
