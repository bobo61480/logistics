"use client";

// SKW Inventory Panels — active inbound allocation + current warehouse stock.
// Browser reads stay on the same-origin D1 API. Google Sheets is synchronized
// server-side into D1 and is never queried directly by this component.

import { useCallback, useEffect, useState } from "react";

const REFRESH_MS = 15 * 60 * 1000;
const SHEETS_ENDPOINT = "/api/logistics/sheets";

type StockRow = {
  sku: string;
  upc: string;
  name: string;
  batch: string;
  expiry: string;
  qty: string;
  location: string;
  status: string;
  eta: string;
};

type D1SheetPayload = {
  ok?: boolean;
  rows?: string[][];
  error?: string;
  frontendSource?: string;
};

async function fetchTab(tab: string): Promise<string[][]> {
  const params = new URLSearchParams({ document: "logistics-master", tab });
  const res = await fetch(`${SHEETS_ENDPOINT}?${params}`, { cache: "no-store" });
  const payload = await res.json().catch(() => null) as D1SheetPayload | null;
  if (!res.ok || payload?.ok !== true || payload.frontendSource !== "d1" || !Array.isArray(payload.rows)) {
    throw new Error(payload?.error || `${tab} D1 mirror is unavailable`);
  }
  return payload.rows;
}

function indexHeaders(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  header.forEach((h, i) => { map[h.trim().toLowerCase()] = i; });
  return map;
}

const FINISHED = new Set(["received", "delivered", "completed", "putaway", "cancelled"]);

export default function InventoryPanels() {
  const [inbound, setInbound] = useState<StockRow[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [inventoryGrid, stockGrid] = await Promise.all([
        fetchTab("INVENTORY"),
        fetchTab("SKW_Stock"),
      ]);

      const ih = indexHeaders(inventoryGrid[0] ?? []);
      const cell = (r: string[], k: string) => (ih[k] !== undefined ? (r[ih[k]] ?? "").trim() : "");
      const inboundRows = inventoryGrid.slice(1)
        .filter((r) => {
          const remaining = Number(cell(r, "remaining to receive").replace(/,/g, "")) || 0;
          return Boolean(cell(r, "sku")) && remaining > 0 && Boolean(cell(r, "inbound shipments (차수)"));
        })
        .map((r) => ({
          sku: cell(r, "sku"),
          upc: cell(r, "barcode"),
          name: cell(r, "product name"),
          batch: "",
          expiry: "",
          qty: cell(r, "remaining to receive"),
          location: "",
          status: cell(r, "inbound shipments (차수)"),
          eta: "",
        }))
        .filter((r) => !FINISHED.has(r.status.toLowerCase()));

      const sh = indexHeaders(stockGrid[0] ?? []);
      const scell = (r: string[], k: string) => (sh[k] !== undefined ? (r[sh[k]] ?? "").trim() : "");
      const stockRows = stockGrid.slice(1)
        .filter((r) => scell(r, "sku"))
        .map((r) => ({
          sku: scell(r, "sku"),
          upc: scell(r, "upc"),
          name: scell(r, "product_description"),
          batch: scell(r, "batch_no"),
          expiry: scell(r, "expiry_date"),
          qty: scell(r, "qty_ea"),
          location: scell(r, "location") || "RECEIVING",
          status: "",
          eta: "",
        }))
        .filter((r) => Number(r.qty) > 0);

      setInbound(inboundRows);
      setStock(stockRows);
      setState("ready");
      setError("");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Inventory D1 read failed.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const table = (rows: StockRow[], withLocation: boolean, emptyLabel: string) => (
    <div className="import-table-wrap">
      <table className="import-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>SKU#</th>
            <th>UPC#</th>
            <th>Batch</th>
            <th>Expiration</th>
            <th>Qty (EA)</th>
            {withLocation ? <th>Location</th> : <th>Current Import Shipment(s)</th>}
          </tr>
        </thead>
        <tbody>
          {state === "loading" && (
            <tr><td className="import-empty" colSpan={7}>Syncing inventory from D1…</td></tr>
          )}
          {state === "error" && (
            <tr><td className="import-empty" colSpan={7}>{error}</td></tr>
          )}
          {state === "ready" && rows.length === 0 && (
            <tr><td className="import-empty" colSpan={7}>{emptyLabel}</td></tr>
          )}
          {state === "ready" && rows.map((r, i) => (
            <tr key={`${r.sku}-${r.batch}-${i}`}>
              <td>{r.name || "—"}</td>
              <td className="mono">{r.sku}</td>
              <td className="mono">{r.upc || "—"}</td>
              <td className="mono">{r.batch || "—"}</td>
              <td className="mono">{r.expiry || "—"}</td>
              <td className="mono">{r.qty || "—"}</td>
              {withLocation
                ? <td className="mono">{r.location}</td>
                : <td className="mono">{[r.eta, r.status].filter(Boolean).join(" · ") || "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <section className="import-schedules" aria-label="Inbound inventory">
        <div className="panel-heading import-heading">
          <div>
            <p className="eyebrow">INBOUNDING SHIPMENTS · LINE ITEMS</p>
            <h2>Inbound Inventory</h2>
          </div>
          <div className="import-totals">
            <span>ITEMS <b>{inbound.length}</b></span>
            <strong>{inbound.length}</strong>
          </div>
        </div>
        {table(inbound, false, "No inbound line items in view")}
      </section>

      <section className="import-schedules" aria-label="Current warehouse stock">
        <div className="panel-heading import-heading">
          <div>
            <p className="eyebrow">WAREHOUSE · CURRENT STOCK</p>
            <h2>Current Stock</h2>
          </div>
          <div className="import-totals">
            <span>LOTS <b>{stock.length}</b></span>
            <strong>{stock.reduce((t: number, r: StockRow) => t + (Number(r.qty) || 0), 0).toLocaleString()}</strong>
          </div>
        </div>
        {table(stock, true, "No stock posted yet — items appear when inbounds are marked Received")}
      </section>
    </>
  );
}
