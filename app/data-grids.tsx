"use client";

import { useState } from "react";
import { statusClass, type InventoryItem, type ScheduleItem } from "./page";

type GridKey = "imports" | "outbound" | "transfers" | "nationals" | "wms" | "inventory";

const GRID_TABS: { key: GridKey; label: string }[] = [
  { key: "imports", label: "IMPORTS" },
  { key: "outbound", label: "OUTBOUND" },
  { key: "transfers", label: "TRANSFERS" },
  { key: "nationals", label: "NATIONALS" },
  { key: "wms", label: "WMS" },
  { key: "inventory", label: "INVENTORY" },
];

/**
 * A tabbed view over the same real data the individual schedule/inventory
 * cards elsewhere on the page already show — a row-level lens, not a new
 * data source. No TRANSFERS tab equivalent to the others: computeLiveKpis
 * (lib/sales-kpis.ts) only ever exposes aggregate TRANSFERS totals to the
 * frontend, never the parsed per-row records, so that tab is an honest
 * placeholder rather than fabricated rows.
 */
export function DataGrids({
  imports,
  outbound,
  nationals,
  wms,
  inventory,
  loading,
  includeFinished,
  onToggleFinished,
}: {
  imports: ScheduleItem[];
  outbound: ScheduleItem[];
  nationals: ScheduleItem[];
  wms: ScheduleItem[];
  inventory: InventoryItem[];
  loading: boolean;
  includeFinished: boolean;
  onToggleFinished: (value: boolean) => void;
}) {
  const [active, setActive] = useState<GridKey>("imports");

  return (
    <section className="data-grids-panel" aria-labelledby="data-grids-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">LOGISTICS MASTER · NATIONALS · WMS</p>
          <h2 id="data-grids-heading">Data Grids</h2>
        </div>
      </div>

      <div className="grid-tabs" role="tablist" aria-label="Dataset grid">
        {GRID_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            className={active === tab.key ? "grid-tab active" : "grid-tab"}
            onClick={() => setActive(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {active === "imports" && (
        <div className="grid-pane">
          <label className="grid-toggle">
            <input
              type="checkbox"
              checked={includeFinished}
              onChange={(event) => onToggleFinished(event.target.checked)}
            />
            Show completed &amp; received entries
          </label>
          <ScheduleTable items={imports} loading={loading} emptyLabel="No import shipments in the active window." />
        </div>
      )}
      {active === "outbound" && (
        <div className="grid-pane">
          <ScheduleTable items={outbound} loading={loading} emptyLabel="No outbound shipments in the active window." />
        </div>
      )}
      {active === "transfers" && (
        <div className="grid-pane">
          <p className="grid-placeholder-note">
            Per-row TRANSFERS data isn&apos;t exposed to the frontend today — the KPI panel above
            only computes aggregate totals (Transfer Shipping, Trucking Transfers to NJ) from this
            tab&apos;s source sheet, not individual rows. A per-row view here would need new data
            plumbing, not just a UI change.
          </p>
        </div>
      )}
      {active === "nationals" && (
        <div className="grid-pane">
          <ScheduleTable items={nationals} loading={loading} emptyLabel="No Nationals orders in the active window." />
        </div>
      )}
      {active === "wms" && (
        <div className="grid-pane">
          <ScheduleTable items={wms} loading={loading} emptyLabel="No WMS orders in the active window." />
        </div>
      )}
      {active === "inventory" && (
        <div className="grid-pane">
          <InventoryTable items={inventory} loading={loading} />
        </div>
      )}
    </section>
  );
}

function ScheduleTable({
  items,
  loading,
  emptyLabel,
}: {
  items: ScheduleItem[];
  loading: boolean;
  emptyLabel: string;
}) {
  if (loading && items.length === 0) return <p className="grid-placeholder-note">Loading…</p>;
  if (items.length === 0) return <p className="grid-placeholder-note">{emptyLabel}</p>;
  return (
    <div className="table-scroll">
      <table className="grid-table">
        <thead>
          <tr>
            <th>Reference</th>
            <th>Invoice #</th>
            <th>Carrier</th>
            <th>Tracking / PRO #</th>
            <th>Date</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td className="mono">{item.shipmentNo || item.title || item.reference || "—"}</td>
              <td className="mono">{item.invoice || item.po || item.customer || item.title || "—"}</td>
              <td>{item.carrier || item.shippingMethod || "—"}</td>
              <td className="mono">{item.trackingNumber || item.pro || "—"}</td>
              <td className="mono">{item.dateText || "—"}</td>
              <td>
                <span className={statusClass(item.status)}>{item.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InventoryTable({ items, loading }: { items: InventoryItem[]; loading: boolean }) {
  if (loading && items.length === 0) return <p className="grid-placeholder-note">Loading…</p>;
  if (items.length === 0) return <p className="grid-placeholder-note">No inventory records.</p>;
  return (
    <div className="table-scroll">
      <table className="grid-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>SKU</th>
            <th>Qty</th>
            <th>Location</th>
            <th>Expiration</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.productName}</td>
              <td className="mono">{item.sku}</td>
              <td className="mono">{item.quantity}</td>
              <td>{item.location}</td>
              <td className="mono">{item.expirationDate || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
