"use client";

import type { GmailIngestionEvent } from "./gmail-ingestion-card";

function receivedAtLabel(timestamp: string) {
  const date = new Date(timestamp);
  if (!timestamp || Number.isNaN(date.getTime())) return "Time not recorded";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function archiveLocation(event: GmailIngestionEvent) {
  if (event.archiveFolderPath) return event.archiveFolderPath;
  const category = event.kind === "outbound" ? "Outbound Shipments" : "Import Shipments";
  return `Warehouse Documents / ${category}`;
}

/** Uses the dashboard's shared ingestion snapshot; this component makes no extra request. */
export function IngestionRoadmapCard({ events }: { events: GmailIngestionEvent[] | null }) {
  const documentEvents = (events ?? []).filter(
    (event) => event.driveFileUrl || (event.documentNames?.length ?? 0) > 0,
  ).slice(0, 10);

  return (
    <section className="roadmap-panel" aria-labelledby="ingestion-roadmap-heading">
      <div className="panel-heading roadmap-heading">
        <div>
          <p className="eyebrow">Production automation · 15-minute polling</p>
          <h2 id="ingestion-roadmap-heading">Gmail Shipping-Doc Ingestion</h2>
        </div>
        <span className="status-tag">Connected</span>
      </div>

      <div className="roadmap-inbox">
        <span className="roadmap-inbox-icon" aria-hidden="true">
          ✉
        </span>
        <div>
          <div className="roadmap-inbox-addr">alex@stylekoreanus.com</div>
          <div className="roadmap-inbox-note">
            The authorized logistics mailbox receives carrier and broker notices and supported
            shipping documents.
          </div>
        </div>
        <span className="status-tag roadmap-inbox-status">Gmail connected</span>
      </div>

      <div className="pipe-row">
        <div className="pipe-node">
          <div className="pipe-eyebrow">1 · Receive</div>
          <div className="pipe-title">Incoming Email</div>
          <p className="pipe-desc">
            A bounded Gmail search runs every 15 minutes for recent logistics messages and
            processes each message once.
          </p>
        </div>
        <div className="pipe-arrow" aria-hidden="true">
          →
        </div>
        <div className="pipe-node">
          <div className="pipe-eyebrow">2 · Parse</div>
          <div className="pipe-title">Classify &amp; Extract</div>
          <p className="pipe-desc">
            Supported documents and message bodies are inspected for PO, container, invoice,
            BOL, and tracking identifiers, then matched to a source shipment.
          </p>
        </div>
        <div className="pipe-arrow" aria-hidden="true">
          →
        </div>
        <div className="pipe-node">
          <div className="pipe-eyebrow">3 · File &amp; Update</div>
          <div className="pipe-title">Drive + Schedule</div>
          <p className="pipe-desc">
            Archive inbound attachments in Warehouse Documents, commit unambiguous matches, and
            send uncertain or conflicting records to Pending Verification.
          </p>
        </div>
      </div>

      <div className="border-t border-neutral-200 px-4 py-4">
        <h3 className="text-sm font-extrabold text-neutral-900">Recently Received Documents</h3>
        {documentEvents.length === 0 ? (
          <p className="mt-2 text-xs text-neutral-500">No archived documents are listed in the current ingestion history.</p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
            {documentEvents.map((event, index) => (
              <li key={`${event.timestamp}-${event.shipmentId}-${index}`} className="grid gap-2 px-3 py-3 text-xs sm:grid-cols-[1fr_12rem_1.4fr]">
                <div>
                  <span className="block font-semibold uppercase tracking-wide text-neutral-400">Documents received</span>
                  <span className="mt-0.5 block font-medium text-neutral-900">
                    {event.documentNames?.length ? event.documentNames.join(", ") : "Shipping documents"}
                  </span>
                </div>
                <div>
                  <span className="block font-semibold uppercase tracking-wide text-neutral-400">Received</span>
                  <span className="mt-0.5 block text-neutral-700">{receivedAtLabel(event.timestamp)}</span>
                </div>
                <div>
                  <span className="block font-semibold uppercase tracking-wide text-neutral-400">Uploaded to</span>
                  {event.driveFileUrl ? (
                    <a className="mt-0.5 block font-medium text-blue-700 hover:underline" href={event.driveFileUrl} target="_blank" rel="noreferrer">
                      📁 {archiveLocation(event)} ↗
                    </a>
                  ) : (
                    <span className="mt-0.5 block text-neutral-700">{archiveLocation(event)}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
