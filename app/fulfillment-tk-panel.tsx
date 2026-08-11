"use client";

import { useMemo, useState } from "react";

type FulfillmentJob = Record<string, unknown>;

const SOURCE_URL = "https://sk-b2b-mobile.github.io/fulfillment/sales.html";
const PREFERRED_COLUMNS = [
  "invoice",
  "remarks",
  "shipDate",
  "method",
  "amount",
  "status",
  "inspection",
  "inspEnd",
  "pickStart",
  "pickComplete",
  "movedToPacking",
  "dimsCount",
  "dimIncludedIn",
  "pickAnomaly",
];

function clean(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value).trim();
}

function isMoneyField(key: string) {
  return /(^|[_\s-])(amount|cost|rate|price|total|sales|earning|earnings|freight|shipping)([_\s-]|$)/i.test(key);
}

function formatFulfillmentValue(key: string, value: string) {
  if (!value || !isMoneyField(key)) return value;
  const normalized = value.replace(/[$,\s]/g, "");
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) return value.startsWith("$") ? value : `$${value}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function fulfillmentCellClass(key: string, rawValue: string) {
  const normalizedKey = key.toLowerCase();
  const normalizedValue = rawValue.trim().toLowerCase();
  const classes = ["fulfillment-tk-cell"];

  if (normalizedKey === "method") classes.push("fulfillment-tk-method");
  if (/status|inspection|inspend/.test(normalizedKey)) {
    classes.push("fulfillment-tk-status");
    if (/deliver|complete|approved|pass|ready/.test(normalizedValue)) classes.push("is-success");
    else if (/delay|issue|fail|hold|error/.test(normalizedValue)) classes.push("is-danger");
    else if (/pending|wait/.test(normalizedValue)) classes.push("is-warning");
    else if (/transit|shipping|active|progress/.test(normalizedValue)) classes.push("is-active");
    else if (/pick/.test(normalizedValue)) classes.push("is-picked");
  }
  if (isMoneyField(key)) classes.push("fulfillment-tk-money");
  return classes.join(" ");
}

function titleFor(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function FulfillmentTkPanel({
  jobs,
  error,
  loading,
}: {
  jobs: FulfillmentJob[];
  error: string;
  loading: boolean;
}) {
  const [query, setQuery] = useState("");
  const tkJobs = useMemo(
    () => jobs.filter((job) => clean(job.method).toUpperCase() === "TK"),
    [jobs],
  );
  const columns = useMemo(() => {
    const available = new Set<string>();
    tkJobs.forEach((job) => Object.keys(job).forEach((key) => available.add(key)));
    const preferred = PREFERRED_COLUMNS.filter((key) => available.has(key));
    const remaining = [...available]
      .filter((key) => !preferred.includes(key))
      .sort((left, right) => left.localeCompare(right));
    return [...preferred, ...remaining];
  }, [tkJobs]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tkJobs;
    return tkJobs.filter((job) =>
      columns.some((key) => clean(job[key]).toLowerCase().includes(needle)),
    );
  }, [columns, query, tkJobs]);
  const totalAmount = useMemo(
    () =>
      tkJobs.reduce((sum, job) => {
        const value = Number(clean(job.amount).replace(/[$,]/g, ""));
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0),
    [tkJobs],
  );

  return (
    <section className="inventory-panel fulfillment-tk-panel" aria-labelledby="fulfillment-tk-heading">
      <div className="panel-heading inventory-heading">
        <div>
          <p className="eyebrow">LIVE SALES SOURCE · METHOD = TK ONLY</p>
          <h2 id="fulfillment-tk-heading">Fulfillment TK Orders</h2>
        </div>
        <div className="inventory-total">
          <strong>{tkJobs.length}</strong>
          <span>{totalAmount ? `${totalAmount.toLocaleString("en-US", { style: "currency", currency: "USD" })} total` : "TK entries"}</span>
        </div>
      </div>

      <div className="inventory-toolbar">
        <input
          aria-label="Search fulfillment TK orders"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search invoice, remarks, status, inspection, dates…"
          type="search"
          value={query}
        />
        <span>
          Showing {filtered.length.toLocaleString()} of {tkJobs.length.toLocaleString()} TK rows ·{" "}
          <a
            className="fulfillment-tk-source-link"
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer"
          >
            Open source ↗
          </a>
        </span>
      </div>

      {error ? (
        <div className="alert" role="alert">
          <strong>Fulfillment source unavailable.</strong> {error}
        </div>
      ) : null}

      <div className="inventory-table-wrap">
        <table className="inventory-table fulfillment-tk-table">
          <thead>
            <tr>
              {columns.map((key) => <th key={key}>{titleFor(key)}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.map((job, rowIndex) => (
              <tr key={`${clean(job.invoice) || "tk"}-${rowIndex}`}>
                {columns.map((key) => {
                  const rawValue = clean(job[key]);
                  const value = formatFulfillmentValue(key, rawValue);
                  return (
                    <td
                      className={fulfillmentCellClass(key, rawValue)}
                      key={key}
                      title={value || undefined}
                    >
                      {value || "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
            {!loading && !error && filtered.length === 0 ? (
              <tr><td className="import-empty" colSpan={Math.max(columns.length, 1)}>No TK fulfillment rows match the current search.</td></tr>
            ) : null}
            {loading ? (
              <tr><td className="import-empty" colSpan={Math.max(columns.length, 1)}>Syncing TK fulfillment sales…</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
