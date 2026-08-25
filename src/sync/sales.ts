/**
 * src/sync/sales.ts
 * Syncs WMS Wholesale and NATIONAL ORDER PROGRESS into sales_entries.
 *
 * Column indices confirmed from computeLiveKpis() in lib/sales-kpis.ts:
 *
 * WMS Wholesale (WMS workbook GID 0) — two header rows, data from row 3:
 *   0=date  6=amount  (no K/M/B suffixes)
 *
 * NATIONAL ORDER PROGRESS (NATIONAL workbook GID 99300389) — one header row:
 *   0=status  4=amount (K/M/B allowed)  6=order_date
 *   Rows where status col === "cancelled" are excluded.
 */

import {
  WMS_ID, NATIONAL_ID, clean, fetchCsvExport,
  dateCode, parseAmount, codeToIso, pacificToday,
  batchUpsert, markSynced,
} from "./shared";

interface SalesRow {
  id: string;
  source: "wms" | "nationals";
  date_iso: string;
  date_code: number;
  amount_usd: number;
  status: string;
  synced_at: number;
}

export async function syncSales(db: D1Database): Promise<{ wms: number; nationals: number }> {
  const today = pacificToday();
  const now = Date.now();
  const yearStart = today.year * 10_000 + 101; // Jan 1 of current year
  const records: SalesRow[] = [];

  // ── WMS Wholesale ─────────────────────────────────────────────────────────
  let wmsCount = 0;
  try {
    const rows = await fetchCsvExport(WMS_ID, 0);
    for (let i = 2; i < rows.length; i++) {
      const r = rows[i];
      const code = dateCode(clean(r[0]));
      if (!code || code < yearStart || code > today.code) continue;
      const amount = parseAmount(clean(r[6]), false);
      if (amount === 0) continue;
      records.push({
        id: `wms-${i + 1}`,
        source: "wms",
        date_iso: codeToIso(code),
        date_code: code,
        amount_usd: amount,
        status: "",
        synced_at: now,
      });
    }
    wmsCount = records.length;
    await markSynced(db, "sales_wms", wmsCount);
  } catch (err) {
    await markSynced(db, "sales_wms", 0, String(err));
    throw err;
  }

  // ── Nationals ─────────────────────────────────────────────────────────────
  let nationalsCount = 0;
  try {
    const rows = await fetchCsvExport(NATIONAL_ID, 99300389);
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (clean(r[0]).toLowerCase() === "cancelled") continue;
      const code = dateCode(clean(r[6]));
      if (!code || code < yearStart || code > today.code) continue;
      const amount = parseAmount(clean(r[4]), true);
      if (amount <= 0) continue;
      records.push({
        id: `nationals-${i + 1}`,
        source: "nationals",
        date_iso: codeToIso(code),
        date_code: code,
        amount_usd: amount,
        status: clean(r[0]),
        synced_at: now,
      });
    }
    nationalsCount = records.length - wmsCount;
    await markSynced(db, "sales_nationals", nationalsCount);
  } catch (err) {
    await markSynced(db, "sales_nationals", 0, String(err));
    throw err;
  }

  const stmts = records.map((rec) =>
    db.prepare(
      `INSERT OR REPLACE INTO sales_entries
       (id,source,date_iso,date_code,amount_usd,status,synced_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(rec.id, rec.source, rec.date_iso, rec.date_code, rec.amount_usd, rec.status, rec.synced_at)
  );
  await batchUpsert(db, stmts);
  await db.prepare("DELETE FROM sales_entries WHERE synced_at < ?").bind(now).run();

  return { wms: wmsCount, nationals: nationalsCount };
}
