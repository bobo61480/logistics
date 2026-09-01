"use client";

import { useMemo, useState } from "react";
import type { GmailIngestionEvent } from "./gmail-ingestion-card";

type DocumentType = "BOL" | "Invoice" | "POD" | "Entry Summary" | "Packing List" | "Other";
type ViewFilter = "all" | "filed" | "review";

const DOCUMENT_TYPES: DocumentType[] = ["BOL", "Invoice", "POD", "Entry Summary", "Packing List", "Other"];

function classifyDocument(event: GmailIngestionEvent): DocumentType {
  const haystack = [
    event.note,
    event.issues,
    event.driveFileUrl,
    event.invoice,
    event.blOrPro,
  ].join(" ").toUpperCase();

  if (/\bPOD\b|PROOF OF DELIVERY/.test(haystack)) return "POD";
  if (/ENTRY[ _-]?SUMMARY|CUSTOMS ENTRY/.test(haystack)) return "Entry Summary";
  if (/PACKING[ _-]?(LIST|SLIP)|\bPL\b/.test(haystack)) return "Packing List";
  if (/INVOICE|\bINV\b/.test(haystack)) return "Invoice";
  if (/\bBOL\b|BILL OF LADING|\bH?BL\b/.test(haystack)) return "BOL";
  return "Other";
}

function parseTimestamp(value: string) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTimestamp(value: string) {
  const parsed = parseTimestamp(value);
  if (!parsed) return value || "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function identifier(event: GmailIngestionEvent) {
  return event.shipmentId || event.container || event.blOrPro || event.invoice || event.customer || "Unidentified";
}

