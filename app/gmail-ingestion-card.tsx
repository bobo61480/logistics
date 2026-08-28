"use client";

type IngestionStatus = "committed" | "needsReview" | "approved" | "rejected";

export interface GmailIngestionEvent {
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
  sender?: string;
  documentNames?: string[];
  archiveFolderPath?: string;
  // Present only while status === "needsReview" and the row has a usable
  // identifier. Sent back verbatim on approve/reject; the backend refuses to
  // act on it if the identifier no longer resolves to exactly one open row.
  reviewKey?: string;
}

/**
 * Renders the `sources.gmailIngestion` feed from the dashboard's own
 * /api/logistics/snapshot load. The page passes the feed down on every
 * 30-minute refresh, so this card issues no fetches of its own — no duplicate
 * snapshot requests, and it can never disagree with the rest of the page.
 * `events` is null while loading or when the Worker snapshot is unavailable
 * (e.g. the dashboard fell back to direct Sheets, which carries no feed).
 */
export function GmailIngestionCard({
  events,
  loading = false,
  onReview,
  reviewingKey = "",
  sheetUrl,
}: {
  events: GmailIngestionEvent[] | null;
  loading?: boolean;
  /** Omit to render the feed read-only (no Approve/Reject buttons). */
  onReview?: (event: GmailIngestionEvent, decision: "approve" | "reject") => void;
  /** reviewKey of the row currently mid-request, so only that row disables. */
  reviewingKey?: string;
  /** Master workbook URL — links the ambiguous-match shortcut to the PENDING VERIFICATION tab. */
  sheetUrl?: string;
}) {
  const unavailable = !loading && events === null;

  return (
    <section className="hct-card rounded-xl border border-neutral-200 bg-white shadow-sm">
      <header className="hct-card-header flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-5 py-4">
        <div>
          <h3 className="text-lg font-extrabold text-neutral-900">Shipment Notices</h3>
          <p className="text-xs text-neutral-500">
            New shipment notices and changes extracted from incoming email, plus anything routed for review.
          </p>
        </div>
      </header>

      <div className="hct-card-body max-h-96 overflow-y-auto">
        {unavailable && (
          <p className="px-5 py-4 text-sm text-red-600">
            {/* null covers several causes (PENDING VERIFICATION read failed, the
                dashboard is on its direct-Sheets fallback, or the deployed Worker
                predates the feed) — stay generic so operators aren't pointed at
                the wrong subsystem. */}
            Ingestion feed unavailable right now — the rest of the dashboard is unaffected. Check
            the sync strip and source health for the degraded source.
          </p>
        )}
        {loading && events === null && <p className="px-5 py-4 text-sm text-neutral-500">Loading…</p>}
        {!unavailable && events !== null && events.length === 0 && (
          <p className="px-5 py-6 text-sm text-neutral-500">No shipment notices right now.</p>
        )}
        <ul className="divide-y divide-neutral-100">
          {(events ?? []).map((event, i) => (
            <li key={i} className="px-5 py-3 text-sm">
              <dl className="grid gap-1.5 sm:grid-cols-[8rem_1fr]">
                <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Sender</dt>
                <dd className="text-neutral-800">{event.sender || "Sender unavailable"}</dd>
                <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Shipment</dt>
                <dd className="font-medium text-neutral-900">
                  {event.shipmentId || event.customer || "Shipment reference unavailable"}
                  {event.status === "needsReview" && (
                    <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                      Needs review
                    </span>
                  )}
                </dd>
                <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Main point</dt>
                <dd className="text-neutral-700">{event.note || "Shipment notice received"}</dd>
                {event.issues && (
                  <>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Issue</dt>
                    <dd className="text-amber-700">{event.issues}</dd>
                  </>
                )}
              </dl>

              {onReview && event.status === "needsReview" && (
                <div className="mt-2 flex items-center gap-2">
                  {event.reviewKey ? (
                    <>
                      <button
                        type="button"
                        disabled={reviewingKey === event.reviewKey}
                        onClick={() => onReview(event, "approve")}
                        className="rounded-md bg-green-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {reviewingKey === event.reviewKey ? "Working…" : "Approve"}
                      </button>
                      <button
                        type="button"
                        disabled={reviewingKey === event.reviewKey}
                        onClick={() => onReview(event, "reject")}
                        className="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-red-700 ring-1 ring-red-200 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </>
                  ) : sheetUrl ? (
                    <a
                      href={sheetUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-medium text-amber-700 hover:underline"
                    >
                      No unique identifier — resolve directly in the PENDING VERIFICATION sheet ↗
                    </a>
                  ) : (
                    <span className="text-xs text-neutral-400">
                      No unique identifier — resolve directly in the PENDING VERIFICATION sheet.
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
