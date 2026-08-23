"use client";

/**
 * Static design placeholder for a proposed future pipeline — parsing BOL/
 * invoice/POD/entry-summary email attachments and filing them into Drive +
 * the matching schedule row. This is NOT the existing Shipment Notices
 * pipeline (which extracts shipment status/date info from email bodies,
 * already built and real — see gmail-ingestion-card.tsx). Nothing here
 * fetches, calls a Worker, or reads live data; every label says so.
 */
export function IngestionRoadmapCard() {
  return (
    <section className="roadmap-panel" aria-labelledby="ingestion-roadmap-heading">
      <div className="panel-heading roadmap-heading">
        <div>
          <p className="eyebrow">Roadmap · Design Placeholder</p>
          <h2 id="ingestion-roadmap-heading">Gmail Shipping-Doc Ingestion</h2>
        </div>
        <span className="status-tag proposed">Not built yet</span>
      </div>

      <div className="roadmap-inbox">
        <span className="roadmap-inbox-icon" aria-hidden="true">
          ✉
        </span>
        <div>
          <div className="roadmap-inbox-addr">shipping-docs@stylekoreanus.com</div>
          <div className="roadmap-inbox-note">
            A dedicated inbox would receive BOLs, invoices, PODs, and entry summaries from
            carriers &amp; brokers.
          </div>
        </div>
        <span className="status-tag proposed roadmap-inbox-status">Not connected</span>
      </div>

      <div className="pipe-row">
        <div className="pipe-node">
          <div className="pipe-eyebrow">1 · Receive</div>
          <div className="pipe-title">Incoming Email</div>
          <p className="pipe-desc">
            Gmail push notification (or polling) fires when a carrier/broker email with an
            attachment lands.
          </p>
        </div>
        <div className="pipe-arrow" aria-hidden="true">
          →
        </div>
        <div className="pipe-node">
          <div className="pipe-eyebrow">2 · Parse</div>
          <div className="pipe-title">Classify &amp; Extract</div>
          <p className="pipe-desc">
            Detect document type (BOL, Invoice, POD, Entry Summary), extract PO# / container# /
            tracking#, match it to a shipment.
          </p>
        </div>
        <div className="pipe-arrow" aria-hidden="true">
          →
        </div>
        <div className="pipe-node">
          <div className="pipe-eyebrow">3 · File &amp; Update</div>
          <div className="pipe-title">Drive + Schedule</div>
          <p className="pipe-desc">
            File the document into its Warehouse Documents folder, and push the extracted
            identifiers and status into the matching Import or Outbound schedule row.
          </p>
        </div>
      </div>

      <p className="panel-note roadmap-note">
        Design placeholder only — there is no Gmail connection, parser, or classifier behind this
        yet. Building it would need a Gmail API integration, a document classifier, and a write
        path into both Drive and the source Google Sheet. This is separate from the real,
        already-built &quot;Shipment Notices&quot; feed above, which extracts status/date changes
        from email bodies rather than parsing document attachments.
      </p>
    </section>
  );
}
