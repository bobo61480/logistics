"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./fulfillment-tk-orders.module.css";

const SOURCE_URL = "https://sk-b2b-mobile.github.io/fulfillment/sales.html";
const DEFAULT_GAS_URL = "https://script.google.com/macros/s/AKfycbykK9DWjem9ORHxfR_mpdZl5DVh-en0D6JpCdIuel305QmfqxoNU_NqSnjkhFk401hI/exec";
const GAS_URL = process.env.NEXT_PUBLIC_FULFILLMENT_GAS_URL ?? DEFAULT_GAS_URL;
const AUTO_SYNC_MS = 30_000;
const METHOD_FILTER_KEY = "fulfillment-orders-method";
const FINISHED_STATES = ["COMPLETED", "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED"];
const REAL_ISSUES = new Set(["EXP", "NF", "DMG", "OOS", "SKUMIS"]);
const REASON_LABEL: Record<string, string> = {
  EXP: "Expired",
  NF: "Not Found In Stock",
  DMG: "Damaged",
  OOS: "Out of Stock",
  SKUMIS: "SKU Mismatch",
  MISS: "Not Scanned (Picked OK)",
};

type OverviewJob = {
  invoice: string;
  remarks?: string;
  shipDate?: string;
  pickComplete?: boolean;
  pickStart?: string;
  pickAnomaly?: boolean;
  method?: string;
  amount?: number;
  inspection?: string;
  status?: string;
  movedToPacking?: boolean;
  dimsCount?: number;
  dimsLinkedTo?: string;
};

type IssueItem = {
  sku?: string;
  barcode?: string;
  name?: string;
  reason?: string;
  qty?: number;
};

type Dimension = { l?: number | null; w?: number | null; h?: number | null; wt?: number | null };

type OrderDetail = OverviewJob & {
  ok?: boolean;
  customer?: string;
  inspectionRaw?: string;
  inspector?: string;
  inspEnd?: string;
  hasBatchRecord?: boolean;
  items?: IssueItem[];
  dimensions?: Dimension[];
  dims?: Dimension[];
};

type ApiResult<T> = ({ ok: true } & T) | { ok?: false; error?: string };

function money(value: number | undefined) {
  const n = Number(value) || 0;
  return n
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
    : "—";
}

function inspectionState(value: unknown) {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return "pending" as const;
  if (text.includes("PASS")) return "pass" as const;
  if (text.includes("ISSUES")) return "issues" as const;
  return "pending" as const;
}

async function gasGet<T>(params: Record<string, string>): Promise<ApiResult<T>> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 25_000);
    const query = new URLSearchParams({ t: String(Date.now()), ...params });
    const response = await fetch(`${GAS_URL}?${query.toString()}`, { cache: "no-store", signal: controller.signal });
    window.clearTimeout(timer);
    return (await response.json()) as ApiResult<T>;
  } catch (error) {
    return { ok: false, error: error instanceof DOMException && error.name === "AbortError" ? "Request timed out (25s)" : String(error) };
  }
}

async function gasPost<T>(op: string, data: unknown): Promise<ApiResult<T>> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 25_000);
    const body = new URLSearchParams({ op, data: JSON.stringify(data) });
    const response = await fetch(GAS_URL, { method: "POST", body, signal: controller.signal });
    window.clearTimeout(timer);
    return (await response.json()) as ApiResult<T>;
  } catch (error) {
    return { ok: false, error: error instanceof DOMException && error.name === "AbortError" ? "Request timed out (25s)" : String(error) };
  }
}

function PickingBadge({ order }: { order: OverviewJob }) {
  if (order.pickAnomaly) return <span className={`${styles.badge} ${styles.warn}`}>⚠ Check</span>;
  if (order.pickComplete) return <span className={`${styles.badge} ${styles.blue}`}>✓ Complete</span>;
  if (order.pickStart) return <span className={`${styles.badge} ${styles.green}`}><i className={styles.liveDot} />Active</span>;
  return <span className={`${styles.badge} ${styles.gray}`}><i className={styles.staticDot} />Waiting</span>;
}

function InspectionBadge({ order }: { order: OverviewJob }) {
  const state = inspectionState(order.inspection);
  if (state === "pass") return <span className={`${styles.badge} ${styles.green}`}>✓ PASS</span>;
  if (state === "issues") return <span className={`${styles.badge} ${styles.red}`}>{order.inspection || "Issues"}</span>;
  return <span className={`${styles.badge} ${styles.gray}`}>⏳ Not Inspected</span>;
}

