import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { joinPayload, readCurrentSnapshot, splitPayload } from "../worker/database";

const sql = readFileSync("migrations/0001_hybrid_read_model.sql", "utf8");
const snapshotSql = readFileSync("migrations/0002_operational_snapshots.sql", "utf8");
const MAX_SAFE_PARTS_FOR_TEST = 44;

describe("hybrid read model schema", () => {
  it("stores source provenance and append-only automation audit records", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS source_records");
    expect(sql).toContain("UNIQUE(source, source_key)");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS automation_runs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS automation_events");
    expect(sql).toContain("correlation_id TEXT");
    expect(sql).toContain("verification TEXT");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS kpi_snapshots");
  });

  it("stores immutable chunked snapshots behind an atomic current pointer", () => {
    expect(snapshotSql).toContain("CREATE TABLE IF NOT EXISTS operational_snapshots");
    expect(snapshotSql).toContain("CREATE TABLE IF NOT EXISTS operational_snapshot_parts");
    expect(snapshotSql).toContain("payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0 AND payload_bytes <= 524288)");
    expect(snapshotSql).toContain("CREATE TABLE IF NOT EXISTS operational_state");
    expect(snapshotSql).toContain("FOREIGN KEY(snapshot_id)");
  });

  it("round-trips large multilingual JSON values without crossing D1 row limits", () => {
    const value = { rows: Array.from({ length: 25_000 }, (_, index) => [index, "화물📦", `INV-${index}`]) };
    const chunks = splitPayload(value);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => new TextEncoder().encode(chunk).byteLength))).toBeLessThanOrEqual(524_288);
    expect(joinPayload(chunks)).toEqual(value);
  });

  it("packs large ASCII-heavy snapshots within the D1 query budget", () => {
    const value = { payload: "x".repeat(6 * 1024 * 1024) };
    const chunks = splitPayload(value);
    expect(chunks.length).toBeLessThan(MAX_SAFE_PARTS_FOR_TEST);
    expect(Math.max(...chunks.map((chunk) => new TextEncoder().encode(chunk).byteLength))).toBeLessThanOrEqual(524_288);
    expect(joinPayload(chunks)).toEqual(value);
  });

  it("rejects snapshot parts whose persisted byte count does not match their payload", async () => {
    const payloads = [
      ["sourceHealth", JSON.stringify([])],
      ["sources", JSON.stringify({})],
      ["kpis", JSON.stringify(null)],
      ["kpiError", JSON.stringify(null)],
    ] as const;
    const parts = payloads.map(([part_name, payload_text]) => ({
      part_name,
      part_index: 0,
      payload_text,
      payload_bytes: new TextEncoder().encode(payload_text).byteLength,
    }));
    parts[1].payload_bytes += 1;
    const db = {
      prepare: vi.fn(() => ({})),
      batch: vi.fn(async () => [
        {
          results: [{
            id: "snapshot-1",
            generated_at: "2026-08-13T06:00:00.000Z",
            version: "test",
            source_count: 0,
            part_count: parts.length,
            payload_bytes: parts.reduce((sum, part) => sum + part.payload_bytes, 0),
            created_at: "2026-08-13 06:00:00",
          }],
        },
        { results: parts },
      ]),
    } as unknown as D1Database;

    await expect(readCurrentSnapshot(db)).rejects.toThrow("failed integrity validation");
  });
});
