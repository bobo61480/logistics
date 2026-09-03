import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hashRow,
  isSheetGrid,
  partitionSources,
  readSheetGrids,
  syncSheetGrids,
  updateSheetCell,
} from "../worker/sheet-store";
import { applyConfirmedStatusToSnapshot } from "../worker/database";

const migration = readFileSync("migrations/0005_relational_sheet_store.sql", "utf8");

type Recorded = { sql: string; args: unknown[] };

/**
 * Minimal D1 stub: records every statement and answers reads from a canned
 * result queue, so tests assert on what the store *writes* rather than on a
 * SQLite reimplementation.
 */
function stubDatabase(results: Array<{ results: unknown[] } | unknown | null>) {
  const recorded: Recorded[] = [];
  const queue = [...results];
  const next = () => (queue.length ? queue.shift() : { results: [] });
  const statement = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...bound: unknown[]) => statement(sql, bound),
    all: async () => {
      recorded.push({ sql, args });
      return (next() as { results: unknown[] }) ?? { results: [] };
    },
    first: async () => {
      recorded.push({ sql, args });
      return next();
    },
    run: async () => {
      recorded.push({ sql, args });
      return { success: true };
    },
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
      for (const item of statements) recorded.push({ sql: item.sql, args: item.args });
      return statements.map(() => next() ?? { results: [] });
    },
  } as unknown as D1Database;
  return { db, recorded };
}

const writesTo = (recorded: Recorded[], table: string) =>
  recorded.filter((entry) => /^\s*(INSERT|UPDATE|DELETE)/i.test(entry.sql) && entry.sql.includes(table));

describe("relational sheet store", () => {
  it("creates row-addressable sheet tables keyed by source and row index", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS sheet_sources");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS sheet_rows");
    expect(migration).toContain("PRIMARY KEY (source_key, row_index)");
    expect(migration).toContain("FOREIGN KEY (source_key) REFERENCES sheet_sources(source_key) ON DELETE CASCADE");
  });

  it("separates grid sources from non-grid snapshot metadata", () => {
    const { grids, meta } = partitionSources({
      imports: [["A"], ["B"]],
      outbound: [["C"]],
      outboundMeta: { sheetName: "Outbound Shipping Schedule" },
      gmailIngestion: [{ status: "committed" }],
      cmsInventoryConfigured: true,
      truckingRequests: null,
    });
    expect(Object.keys(grids).sort()).toEqual(["imports", "outbound"]);
    expect(Object.keys(meta).sort()).toEqual(["cmsInventoryConfigured", "gmailIngestion", "outboundMeta", "truckingRequests"]);
    expect(isSheetGrid([["A"]])).toBe(true);
    expect(isSheetGrid([{ a: 1 }])).toBe(false);
  });

  it("fingerprints rows so unchanged content is stable and edits are detected", () => {
    expect(hashRow(["INV-1", "SHIPPED"])).toBe(hashRow(["INV-1", "SHIPPED"]));
    expect(hashRow(["INV-1", "SHIPPED"])).not.toBe(hashRow(["INV-1", "DELIVERED"]));
    expect(hashRow(["INV-1", ""])).not.toBe(hashRow(["INV-1"]));
    expect(hashRow(["화물📦"])).toMatch(/^[0-9a-f]{16}$/);
  });

  it("writes only the rows whose content changed", async () => {
    const rows = [["STATUS"], ["SCHEDULED"], ["SHIPPED"]];
    const { db, recorded } = stubDatabase([
      {
        results: [
          { row_index: 0, row_hash: hashRow(rows[0]) },
          { row_index: 1, row_hash: hashRow(rows[1]) },
          { row_index: 2, row_hash: "stale-hash" },
        ],
      },
    ]);
    const stats = await syncSheetGrids(db, { imports: rows }, "2026-09-02T00:00:00.000Z");

    expect(stats.rowsTotal).toBe(3);
    expect(stats.rowsWritten).toBe(1);
    const rowWrites = recorded.filter((entry) => entry.sql.startsWith("INSERT INTO sheet_rows"));
    expect(rowWrites).toHaveLength(1);
    expect(rowWrites[0].args).toEqual(["imports", 2, hashRow(rows[2]), JSON.stringify(rows[2])]);
  });

  it("drops rows the source no longer has and sources that vanished", async () => {
    const { db, recorded } = stubDatabase([
      { results: [0, 1, 2, 3].map((row_index) => ({ row_index, row_hash: "stale" })) },
    ]);
    const stats = await syncSheetGrids(db, { imports: [["STATUS"], ["SCHEDULED"]] }, "2026-09-02T00:00:00.000Z");

    expect(stats.rowsDeleted).toBe(2);
    expect(recorded.some((entry) => entry.sql.startsWith("DELETE FROM sheet_rows") && entry.args[1] === 2)).toBe(true);
    expect(recorded.some((entry) => entry.sql.startsWith("DELETE FROM sheet_sources"))).toBe(true);
  });

  it("rejects a grid whose stored rows do not match its declared row count", async () => {
    const { db } = stubDatabase([
      { results: [{ source_key: "imports", row_count: 3 }] },
      { results: [{ source_key: "imports", row_index: 0, cells_json: '["STATUS"]' }] },
    ]);
    await expect(readSheetGrids(db)).rejects.toThrow("failed integrity validation");
  });

  it("reassembles stored grids in row order", async () => {
    const { db } = stubDatabase([
      { results: [{ source_key: "imports", row_count: 2 }] },
      {
        results: [
          { source_key: "imports", row_index: 0, cells_json: '["STATUS"]' },
          { source_key: "imports", row_index: 1, cells_json: '["SHIPPED"]' },
        ],
      },
    ]);
    await expect(readSheetGrids(db)).resolves.toEqual({ imports: [["STATUS"], ["SHIPPED"]] });
  });

  it("updates one cell in place without rewriting its neighbours", async () => {
    const { db, recorded } = stubDatabase([{ cells_json: '["INV-1","","SCHEDULED"]' }]);
    const result = await updateSheetCell(db, { sourceKey: "imports", rowIndex: 4, columnIndex: 2, value: "DELIVERED" });

    expect(result.cells).toEqual(["INV-1", "", "DELIVERED"]);
    const updates = recorded.filter((entry) => entry.sql.startsWith("UPDATE sheet_rows"));
    expect(updates).toHaveLength(1);
    expect(updates[0].args).toEqual([result.hash, JSON.stringify(result.cells), "imports", 4]);
  });

  it("refuses to write back a row the relational store does not hold", async () => {
    const { db } = stubDatabase([null]);
    await expect(updateSheetCell(db, { sourceKey: "imports", rowIndex: 9, columnIndex: 1, value: "SHIPPED" }))
      .rejects.toThrow("does not exist");
  });
});