function DimensionsBadge({ order }: { order: OverviewJob }) {
  if (order.dimsLinkedTo) return <span className={`${styles.badge} ${styles.green}`}>🔗 {order.dimsLinkedTo}</span>;
  if ((order.dimsCount ?? 0) > 0) return <span className={`${styles.badge} ${styles.green}`}>✓ Saved ({order.dimsCount})</span>;
  return <span className={`${styles.badge} ${styles.gray}`}>Not Entered</span>;
}

function ProgressBoard({ jobs }: { jobs: OverviewJob[] }) {
  const total = jobs.length;
  const pickDone = jobs.filter((o) => o.pickComplete).length;
  const inspected = jobs.filter((o) => inspectionState(o.inspection) !== "pending").length;
  const moved = jobs.filter((o) => o.movedToPacking).length;
  const dimsDone = jobs.filter((o) => (o.dimsCount ?? 0) > 0 || o.dimsLinkedTo).length;
  const stages = [
    ["Picking", pickDone, "blue"],
    ["Inspected", inspected, "green"],
    ["Moved to Packing", moved, "amber"],
    ["Dimensions", dimsDone, "purple"],
  ] as const;

  return (
    <div className={styles.progressBoard} aria-label="TK fulfillment progress">
      {stages.map(([label, done, tone], index) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        return (
          <div className={styles.progressStageWrap} key={label}>
            {index > 0 && <span className={styles.progressArrow}>›</span>}
            <div className={styles.progressStage}>
              <div className={styles.progressLabel}><i className={`${styles.stageDot} ${styles[tone]}`} />{label}</div>
              <div className={styles.progressValue}>{done}<small> / {total}</small></div>
              <div className={`${styles.progressPct} ${styles[`${tone}Text`]}`}>{pct}%</div>
              <div className={styles.progressTrack}><div className={`${styles.progressFill} ${styles[tone]}`} style={{ width: `${pct}%` }} /></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DimensionEditor({ detail, onSaved }: { detail: OrderDetail; onSaved: () => Promise<void> }) {
  const initial = (detail.dimensions ?? detail.dims ?? []).map((d) => ({ ...d }));
  const [rows, setRows] = useState<Dimension[]>(initial.length ? initial : [{ l: null, w: null, h: null, wt: null }]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const setField = (index: number, field: keyof Dimension, raw: string) => {
    setRows((current) => current.map((row, i) => i === index ? { ...row, [field]: raw === "" ? null : Number(raw) } : row));
  };

  const save = async () => {
    const dims = rows
      .filter((row) => Number(row.wt) > 0)
      .map((row) => ({ l: row.l || null, w: row.w || null, h: row.h || null, wt: Number(row.wt) }));
    setSaving(true);
    setError("");
    const result = await gasPost("saveDimensions", { invoice: detail.invoice, dims, enteredBy: "Packing (StyleKorean Control Tower)" });
    setSaving(false);
    if (!result.ok) {
      setError(result.error || "Could not save dimensions.");
      return;
    }
    setEditing(false);
    await onSaved();
  };

  return (
    <section className={styles.dimensionsSection}>
      <div className={styles.modalSectionHead}>
        <strong>Shipping Dimensions</strong>
        {!editing && <button className={styles.miniButton} onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {!editing ? (
        <div className={styles.dimReadout}>
          {initial.length ? initial.map((d, i) => (
            <div className={styles.dimReadRow} key={i}><b>#{i + 1}</b><span>{[d.l, d.w, d.h].filter((v) => v != null).join(" × ") || "Pallet"}</span><strong>{d.wt ?? "—"} lbs</strong></div>
          )) : <div className={styles.emptyDim}>No dimensions entered yet.</div>}
        </div>
      ) : (
        <div className={styles.dimEditor}>
          {rows.map((row, index) => (
            <div className={styles.dimEditRow} key={index}>
              <b>#{index + 1}</b>
              {(["l", "w", "h", "wt"] as const).map((field) => (
                <label key={field}><span>{field === "wt" ? "Weight" : field.toUpperCase()}</span><input inputMode="decimal" value={row[field] ?? ""} onChange={(e) => setField(index, field, e.target.value)} /></label>
              ))}
              <button aria-label={`Remove pallet ${index + 1}`} className={styles.removeButton} onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>×</button>
            </div>
          ))}
          <button className={styles.addDimButton} onClick={() => setRows((current) => [...current, { l: null, w: null, h: null, wt: null }])}>+ Add pallet</button>
          {error && <div className={styles.errorBox}>{error}</div>}
          <div className={styles.dimActions}>
            <button className={styles.primaryButton} disabled={saving} onClick={save}>{saving ? "Saving…" : "Save dimensions"}</button>
            <button className={styles.secondaryButton} onClick={() => { setRows(initial.length ? initial : [{ l: null, w: null, h: null, wt: null }]); setEditing(false); setError(""); }}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

function DetailModal({ invoice, onClose, onChanged }: { invoice: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState("");
  const [savingMove, setSavingMove] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setError("");
    const result = await gasGet<OrderDetail>({ op: "getSalesInvoiceDetail", invoice });
    if (!result.ok) {
      setError(result.error || `Order not found: ${invoice}`);
      return;
    }
    setDetail(result as OrderDetail);
  }, [invoice]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(modalRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => { document.removeEventListener("keydown", handler); document.body.style.overflow = previous; };
  }, [onClose]);

  const toggleMoved = async () => {
    if (!detail) return;
    const next = !detail.movedToPacking;
    const prompt = next
      ? `Mark ${detail.invoice} as moved to the packing zone?`
      : `Undo the packing-zone move for ${detail.invoice}?`;
    if (!window.confirm(prompt)) return;
    setSavingMove(true);
    const result = await gasPost("setManualPackingMoved", { invoice: detail.invoice, moved: next, by: "Packing (StyleKorean Control Tower)" });
    setSavingMove(false);
    if (!result.ok) {
      window.alert(`Save failed: ${result.error || "Unknown error"}`);
      return;
    }
    await load();
    await onChanged();
  };

  const inspection = inspectionState(detail?.inspectionRaw ?? detail?.inspection);
  const items = detail?.items ?? [];
  const realIssues = items.filter((item) => REAL_ISSUES.has(String(item.reason ?? "")));
  const scanGaps = items.filter((item) => item.reason === "MISS");

  return (
    <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={modalRef} className={styles.modal} role="dialog" aria-modal="true" aria-label={`Fulfillment details ${invoice}`}>
        <button ref={closeButtonRef} aria-label={`Close fulfillment details for ${invoice}`} className={styles.closeButton} onClick={onClose}>×</button>
        {!detail && !error && <div className={styles.modalLoading}>Loading {invoice}…</div>}
        {error && <div className={styles.errorBox}>{error}</div>}
        {detail && (
          <>
            <header className={styles.modalHeader}>
              <div>
                <h3>{detail.invoice}</h3>
                <p>{detail.customer || detail.remarks || ""}</p>
                <div className={styles.metaGrid}>
                  <span><small>Ship Date</small><b>{detail.shipDate || "—"}</b></span>
                  <span><small>Picking</small><b>{detail.pickStart || "—"}</b></span>
                  <span><small>Shipping Method</small><b>{detail.method || "—"}</b></span>
                  <span><small>Amount</small><b>{money(detail.amount)}</b></span>
                  <span><small>Inspector</small><b>{detail.inspector || "—"}</b></span>
                  <span><small>Inspection Completed</small><b>{detail.inspEnd || "—"}</b></span>
                </div>
              </div>
              <div className={styles.statusStack}>
                {inspection === "pending" && <span className={`${styles.bigBadge} ${styles.gray}`}>⏳ Not Inspected Yet</span>}
                {inspection === "pass" && <span className={`${styles.bigBadge} ${styles.green}`}>✓ ALL ITEMS PICKED — NO ISSUES</span>}
                {inspection === "issues" && <span className={`${styles.bigBadge} ${styles.red}`}>⚠ {realIssues.length || items.length} ISSUE(S)</span>}
                {inspection !== "pending" && <span className={`${styles.badge} ${detail.movedToPacking ? styles.green : styles.gray}`}>{detail.movedToPacking ? "✓ Moved to Packing" : "Not Moved to Packing Yet"}</span>}
                {inspection !== "pending" && <button className={styles.moveButton} disabled={savingMove} onClick={toggleMoved}>{savingMove ? "Saving…" : detail.movedToPacking ? "Undo packing move" : "📦 Mark as Moved to Packing"}</button>}
              </div>
            </header>

            {inspection === "issues" && (
              <section className={styles.issueSection}>
                <div className={styles.modalSectionHead}><strong>Item Detail</strong></div>
                {items.length === 0 && <div className={styles.errorBox}>Issue recorded, but item detail was not found. Check with the warehouse before invoicing.</div>}
                {realIssues.map((item, index) => (
                  <div className={`${styles.issueRow} ${styles.realIssue}`} key={`real-${index}`}><span>❌</span><div><small>{item.sku || item.barcode || "—"}</small><b>{item.name || "Unknown item"}</b></div><em>{REASON_LABEL[item.reason || ""] || item.reason}</em><strong>{item.qty ?? 0} pcs</strong></div>
                ))}
                {scanGaps.map((item, index) => (
                  <div className={`${styles.issueRow} ${styles.scanGap}`} key={`gap-${index}`}><span>🔵</span><div><small>{item.sku || item.barcode || "—"}</small><b>{item.name || "Unknown item"}</b></div><em>{REASON_LABEL[item.reason || ""] || item.reason}</em><strong>{item.qty ?? 0} pcs</strong></div>
                ))}
              </section>
            )}

            {inspection !== "pending" && <DimensionEditor detail={detail} onSaved={async () => { await load(); await onChanged(); }} />}
          </>
        )}
      </div>
    </div>
  );
}

export default function FulfillmentTkOrders() {
  const [jobs, setJobs] = useState<OverviewJob[]>([]);
  const [methodFilter, setMethodFilter] = useState("ALL");
  const [methodMenuOpen, setMethodMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncState, setSyncState] = useState<"busy" | "ok" | "err">("busy");
  const [syncText, setSyncText] = useState("Connecting…");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [openInvoice, setOpenInvoice] = useState("");
  const loadingRef = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!silent) setLoading(true);
    setSyncState("busy");
    setSyncText("Syncing fulfillment orders…");
    const result = await gasGet<{ jobs?: OverviewJob[] }>({ op: "getSalesOverview" });
    if (!result.ok) {
      // Match the source page: keep the last good dataset on transient refresh failures.
      setSyncState("err");
      setSyncText(jobs.length ? "Reconnecting…" : "Could not load data");
      setLoading(false);
      loadingRef.current = false;
      return;
    }
    setJobs(result.jobs ?? []);
    setSyncState("ok");
    setSyncText(`Connected · ${new Date().toLocaleTimeString("en-US", { hour12: false })}`);
    setLoading(false);
    loadingRef.current = false;
  }, [jobs.length]);

  useEffect(() => { void load(false); }, [load]);
  useEffect(() => {
    const saved = window.localStorage.getItem(METHOD_FILTER_KEY);
    if (saved) setMethodFilter(saved);
  }, []);
  useEffect(() => {
    const tick = () => { if (!document.hidden && !openInvoice) void load(true); };
    const timer = window.setInterval(tick, AUTO_SYNC_MS);
    const visibility = () => { if (!document.hidden && !openInvoice) void load(true); };
    document.addEventListener("visibilitychange", visibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [load, openInvoice]);

  const methodCounts = useMemo(() => {
    const counts = new Map<string, number>();
    jobs.forEach((order) => {
      const method = String(order.method ?? "").trim().toUpperCase() || "UNSPECIFIED";
      counts.set(method, (counts.get(method) ?? 0) + 1);
    });
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  }, [jobs]);

  const chooseMethod = (method: string) => {
    setMethodFilter(method);
    setMethodMenuOpen(false);
    setPage(1);
    window.localStorage.setItem(METHOD_FILTER_KEY, method);
  };

  const closeDetail = () => {
    const invoice = openInvoice;
    setOpenInvoice("");
    window.requestAnimationFrame(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-invoice-detail]"))
        .find((button) => button.dataset.invoiceDetail === invoice)
        ?.focus();
    });
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return jobs.filter((order) => {
      const method = String(order.method ?? "").trim().toUpperCase() || "UNSPECIFIED";
      if (methodFilter !== "ALL" && method !== methodFilter) return false;
      return !needle || String(order.invoice ?? "").toUpperCase().includes(needle) || String(order.remarks ?? "").toUpperCase().includes(needle);
    });
  }, [jobs, methodFilter, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const totalAmount = jobs.reduce((sum, order) => sum + (Number(order.amount) || 0), 0);

  return (
    <section className={styles.card} aria-labelledby="fulfillment-tk-heading">
      <div className={styles.cardHeader}>
        <div className={styles.titleGroup}>
          <span className={styles.cartIcon}>🛒</span>
          <div><h2 id="fulfillment-tk-heading">Fulfillment Orders</h2><p>Live WMS fulfillment status · all shipping methods</p></div>
          <div className="fulfillment-method-filter-wrap">
            <button className={styles.methodPill} onClick={() => setMethodMenuOpen((open) => !open)} aria-expanded={methodMenuOpen} aria-controls="fulfillment-method-options">Method: {methodFilter} ▾</button>
            {methodMenuOpen && <div id="fulfillment-method-options" className="fulfillment-method-menu" role="group" aria-label="Shipping method filter">
              <button className={methodFilter === "ALL" ? "active" : ""} onClick={() => chooseMethod("ALL")}>ALL <b>{jobs.length}</b></button>
              {methodCounts.map(([method, count]) => <button className={methodFilter === method ? "active" : ""} key={method} onClick={() => chooseMethod(method)}>{method} <b>{count}</b></button>)}
            </div>}
          </div>
        </div>
        <div className={styles.headerStats}>
          <span className={styles.countPill}>{filtered.length.toLocaleString()} of {jobs.length.toLocaleString()} Orders</span>
          <strong>{money(totalAmount)}</strong>
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">View Source ↗</a>
        </div>
      </div>

      <div className={styles.syncBar}><span role="status" aria-live="polite"><i className={`${styles.syncDot} ${styles[syncState]}`} />{syncText}</span><button onClick={() => void load(false)}>↻ Refresh</button></div>
      <ProgressBoard jobs={jobs} />

      <div className={styles.toolbar}>
        <label><span>⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search invoice # or customer name…" /></label>
        <div>Rows <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>{[10, 20, 30, 50].map((n) => <option key={n}>{n}</option>)}</select></div>
      </div>

      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead><tr><th>Invoice #</th><th>Customer</th><th>Ship Out</th><th>Picking</th><th>Method</th><th>Amount</th><th>Fulfillment Status</th><th>Moved to Packing</th><th>Dimensions</th><th>Details</th></tr></thead>
          <tbody>
            {pageRows.map((order) => (
              <tr key={order.invoice} className={FINISHED_STATES.some((state) => String(order.status ?? order.inspection ?? "").toUpperCase().includes(state)) ? "fulfillment-finished-row" : ""}>
                <td className={styles.monoStrong}>{order.invoice}</td>
                <td title={order.remarks || ""}>{order.remarks || "—"}</td>
                <td className={styles.dimText}>{order.shipDate || "—"}</td>
                <td><PickingBadge order={order} /></td>
                <td><span className={`${styles.badge} ${styles.tk}`}>{order.method || "—"}</span></td>
                <td className={styles.mono}>{money(order.amount)}</td>
                <td><InspectionBadge order={order} /></td>
                <td><span className={`${styles.badge} ${order.movedToPacking ? styles.green : styles.gray}`}>{order.movedToPacking ? "✓ Yes" : "No"}</span></td>
                <td><DimensionsBadge order={order} /></td>
                <td><button data-invoice-detail={order.invoice} className={`${styles.detailLink} ${inspectionState(order.inspection) === "issues" ? styles.issueLink : ""}`} onClick={() => setOpenInvoice(order.invoice)}>{inspectionState(order.inspection) === "issues" ? "Issues →" : "View →"}</button></td>
              </tr>
            ))}
            {!loading && !pageRows.length && <tr><td className={styles.emptyRow} colSpan={10}>No orders match the current filters.</td></tr>}
            {loading && !jobs.length && <tr><td className={styles.emptyRow} colSpan={10}>Loading fulfillment data…</td></tr>}
          </tbody>
        </table>
      </div>

      <div className={styles.pager}>
        <span>{filtered.length ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, filtered.length)} of ${filtered.length}` : "0 of 0"}</span>
        <div><button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹ Prev</button><b>Page {page} / {totalPages}</b><button disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next ›</button></div>
      </div>

      <a className={styles.footerLink} href={SOURCE_URL} target="_blank" rel="noreferrer">View Source Orders →</a>
      {openInvoice && <DetailModal invoice={openInvoice} onClose={closeDetail} onChanged={async () => { await load(true); }} />}
    </section>
  );
}
