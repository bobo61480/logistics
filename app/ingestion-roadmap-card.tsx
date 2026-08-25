"use client";

/**
 * Static explanation of the production Gmail V2 document pipeline. Live run
 * results are rendered separately by gmail-ingestion-card.tsx from the shared
 * Worker snapshot; this card intentionally makes no additional request.
 */
export function IngestionRoadmapCard() {
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

      <p className="panel-note roadmap-note">
        The production pipeline uses Apps Script and deterministic extraction rather than an AI
        document classifier. The Shipment Notices feed above shows its committed and review
        events from the same Worker snapshot; this card describes the flow without launching a
        second ingestion pipeline.
      </p>
    </section>
  );
}
