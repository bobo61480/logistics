/**
 * src/sync/freight.ts
 * Syncs WH Trucking Request and TRANSFERS tabs of LOGISTICS MASTER 2026
 * into the freight_moves D1 table.
 *
 * Column indices confirmed from computeLiveKpis() in lib/sales-kpis.ts:
 *
 * WH Trucking (GID 852802817) — two header rows, data from row 3:
 *   2=destination  3=date  4=load_col1  5=load_col2
 *   16=carrier  17=rate  21=invoice_rate_fallback
 *
 * TRANSFERS (GID 1834454901) — one header row, data from row 2:
 *   1=load  4=destination  5=date  6=carrier  8=rate  9=invoice_rate_fallback
 */

import {
  MASTER_ID, clean, fetchCsvExport,
  freightDateCode, freightAmount, loadType,
  isNjDestination, distanceBand,
  batchUpsert, markSynced, codeToIso, pacificToday,
} from "./shared";

interface FreightRow {
  id: string;
  move_type: "trucking" | "transfer";
  date_iso: string;
  date_code: number;
  destination: string;
  carrier: string;
  cost_usd: number;
  load_type: "LTL" | "FTL";
  is_nj_transfer: number;
  distance_band: string;
  source_row: number;
  synced_at: number;
}

export async function syncFreight(db: D1Database): Promise<{ trucking: number; transfer: number }> {
  const today = pacificToday();
  const now = Date.now();
  const records: FreightRow[] = [];

  // ── WH Trucking ──────────────────────────────────────────────────────────
  try {
    const rows = await fetchCsvExport(MASTER_ID, 852802817);
    // Skip 2 header rows (indices 0 and 1)
    for (let i = 2; i < rows.length; i++) {
      const r = rows[i];
      const dateRaw = clean(r[3]);
      const code = freightDateCode(dateRaw, today);
      if (!code) continue;

      const cost = freightAmount(clean(r[21])) || freightAmount(clean(r[17]));
      const dest = clean(r[2]);
      const lt   = loadType([clean(r[4]), clean(r[5])].filter(Boolean).join(" "));

      records.push({
        id: `trucking-${i + 1}`,
        move_type: "trucking",
        date_iso: codeToIso(code),
        date_code: code,
        destination: dest,
        carrier: clean(r[16]).replace(/\s+/g, " "),
        cost_usd: cost,
        load_type: lt,
        is_nj_transfer: 0,
        distance_band: distanceBand(dest),
        source_row: i + 1,
        synced_at: now,
      });
    }
    await markSynced(db, "freight_trucking", records.length);
  } catch (err) {
    await markSynced(db, "freight_trucking", 0, String(err));
    throw err;
  }

  const truckingCount = records.length;

  // ── TRANSFERS ─────────────────────────────────────────────────────────────
  try {
    const rows = await fetchCsvExport(MASTER_ID, 1834454901);
    // Skip 1 header row (index 0)
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const dateRaw = clean(r[5]);
      const code = freightDateCode(dateRaw, today);
      if (!code) continue;

      const cost = freightAmount(clean(r[9])) || freightAmount(clean(r[8]));
      const dest = clean(r[4]);

      records.push({
        id: `transfer-${i + 1}`,
        move_type: "transfer",
        date_iso: codeToIso(code),
        date_code: code,
        destination: dest,
        carrier: clean(r[6]).replace(/\s+/g, " "),
        cost_usd: cost,
        load_type: loadType(clean(r[1])),
        is_nj_transfer: isNjDestination(dest) ? 1 : 0,
        distance_band: distanceBand(dest),
        source_row: i + 1,
        synced_at: now,
      });
    }
    await markSynced(db, "freight_transfer", records.length - truckingCount);
  } catch (err) {
    await markSynced(db, "freight_transfer", 0, String(err));
    throw err;
  }

  // Batch upsert all records; sweep stale rows.
  const stmts = records.map((rec) =>
    db.prepare(
      `INSERT OR REPLACE INTO freight_moves
       (id,move_type,date_iso,date_code,destination,carrier,cost_usd,load_type,is_nj_transfer,distance_band,source_row,synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      rec.id, rec.move_type, rec.date_iso, rec.date_code, rec.destination,
      rec.carrier, rec.cost_usd, rec.load_type, rec.is_nj_transfer,
      rec.distance_band, rec.source_row, rec.synced_at,
    )
  );
  await batchUpsert(db, stmts);
  await db.prepare("DELETE FROM freight_moves WHERE synced_at < ?").bind(now).run();

  return { trucking: truckingCount, transfer: records.length - truckingCount };
}
