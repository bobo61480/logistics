"use client";

type EventPriority = "urgent" | "high" | "medium" | "review";
type SyncState = "missing" | "stale" | "pending";

type TrackedShipmentEvent = {
  priority: EventPriority;
  shipment: string;
  event: string;
  syncState: SyncState;
  sheet: string;
  row?: number;
  updateNote: string;
};

const MASTER_SHEET =
  "https://docs.google.com/spreadsheets/d/1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc/edit";

// This card is a manually-curated snapshot, not a live read of the Worker snapshot — it does not
// reconcile itself on the 30-minute auto-refresh. Past REVIEWED_THROUGH, treat every fact below as
// unverified rather than silently keep reporting Aug 21-22 exceptions as still current.
const REVIEWED_THROUGH = new Date("2026-08-22T23:59:59-07:00");

const TRACKED_EVENTS: TrackedShipmentEvent[] = [
  {
    priority: "urgent",
    shipment: "PO 3385172828 · RXO 23921870",
    event: "Cancelled 08/21 · remaining 2 pallets / 144 units",
    syncState: "missing",
    sheet: "NATIONAL ORDER PROGRESS",
    updateNote: "CANCELLED 08/21/26 — Do not include in the outbound schedule.",
  },
  {
    priority: "urgent",
    shipment: "HJ80 · SMCU1040159",
    event: "Customs clear · FDA review remains open",
    syncState: "pending",
    sheet: "IMPORTS",
    row: 247,
    updateNote: "FDA REVIEW/HOLD — Do not distribute or sell until KCC confirms release.",
  },
  {
    priority: "urgent",
    shipment: "HJ87 · CAIU9899012",
    event: "Customs clear · FDA review remains open",
    syncState: "pending",
    sheet: "IMPORTS",
    row: 257,
    updateNote: "FDA REVIEW/HOLD — Keep excluded from available inbound inventory.",
  },
  {
    priority: "high",
    shipment: "HJ79 · SMCU1297548",
    event: "FDA released 08/21 · ETA 08/23",
    syncState: "stale",
    sheet: "IMPORTS",
    row: 246,
    updateNote: "FDA RELEASED 08/21/26; customs clear; ready for delivery scheduling.",
  },
  {
    priority: "high",
    shipment: "HJ86 · SMCU1030736",
    event: "FDA released 08/21 · ETA 08/23",
    syncState: "stale",
    sheet: "IMPORTS",
    row: 255,
    updateNote: "FDA RELEASED 08/21/26; customs clear; ready for delivery scheduling.",
  },
  {
    priority: "high",
    shipment: "ER32 · FFAU7805545",
    event: "FDA released 08/21 · ETA 08/23",
    syncState: "stale",
    sheet: "IMPORTS",
    row: 261,
    updateNote: "FDA RELEASED 08/21/26; customs clear; ready for delivery scheduling.",
  },
  {
    priority: "high",
    shipment: "ER33 · KOCU4842636",
    event: "FDA released 08/21 · ETA 08/24",
    syncState: "stale",
    sheet: "IMPORTS",
    row: 262,
    updateNote: "FDA RELEASED 08/21/26; customs clear; filing LAOI26150114.",
  },
  {
    priority: "high",
    shipment: "ES20 · UETU5917057",
    event: "Pickup 08/25 2:00 PM · delivery ETA 3:00 PM",
    syncState: "stale",
    sheet: "IMPORTS",
    row: 230,
    updateNote: "KCC pickup 08/25/26 2:00 PM; delivery ETA 3:00 PM; customs/FDA clear.",
  },
  {
    priority: "high",
    shipment: "ES26 · CAJU5291202",
    event: "Delivery moved to 08/25 3:00 PM",
    syncState: "missing",
    sheet: "IMPORTS",
    row: 236,
    updateNote: "Delivery rescheduled to 08/25/26 at 3:00 PM.",
  },
  {
    priority: "high",
    shipment: "XPO 755-384346 · YAMIBUY NJ",
    event: "Delivered 08/21 · East Brunswick, NJ",
    syncState: "stale",
    sheet: "WH Trucking Request",
    row: 647,
    updateNote: "DELIVERED 08/21/26 — Grey out and remove from the active outbound schedule.",
  },
  {
    priority: "high",
    shipment: "XPO 216-850701",
    event: "Delivered 08/21 · Kansas City, KS",
    syncState: "missing",
    sheet: "WH Trucking Request",
    updateNote: "Locate the source shipment, set Delivered/Completed, and retain the PRO.",
  },
  {
    priority: "high",
    shipment: "XPO 934-473503",
    event: "Delivered 08/21 · Wellford, SC",
    syncState: "missing",
    sheet: "WH Trucking Request",
    updateNote: "Locate the source shipment and close it as Delivered/Completed.",
  },
  {
    priority: "medium",
    shipment: "XPO 216-830294",
    event: "Out for delivery 08/21 · prior delay alert",
    syncState: "missing",
    sheet: "WH Trucking Request",
    updateNote: "OUT FOR DELIVERY 08/21/26 — Oklahoma City, OK; monitor final delivery.",
  },
  {
    priority: "medium",
    shipment: "XPO 755-361854",
    event: "In transit · latest scan Phoenix, AZ",
    syncState: "missing",
    sheet: "WH Trucking Request",
    updateNote: "Picked up 08/21; latest interim scan Phoenix, AZ.",
  },
  {
    priority: "medium",
    shipment: "XPO 755-361821",
    event: "In transit · latest scan Blythe, CA",
    syncState: "missing",
    sheet: "WH Trucking Request",
    updateNote: "Picked up 08/21; latest interim scan Blythe, CA.",
  },
  {
    priority: "medium",
    shipment: "XPO 755-383241",
    event: "In transit · latest scan Indianapolis, IN",
    syncState: "missing",
    sheet: "WH Trucking Request",
    updateNote: "Picked up 08/19; latest interim scan Indianapolis, IN on 08/20.",
  },
  {
    priority: "medium",
    shipment: "XPO 755-353734",
    event: "In transit · latest scan Stanton, TX",
    syncState: "missing",
    sheet: "WH Trucking Request",
    updateNote: "Latest interim scan Stanton, TX on 08/21.",
  },
  {
    priority: "medium",
    shipment: "Daylight invoice 175196021",
    event: "$475.38 billed for IN00465338 · $277.35 variance",
    syncState: "stale",
    sheet: "WH Trucking Request",
    row: 693,
    updateNote: "Record invoice $475.38 separately from quoted rate $752.73; review variance.",
  },
  {
    priority: "review",
    shipment: "All Cartage CS0001112406",
    event: "TMS worksheet requires shipment-detail verification",
    syncState: "pending",
    sheet: "WH Trucking Request",
    updateNote: "Confirm PO/cartons, weight, CFT, pallets, pickup details, and ready date.",
  },
];

