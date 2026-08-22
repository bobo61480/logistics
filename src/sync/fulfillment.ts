/**
 * src/sync/fulfillment.ts
 * Syncs TK fulfillment jobs from the Apps Script API into fulfillment_tk_jobs.
 *
 * Calls FULFILLMENT_API_URL with op=getSalesOverview, filters to method=TK,
 * mirrors FulfillmentTkJob from app/page.tsx.
 */

import { FULFILLMENT_API, clean, parseAmount, batchUpsert, markSynced } from "./shared";

interface FulfillmentRow {
  id: string;
  invoice: string;
  customer: string;
  ship_date: string;
  amount_usd: number;
  inspection: string;
  insp_end: string;
  moved_to_packing: number;
  dims_count: number;
  dim_included_in: string;
  pick_start: string;
  pick_complete: number;
  status: string;
  pick_anomaly: number;
  synced_at: number;
}

function bool(v: unknown): number {
  return v === true || /^(true|yes|1)$/i.test(clean(v)) ? 1 : 0;
}

function jobStatus(job: Record<string, unknown>): string {
  const inspection = clean(job.inspection);
  if (/ISSUE|HOLD|ERROR|MISMATCH/i.test(inspection) || bool(job.pickAnomaly)) return "Pending";
  const hasProgress = Boolean(
    clean(job.pickStart) || bool(job.pickComplete) || inspection ||
    bool(job.movedToPacking) || Number(job.dimsCount || 0) > 0,
  );
  return hasProgress ? "Work in Progress" : "Scheduled";
}

function normalizedId(invoice: string, index: number): string {
  const key = invoice.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  return key ? `fulfillment-tk-${key}` : `fulfillment-tk-${index}`;
}

export async function syncFulfillment(db: D1Database): Promise<number> {
  const now = Date.now();
  let jobs: Record<string, unknown>[];

  try {
    const url = new URL(FULFILLMENT_API);
    url.searchParams.set("op", "getSalesOverview");
    url.searchParams.set("t", String(now));
    const res = await fetch(url.toString(), { cf: { cacheTtl: 0 } } as RequestInit);
    if (!res.ok) throw new Error(`Fulfillment API failed (${res.status})`);
    const payload = await res.json() as { ok?: boolean; error?: string; jobs?: unknown[] };
    if (payload?.ok === false) throw new Error(clean(payload.error) || "Fulfillment API rejected");
    jobs = (Array.isArray(payload?.jobs) ? payload.jobs as Record<string, unknown>[] : [])
      .filter((j) => clean(j.method).toUpperCase() === "TK");
  } catch (err) {
    await markSynced(db, "fulfillment_tk", 0, String(err));
    throw err;
  }

  const records: FulfillmentRow[] = jobs.map((job, i) => ({
    id: normalizedId(clean(job.invoice), i),
    invoice:          clean(job.invoice),
    customer:         clean(job.remarks) || "TK Fulfillment",
    ship_date:        clean(job.shipDate),
    amount_usd:       parseAmount(clean(job.amount)),
    inspection:       clean(job.inspection),
    insp_end:         clean(job.inspEnd),
    moved_to_packing: bool(job.movedToPacking),
    dims_count:       Number(job.dimsCount || 0) || 0,
    dim_included_in:  clean(job.dimIncludedIn),
    pick_start:       clean(job.pickStart),
    pick_complete:    bool(job.pickComplete),
    status:           jobStatus(job),
    pick_anomaly:     bool(job.pickAnomaly),
    synced_at:        now,
  }));

  const stmts = records.map((rec) =>
    db.prepare(
      `INSERT OR REPLACE INTO fulfillment_tk_jobs
       (id,invoice,customer,ship_date,amount_usd,inspection,insp_end,moved_to_packing,
        dims_count,dim_included_in,pick_start,pick_complete,status,pick_anomaly,synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      rec.id, rec.invoice, rec.customer, rec.ship_date, rec.amount_usd,
      rec.inspection, rec.insp_end, rec.moved_to_packing, rec.dims_count,
      rec.dim_included_in, rec.pick_start, rec.pick_complete, rec.status,
      rec.pick_anomaly, rec.synced_at,
    )
  );
  await batchUpsert(db, stmts);
  await db.prepare("DELETE FROM fulfillment_tk_jobs WHERE synced_at < ?").bind(now).run();

  await markSynced(db, "fulfillment_tk", records.length);
  return records.length;
}
