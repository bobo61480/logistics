import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Google Sheets -> D1 primary frontend mirror", () => {
  it("migrates typed operational tables and the generic workbook mirror", () => {
    const migration = read("migrations/0004_google_sheets_primary_read_model.sql");
    for (const table of [
      "imports",
      "schedule_items",
      "inventory_items",
      "freight_moves",
      "sales_entries",
      "fulfillment_tk_jobs",
      "sync_log",
      "google_sheet_documents",
      "google_sheet_tabs",
      "google_sheet_chunks",
      "google_sheet_sync_runs",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migration).toContain("idx_google_sheet_tabs_frontend");
    expect(migration).toContain("idx_google_sheet_chunks_lookup");
  });

  it("registers all three production workbooks and protects sensitive sheet content", () => {
    const manifest = read("config/google-sheets-manifest.json");
    expect(manifest).toContain("1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc");
    expect(manifest).toContain("14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I");
    expect(manifest).toContain("12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8");
    expect(manifest).toContain('"title":"LOGIN"');
    expect(manifest).toMatch(/"title":"LOGIN"[\s\S]{0,240}"mode":"metadata_only"/);
    expect(manifest).toMatch(/"title":"System Backups"[\s\S]{0,240}"mode":"metadata_only"/);
    expect(manifest).toMatch(/"title":"PENDING VERIFICATION"[\s\S]{0,320}"redactColumns": \[14\]/);
  });

  it("syncs workbook mirrors into D1 and serves only frontend-enabled tabs", () => {
    const sync = read("scripts/sync-google-sheets-d1.mjs");
    const workflow = read(".github/workflows/sync-google-sheets-d1.yml");
    const wrapper = read("worker/cached-index.ts");
    const sheetsApi = read("worker/sheets-api.ts");

    expect(sync).toContain("google_sheet_chunks");
    expect(sync).toContain("content_hash");
    expect(sync).toContain("redactColumns");
    expect(sync).toContain("metadata_only");
    expect(workflow).toContain("*/15 * * * *");
    expect(workflow).toContain("sync-google-sheets-d1.mjs");
    expect(wrapper).toContain('url.pathname === "/api/logistics/sheets"');
    expect(sheetsApi).toContain("frontend_enabled = 1");
    expect(sheetsApi).toContain("google_sheet_chunks");
  });

  it("keeps browser reads on same-origin D1 APIs instead of Google GViz", () => {
    const inventory = read("app/inventory-panels.tsx");
    const page = read("app/page.tsx");
    expect(inventory).toContain("/api/logistics/sheets");
    expect(inventory).not.toContain("docs.google.com/spreadsheets");
    expect(page).not.toContain("snapshot.kpis ?? fetchLiveKpis()");
  });
});