describe("confirmed status writeback", () => {
  const snapshotMeta = [
    {
      results: [{
        id: "snapshot-1",
        generated_at: "2026-09-02T00:00:00.000Z",
        version: "test",
        source_count: 0,
        part_count: 4,
        payload_bytes: 12,
        created_at: "2026-09-02 00:00:00",
      }],
    },
    {
      results: [
        { part_name: "kpiError", part_index: 0, payload_text: "null", payload_bytes: 4 },
        { part_name: "kpis", part_index: 0, payload_text: "null", payload_bytes: 4 },
        { part_name: "sourceHealth", part_index: 0, payload_text: "[]", payload_bytes: 2 },
        { part_name: "sources", part_index: 0, payload_text: "{}", payload_bytes: 2 },
      ],
    },
  ];

  it("applies the status as a single row update instead of republishing the snapshot", async () => {
    const { db, recorded } = stubDatabase([
      ...snapshotMeta,
      { results: [
        { row_index: 0, cells_json: '["INVOICE","STATUS"]' },
        { row_index: 1, cells_json: '["INV-1","SCHEDULED"]' },
      ] },
      { cells_json: '["INV-1","SCHEDULED"]' },
    ]);

    const result = await applyConfirmedStatusToSnapshot(db, {
      sourceSheet: "IMPORTS",
      sourceRow: 2,
      entityId: "INV-1",
      status: "SHIPPED",
    });

    expect(result).toMatchObject({ sourceKey: "imports", targetIndex: 1, statusColumn: 1, rowsWritten: 1 });
    expect(writesTo(recorded, "sheet_rows")).toHaveLength(1);
    // The whole point of the relational store: no snapshot republish per write.
    expect(writesTo(recorded, "operational_snapshots")).toHaveLength(0);
    expect(writesTo(recorded, "operational_snapshot_parts")).toHaveLength(0);
  });

  it("refuses sheets that are not part of the editable read model", async () => {
    const { db } = stubDatabase([...snapshotMeta]);
    await expect(applyConfirmedStatusToSnapshot(db, {
      sourceSheet: "TRANSFERS",
      sourceRow: 2,
      entityId: "T-1",
      status: "SHIPPED",
    })).rejects.toThrow("does not contain editable source");
  });
});