const PRIORITY_LABEL: Record<EventPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Monitor",
  review: "Verify",
};

const STATE_LABEL: Record<SyncState, string> = {
  missing: "Missing from sheet",
  stale: "Sheet is stale",
  pending: "Review pending",
};

function sheetUrl(event: TrackedShipmentEvent) {
  if (!event.row) return MASTER_SHEET;
  const gid = event.sheet === "IMPORTS" ? 1497250700 : 1418033635;
  return `${MASTER_SHEET}?gid=${gid}&range=A${event.row}#gid=${gid}&range=A${event.row}`;
}

export default function ShipmentEventTrackerCard() {
  const urgent = TRACKED_EVENTS.filter((event) => event.priority === "urgent").length;
  const missing = TRACKED_EVENTS.filter((event) => event.syncState === "missing").length;
  const expired = Date.now() > REVIEWED_THROUGH.getTime();

  return (
    <section className="shipment-event-card" aria-labelledby="shipment-event-title">
      <style>{`
        .shipment-event-card { margin-top: 18px; overflow: hidden; border: 1px solid #d9c9aa; border-top: 5px solid #d66735; border-radius: 14px; background: #fffdf8; }
        .shipment-event-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 18px 22px 15px; }
        .shipment-event-head h2 { margin: 3px 0 5px; color: #13272d; font: 800 30px/.95 "Saira Condensed", sans-serif; text-transform: uppercase; }
        .shipment-event-head p { margin: 0; color: #6c7a7d; font-size: 11px; }
        .shipment-event-eyebrow { color: #a74720; font: 700 9px "IBM Plex Mono", monospace; letter-spacing: .14em; text-transform: uppercase; }
        .shipment-event-counts { display: flex; gap: 7px; flex-wrap: wrap; justify-content: flex-end; }
        .shipment-event-counts span { padding: 7px 9px; border-radius: 999px; background: #f4eee4; color: #5f5140; font: 700 9px "IBM Plex Mono", monospace; white-space: nowrap; }
        .shipment-event-counts .urgent { background: #ffe4df; color: #9a3427; }
        .shipment-event-expired { margin: 0 22px 18px; padding: 12px 14px; border: 1px solid #e6b98f; border-radius: 8px; background: #fff4e8; color: #7a4a17; font-size: 11px; line-height: 1.5; }
        .shipment-event-expired a { color: #a74720; font-weight: 700; }
        .shipment-event-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; margin: 0; padding: 1px 0 0; list-style: none; background: #e6ddd0; }
        .shipment-event-item { min-width: 0; padding: 13px 16px 14px; background: #fffdf9; }
        .shipment-event-top { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
        .shipment-event-id { overflow: hidden; color: #13272d; font: 800 12px "IBM Plex Mono", monospace; text-overflow: ellipsis; white-space: nowrap; }
        .shipment-event-priority { flex: 0 0 auto; padding: 3px 7px; border-radius: 999px; font: 800 8px "IBM Plex Mono", monospace; letter-spacing: .05em; text-transform: uppercase; }
        .shipment-event-priority.urgent { background: #ffe1dc; color: #a12f24; }
        .shipment-event-priority.high { background: #fff0cc; color: #845d05; }
        .shipment-event-priority.medium { background: #e4eff8; color: #2a648d; }
        .shipment-event-priority.review { background: #eee8f8; color: #65468f; }
        .shipment-event-detail { margin: 7px 0 4px; color: #314a52; font-size: 11px; line-height: 1.45; }
        .shipment-event-note { margin: 0; color: #6c6b65; font-size: 10px; line-height: 1.45; }
        .shipment-event-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
        .shipment-event-state { color: #9a3c28; font: 700 8px "IBM Plex Mono", monospace; text-transform: uppercase; }
        .shipment-event-link { color: #086673; font: 700 9px "IBM Plex Mono", monospace; text-decoration: none; }
        .shipment-event-link:hover { text-decoration: underline; }
        @media (max-width: 760px) {
          .shipment-event-head { flex-direction: column; }
          .shipment-event-counts { justify-content: flex-start; }
          .shipment-event-list { grid-template-columns: 1fr; }
        }

        [data-theme="dark"] .shipment-event-card { border-color: var(--hairline-strong); background: var(--surface); }
        [data-theme="dark"] .shipment-event-head h2 { color: var(--text); }
        [data-theme="dark"] .shipment-event-head p { color: var(--text-faint); }
        [data-theme="dark"] .shipment-event-counts span { background: var(--surface-inset); color: var(--text-soft); }
        [data-theme="dark"] .shipment-event-expired { border-color: var(--hairline-strong); background: rgba(217, 89, 38, .12); color: #ffcf7d; }
        [data-theme="dark"] .shipment-event-expired a { color: var(--accent-outbound); }
        [data-theme="dark"] .shipment-event-list { background: var(--hairline); }
        [data-theme="dark"] .shipment-event-item { background: var(--surface); }
        [data-theme="dark"] .shipment-event-id { color: var(--text); }
        [data-theme="dark"] .shipment-event-detail { color: var(--text-soft); }
        [data-theme="dark"] .shipment-event-note { color: var(--text-faint); }
        [data-theme="dark"] .shipment-event-state { color: #ff9a95; }
        [data-theme="dark"] .shipment-event-link { color: #8fb4ff; }
      `}</style>

      <header className="shipment-event-head">
        <div>
          <div className="shipment-event-eyebrow">Email ↔ canonical sheet reconciliation</div>
          <h2 id="shipment-event-title">Tracked Shipment Updates</h2>
          <p>Latest unmatched or stale events reviewed through 08/22/26. Resolve the urgent items first.</p>
        </div>
        <div className="shipment-event-counts" aria-label="Shipment exception totals">
          <span className="urgent">{urgent} urgent</span>
          <span>{missing} missing</span>
          <span>{TRACKED_EVENTS.length} tracked</span>
        </div>
      </header>

      {expired && (
        <p className="shipment-event-expired">
          This list was hand-reviewed through 08/22/26 and hasn&rsquo;t reconciled against the live
          workbook since — some of these may already be resolved. Re-check each row against the{" "}
          <a href={MASTER_SHEET} target="_blank" rel="noreferrer">source sheet</a> before acting on it.
        </p>
      )}

      <ul className="shipment-event-list">
        {TRACKED_EVENTS.map((event) => (
          <li className="shipment-event-item" key={event.shipment}>
            <div className="shipment-event-top">
              <strong className="shipment-event-id">{event.shipment}</strong>
              <span className={`shipment-event-priority ${event.priority}`}>
                {PRIORITY_LABEL[event.priority]}
              </span>
            </div>
            <p className="shipment-event-detail">{event.event}</p>
            <p className="shipment-event-note">{event.updateNote}</p>
            <div className="shipment-event-foot">
              <span className="shipment-event-state">{expired ? "Needs re-verification" : STATE_LABEL[event.syncState]}</span>
              <a className="shipment-event-link" href={sheetUrl(event)} target="_blank" rel="noreferrer">
                {event.sheet}{event.row ? ` · row ${event.row}` : ""} ↗
              </a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
