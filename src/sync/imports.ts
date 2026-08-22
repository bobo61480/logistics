/**
 * src/sync/imports.ts
 * Syncs the IMPORTS tab of LOGISTICS MASTER 2026 into D1.
 *
 * Column indices (confirmed from importSourceRecords() in app/page.tsx):
 *   0=shipment_no  2=invoice  3=mbl  4=hbl  7=container  12=vessel
 *   13=etd  14=eta  16=delivery_expected  27=status
 *
 * The tab is split by a row whose col-A equals "SCHEDULING"; rows below
 * that marker (planning / parcels sections) are excluded from this sync.
 */

import {
  MASTER_ID, clean, fetchGvizCsv, normalizeStatus, batchUpsert, markSynced, chunks,
} from "./shared";

export interface ImportRow {
  id: string;
  source_row: number;
  shipment_no: string;
  invoice: string;
  mbl: string;
  hbl: string;
  container: string;
  vessel: string;
  etd: string;
  eta: string;
  delivery_expected: string;
  status: string;
  synced_at: number;
}

function findBoundary(rows: string[][]): number {
  const idx = rows.findIndex((r) => clean(r[0]).toUpperCase() === "SCHEDULING");
  return idx === -1 ? rows.length : idx;
}

export async function syncImports(db: D1Database): Promise<number> {
  let rows: string[][];
  try {
    rows = await fetchGvizCsv(MASTER_ID, { gid: 1497250700, range: "A:AE" });
  } catch (err) {
    await markSynced(db, "imports", 0, String(err));
    throw err;
  }

  const now = Date.now();
  const boundary = findBoundary(rows);
  const records: ImportRow[] = [];

  // Row 1 = header labels, row 2 = sub-headers; data starts at row 3 (index 2).
  for (let i = 2; i < boundary; i++) {
    const r = rows[i];
    const shipment_no = clean(r[0]);
    const invoice     = clean(r[2]);
    const mbl         = clean(r[3]);
    const hbl         = clean(r[4]);
    if (!shipment_no && !invoice && !mbl && !hbl) continue;

    records.push({
      id: `import-${i + 1}`,
      source_row: i + 1,
      shipment_no,
      invoice,
      mbl,
      hbl,
      container: clean(r[7]),
      vessel:    clean(r[12]),
      etd:       clean(r[13]),
      eta:       clean(r[14]),
      delivery_expected: clean(r[16]),
      status:    normalizeStatus(clean(r[27])),
      synced_at: now,
    });
  }

  // Upsert all current records.
  const stmts = records.map((rec) =>
    db.prepare(
      `INSERT OR REPLACE INTO imports
       (id,source_row,shipment_no,invoice,mbl,hbl,container,vessel,etd,eta,delivery_expected,status,synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      rec.id, rec.source_row, rec.shipment_no, rec.invoice, rec.mbl, rec.hbl,
      rec.container, rec.vessel, rec.etd, rec.eta, rec.delivery_expected,
      rec.status, rec.synced_at,
    )
  );
  await batchUpsert(db, stmts);

  // Sweep rows no longer present in the sheet (their synced_at predates this run).
  await db.prepare("DELETE FROM imports WHERE synced_at < ?").bind(now).run();

  await markSynced(db, "imports", records.length);
  return records.length;
}
