/**
 * src/sync/index.ts
 * Orchestrates all sync modules. Called by the cron handler and the
 * manual /api/sync endpoint in the Worker.
 *
 * Each source is synced independently so a failure in one doesn't block
 * the others. Errors are surfaced in sync_log.error and returned in the
 * result summary.
 */

import { syncImports } from "./imports";
import { syncFreight }  from "./freight";
import { syncSales }    from "./sales";
import { syncFulfillment } from "./fulfillment";

export interface SyncResult {
  ok: boolean;
  duration_ms: number;
  sources: Record<string, { ok: boolean; count?: number | Record<string, number>; error?: string }>;
}

const SOURCES = ["imports", "freight", "sales", "fulfillment"] as const;
type Source = (typeof SOURCES)[number];

export async function syncAll(db: D1Database, only?: Source): Promise<SyncResult> {
  const started = Date.now();
  const sources: SyncResult["sources"] = {};
  let anyOk = false;

  async function run<T>(
    name: string,
    fn: () => Promise<T>,
  ) {
    if (only && name !== only) return;
    try {
      const count = await fn();
      sources[name] = { ok: true, count: count as unknown as number | Record<string, number> };
      anyOk = true;
    } catch (err) {
      sources[name] = { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  }

  await run("imports",     () => syncImports(db));
  await run("freight",     () => syncFreight(db));
  await run("sales",       () => syncSales(db));
  await run("fulfillment", () => syncFulfillment(db));

  return {
    ok: anyOk,
    duration_ms: Date.now() - started,
    sources,
  };
}
