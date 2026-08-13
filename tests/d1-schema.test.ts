import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { joinPayload, splitPayload } from "../worker/database";

const sql = readFileSync("migrations/0001_hybrid_read_model.sql", "utf8");
const snapshotSql = readFileSync("migrations/0002_operational_snapshots.sql", "utf8");

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
});