function PipelineIcon({ kind }: { kind: "mail" | "extract" | "archive" }) {
  if (kind === "mail") {
    return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8"><path d="M3.5 6.5h17v11h-17z" /><path d="m4 7 8 6 8-6" /></svg>;
  }
  if (kind === "extract") {
    return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8"><path d="M6 3.5h8l4 4v13H6z" /><path d="M14 3.5v4h4M9 12h6M9 16h5" /></svg>;
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8"><path d="M4 7.5h16v12H4zM3 4.5h18v3H3z" /><path d="M9 11h6" /></svg>;
}

/**
 * Live operator view over the same sources.gmailIngestion feed used by
 * Shipment Notices. Keeping the data owned by page.tsx means one snapshot,
 * one refresh cadence, and no competing interpretation of pipeline state.
 */
export function IngestionRoadmapCard({
  events,
  loading = false,
  sheetUrl,
}: {
  events: GmailIngestionEvent[] | null;
  loading?: boolean;
  sheetUrl?: string;
}) {
  const [view, setView] = useState<ViewFilter>("all");
  const [documentType, setDocumentType] = useState<"all" | DocumentType>("all");
  const [query, setQuery] = useState("");

  const summary = useMemo(() => {
    const source = events ?? [];
    const filed = source.filter((event) => Boolean(event.driveFileUrl));
    const review = source.filter((event) => event.status === "needsReview");
    const committed = source.filter((event) => event.status === "committed" || event.status === "approved");
    const latest = source.reduce((max, event) => Math.max(max, parseTimestamp(event.timestamp)), 0);
    const docsByType = DOCUMENT_TYPES.map((type) => ({
      type,
      count: source.filter((event) => classifyDocument(event) === type).length,
    })).filter((item) => item.count > 0);

    return { total: source.length, filed: filed.length, review: review.length, committed: committed.length, latest, docsByType };
  }, [events]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (events ?? [])
      .filter((event) => view === "all" || (view === "filed" ? Boolean(event.driveFileUrl) : event.status === "needsReview"))
      .filter((event) => documentType === "all" || classifyDocument(event) === documentType)
      .filter((event) => {
        if (!normalizedQuery) return true;
        return [
          identifier(event),
          event.customer,
          event.invoice,
          event.blOrPro,
          event.container,
          event.carrierOrVessel,
          event.note,
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .sort((a, b) => parseTimestamp(b.timestamp) - parseTimestamp(a.timestamp));
  }, [documentType, events, query, view]);

  const unavailable = !loading && events === null;
  const inboxState = unavailable ? "Degraded" : loading && events === null ? "Syncing" : "Connected";

  return (
    <section className="hct-card mt-6 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm" aria-labelledby="shipping-doc-ingestion-heading">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-100 px-5 py-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-blue-600">Live Gmail pipeline</p>
          <h2 id="shipping-doc-ingestion-heading" className="mt-1 text-xl font-extrabold text-neutral-950">Shipping Document Ingestion</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-neutral-500">
            Carrier and broker attachments classified, matched to a shipment, archived in Drive, and reconciled with the canonical schedule.
          </p>
        </div>
        <div className={"inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ring-1 " + (unavailable ? "bg-red-50 text-red-700 ring-red-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200")}>
          <span className={"h-2 w-2 rounded-full " + (unavailable ? "bg-red-500" : "bg-emerald-500")} />
          {inboxState}
        </div>
      </header>

      <div className="grid gap-px bg-neutral-200 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Emails processed", summary.total, "Current ingestion feed"],
          ["Documents filed", summary.filed, "Drive archive linked"],
          ["Schedule matches", summary.committed, "Committed or approved"],
          ["Needs review", summary.review, "Operator decision required"],
        ].map(([label, value, detail]) => (
          <div key={String(label)} className="bg-white px-5 py-4">
            <p className="text-xs font-semibold text-neutral-500">{label}</p>
            <p className="mt-1 text-2xl font-black tabular-nums text-neutral-950">{loading && events === null ? "—" : value}</p>
            <p className="mt-0.5 text-[11px] text-neutral-400">{detail}</p>
          </div>
        ))}
      </div>

      <div className="border-y border-neutral-100 bg-neutral-50/70 px-5 py-4">
        <ol className="grid gap-3 lg:grid-cols-3" aria-label="Ingestion pipeline">
          {[
            ["mail" as const, "1 · Receive", "Gmail intake", summary.total + " messages in feed"],
            ["extract" as const, "2 · Extract", "Classify & match", summary.committed + " schedule matches"],
            ["archive" as const, "3 · Archive", "Drive + canonical row", summary.filed + " files linked"],
          ].map(([kind, step, title, detail], index) => (
            <li key={step} className="relative flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3.5 py-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-700"><PipelineIcon kind={kind} /></span>
              <span className="min-w-0">
                <span className="block text-[10px] font-bold uppercase tracking-wider text-neutral-400">{step}</span>
                <span className="block text-sm font-bold text-neutral-900">{title}</span>
                <span className="block truncate text-[11px] text-neutral-500">{detail}</span>
              </span>
              {index < 2 && <span aria-hidden="true" className="absolute -right-2.5 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-neutral-200 px-1.5 text-neutral-500 lg:block">›</span>}
            </li>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500">
          <span>Last event: {summary.latest ? formatTimestamp(new Date(summary.latest).toISOString()) : loading ? "syncing…" : "none available"}</span>
          <span>{summary.docsByType.map((item) => item.type + " " + item.count).join(" · ") || "Document classification appears as files arrive"}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-5 py-3">
        <div className="flex rounded-lg bg-neutral-100 p-1" aria-label="Ingestion view">
          {([
            ["all", "All"],
            ["filed", "Filed"],
            ["review", "Needs review"],
          ] as const).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setView(key)} className={"rounded-md px-3 py-1.5 text-xs font-semibold transition " + (view === key ? "bg-white text-neutral-950 shadow-sm" : "text-neutral-500 hover:text-neutral-800")}>{label}</button>
          ))}
        </div>
        <select aria-label="Document type" value={documentType} onChange={(event) => setDocumentType(event.target.value as "all" | DocumentType)} className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs font-semibold text-neutral-700 outline-none focus:border-blue-400">
          <option value="all">All document types</option>
          {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <label className="relative min-w-48 flex-1 sm:max-w-xs">
          <span className="sr-only">Search ingested documents</span>
          <svg aria-hidden="true" viewBox="0 0 24 24" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 fill-none stroke-neutral-400" strokeWidth="2"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Shipment, invoice, container…" className="w-full rounded-lg border border-neutral-200 bg-white py-2 pl-9 pr-3 text-xs text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-blue-400" />
        </label>
        {sheetUrl && summary.review > 0 && <a href={sheetUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs font-bold text-amber-700 hover:underline">Open review queue ↗</a>}
      </div>

      {unavailable ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm font-bold text-red-700">Document ingestion data is temporarily unavailable.</p>
          <p className="mt-1 text-xs text-neutral-500">The schedule remains available; check source health and retry after the next sync.</p>
        </div>
      ) : loading && events === null ? (
        <div className="px-5 py-8 text-center text-sm text-neutral-500">Synchronizing document activity…</div>
      ) : filtered.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm font-semibold text-neutral-700">No documents match this view.</p>
          <p className="mt-1 text-xs text-neutral-400">Try a different status, document type, or search term.</p>
        </div>
      ) : (
        <div className="max-h-[30rem] overflow-auto">
          <table className="w-full min-w-[780px] border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-neutral-50 text-[10px] font-bold uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="px-5 py-2.5">Document</th>
                <th className="px-3 py-2.5">Shipment / customer</th>
                <th className="px-3 py-2.5">Identifiers</th>
                <th className="px-3 py-2.5">Pipeline state</th>
                <th className="px-3 py-2.5">Received</th>
                <th className="px-5 py-2.5 text-right">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {filtered.map((event, index) => {
                const type = classifyDocument(event);
                const filed = Boolean(event.driveFileUrl);
                const state = event.status === "needsReview" ? "Needs review" : filed ? "Filed" : event.status === "rejected" ? "Rejected" : "Matched";
                return (
                  <tr key={(event.reviewKey || event.sourceEmailUrl || identifier(event)) + index} className="hover:bg-blue-50/30">
                    <td className="px-5 py-3"><span className="rounded-md bg-blue-50 px-2 py-1 font-bold text-blue-700">{type}</span></td>
                    <td className="px-3 py-3">
                      <p className="font-bold text-neutral-900">{identifier(event)}</p>
                      {event.customer && event.customer !== identifier(event) && <p className="mt-0.5 text-neutral-500">{event.customer}</p>}
                    </td>
                    <td className="px-3 py-3 text-neutral-600">
                      {event.invoice && <p>Invoice {event.invoice}</p>}
                      {event.container && <p>Container {event.container}</p>}
                      {event.blOrPro && <p>BL/PRO {event.blOrPro}</p>}
                      {!event.invoice && !event.container && !event.blOrPro && <span className="text-amber-700">Identifier pending</span>}
                    </td>
                    <td className="px-3 py-3">
                      <span className={"inline-flex rounded-full px-2 py-1 font-bold ring-1 " + (state === "Needs review" ? "bg-amber-50 text-amber-700 ring-amber-200" : state === "Rejected" ? "bg-red-50 text-red-700 ring-red-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200")}>{state}</span>
                      {event.issues && <p className="mt-1 max-w-52 text-[11px] leading-4 text-amber-700">{event.issues}</p>}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-neutral-500">{formatTimestamp(event.timestamp)}</td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      {event.sourceEmailUrl && <a href={event.sourceEmailUrl} target="_blank" rel="noreferrer" className="font-semibold text-blue-600 hover:underline">Email ↗</a>}
                      {event.driveFileUrl && <a href={event.driveFileUrl} target="_blank" rel="noreferrer" className="ml-3 font-semibold text-blue-600 hover:underline">Drive ↗</a>}
                      {!event.sourceEmailUrl && !event.driveFileUrl && <span className="text-neutral-400">Pending</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-100 bg-neutral-50/60 px-5 py-3 text-[11px] text-neutral-500">
        <span>Showing {filtered.length} of {summary.total} ingestion events</span>
        <span>Unknown identifiers remain review-only and are never auto-merged.</span>
      </footer>
    </section>
  );
}
