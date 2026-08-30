/**
 * src/sync/sales.ts
 * Syncs WMS Wholesale and NATIONAL ORDER PROGRESS into sales_entries.
 *
 * NATIONAL ORDER PROGRESS has changed column layout over time, so the
 * importer resolves status/department/amount/order-date by header name.
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

function normalizeHeader(value: unknown) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function headerIndex(header: string[], aliases: string[], fallback: number) {
  const wanted = new Set(aliases.map(normalizeHeader));
  const index = header.findIndex((value) => wanted.has(normalizeHeader(value)));
  return index >= 0 ? index : fallback;
}

export async function syncSales(db: D1Database): Promise<{ wms: number; nationals: number }> {
  const today = pacificToday();
  const now = Date.now();
  const yearStart = today.year * 10_000 + 101;
  const records: SalesRow[] = [];

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

  let nationalsCount = 0;
  try {
    const rows = await fetchCsvExport(NATIONAL_ID, 99300389);
    const header = rows[0] ?? [];
    const statusCol = headerIndex(header, ["Status", "Overall PO Status"], 0);
    const departmentCol = headerIndex(header, ["Dept", "Department"], 2);
    const amountCol = headerIndex(header, ["Amount", "Total Order Amount"], 4);
    const orderDateCol = headerIndex(header, ["Order Date"], 6);
    const hasDepartmentHeader = header.some((value) => ["DEPT", "DEPARTMENT"].includes(normalizeHeader(value)));

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const status = clean(r[statusCol]);
      if (status.toLowerCase() === "cancelled") continue;
      if (hasDepartmentHeader && clean(r[departmentCol]).toLowerCase() !== "national") continue;
      const code = dateCode(clean(r[orderDateCol]));
      if (!code || code < yearStart || code > today.code) continue;
      const amount = parseAmount(clean(r[amountCol]), true);
      if (amount <= 0) continue;
      records.push({
        id: `nationals-${i + 1}`,
        source: "nationals",
        date_iso: codeToIso(code),
        date_code: code,
        amount_usd: amount,
        status,
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
