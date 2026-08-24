"use client";

// SKW Inventory Panels — active inbound allocation + current warehouse stock.
// Reads the filtered INVENTORY aggregate and SKW_Stock tabs (created by the
// Apps Script inventory sync inside LOGISTICS MASTER 2026) via the gviz
// CSV endpoint. Tab-name addressing + cb + no-store per SKW conventions.

import { useCallback, useEffect, useState } from "react";

const MASTER_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";
const REFRESH_MS = 30 * 60 * 1000;

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

function gvizUrl(tab: string) {
  return (
    `https://docs.google.com/spreadsheets/d/${MASTER_ID}/gviz/tq?tqx=out:csv` +
    `&sheet=${encodeURIComponent(tab)}&cb=${Date.now()}`
  );
}

function parseCsvSimple(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(value); value = ""; }
    else if (c === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += c;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

async function fetchTab(tab: string): Promise<string[][]> {
  const res = await fetch(gvizUrl(tab), { cache: "no-store" });
  const text = await res.text();
  if (text.trim().startsWith("<")) throw new Error(`${tab} is not link-readable`);
  return parseCsvSimple(text);
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
      setError(err instanceof Error ? err.message : "Inventory read failed.");
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
            <tr><td className="import-empty" colSpan={7}>Syncing inventory…</td></tr>
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
