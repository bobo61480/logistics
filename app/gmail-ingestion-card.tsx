"use client";

import { useEffect, useState } from "react";

type IngestionStatus = "committed" | "needsReview" | "approved" | "rejected";

interface GmailIngestionEvent {
  status: IngestionStatus;
  kind: "inbound" | "outbound" | "";
  shipmentId: string;
  customer: string;
  invoice: string;
  blOrPro: string;
  container: string;
  shipDateOrEta: string;
  carrierOrVessel: string;
  note: string;
  issues: string;
  sourceEmailUrl: string;
  driveFileUrl: string;
  timestamp: string;
}

const STATUS_STYLE: Record<IngestionStatus, string> = {
  committed: "bg-blue-50 text-blue-700 ring-blue-200",
  needsReview: "bg-amber-50 text-amber-700 ring-amber-200",
  approved: "bg-green-50 text-green-700 ring-green-200",
  rejected: "bg-red-50 text-red-700 ring-red-200",
};

const STATUS_LABEL: Record<IngestionStatus, string> = {
  committed: "Auto-committed",
  needsReview: "Needs review",
  approved: "Approved",
  rejected: "Rejected",
};

/**
 * Reads `sources.gmailIngestion` off the existing /api/logistics/snapshot
 * response — see worker/sources.patch.md for the backend side. No separate
 * API call, no new fetch cadence: this rides the dashboard's normal refresh.
 */
export function GmailIngestionCard({ snapshotUrl = "/api/logistics/snapshot" }: { snapshotUrl?: string }) {
  const [events, setEvents] = useState<GmailIngestionEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | IngestionStatus>("all");

  useEffect(() => {
    let cancelled = false;
    fetch(snapshotUrl)
      .then((res) => res.json() as Promise<{ sources?: { gmailIngestion?: GmailIngestionEvent[] } }>)
      .then((payload) => {
        if (cancelled) return;
        const list: GmailIngestionEvent[] = payload?.sources?.gmailIngestion ?? [];
        setEvents(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [snapshotUrl]);

  const filtered = (events ?? []).filter((e) => filter === "all" || e.status === filter);
  const counts = (events ?? []).reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <section className="rounded-xl border border-neutral-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900">Gmail Ingestion</h3>
          <p className="text-xs text-neutral-500">
            What the email pipeline extracted, and which shipment it landed on.
          </p>
        </div>
        <div className="flex gap-1 text-xs">
          {(["all", "needsReview", "committed", "approved", "rejected"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`rounded-full px-2.5 py-1 ring-1 transition ${
                filter === key
                  ? "bg-neutral-900 text-white ring-neutral-900"
                  : "bg-neutral-50 text-neutral-600 ring-neutral-200 hover:bg-neutral-100"
              }`}
            >
              {key === "all" ? "All" : STATUS_LABEL[key]}
              {key !== "all" && counts[key] ? ` (${counts[key]})` : ""}
            </button>
          ))}
        </div>
      </header>

      <div className="max-h-96 overflow-y-auto">
        {error && <p className="px-5 py-4 text-sm text-red-600">Could not load ingestion feed: {error}</p>}
        {!error && events === null && <p className="px-5 py-4 text-sm text-neutral-500">Loading…</p>}
        {!error && events !== null && filtered.length === 0 && (
          <p className="px-5 py-6 text-sm text-neutral-500">Nothing in this category right now.</p>
        )}
        <ul className="divide-y divide-neutral-100">
          {filtered.map((event, i) => (
            <li key={i} className="px-5 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${STATUS_STYLE[event.status]}`}>
                    {STATUS_LABEL[event.status]}
                  </span>
                  {event.kind && (
                    <span className="text-xs uppercase tracking-wide text-neutral-400">{event.kind}</span>
                  )}
                  <span className="font-medium text-neutral-900">
                    {event.shipmentId || event.customer || "Unidentified shipment"}
                  </span>
                </div>
                {event.timestamp && <span className="text-xs text-neutral-400">{event.timestamp}</span>}
              </div>

              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-neutral-500">
                {event.customer && <span>Customer: {event.customer}</span>}
                {event.blOrPro && <span>BL/PRO: {event.blOrPro}</span>}
                {event.container && <span>Container: {event.container}</span>}
                {event.shipDateOrEta && <span>ETA/Ship date: {event.shipDateOrEta}</span>}
                {event.carrierOrVessel && <span>Carrier/Vessel: {event.carrierOrVessel}</span>}
              </div>

              {event.issues && <p className="mt-1 text-xs text-amber-700">{event.issues}</p>}
              {event.note && <p className="mt-1 text-xs text-neutral-400">{event.note}</p>}

              <div className="mt-1 flex gap-3 text-xs">
                {event.sourceEmailUrl && (
                  <a href={event.sourceEmailUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                    Source email
                  </a>
                )}
                {event.driveFileUrl && (
                  <a href={event.driveFileUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                    Archived file
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
