import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("migrations/0001_hybrid_read_model.sql", "utf8");

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
});
