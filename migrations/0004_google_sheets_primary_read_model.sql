-- Complete Google Sheets -> Cloudflare D1 read model.
-- Google Sheets remains the operational authority for source-owned fields;
-- D1 is the primary frontend data source and durable synchronized read model.

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  source_row INTEGER NOT NULL,
  shipment_no TEXT NOT NULL DEFAULT '',
  invoice TEXT NOT NULL DEFAULT '',
  mbl TEXT NOT NULL DEFAULT '',
  hbl TEXT NOT NULL DEFAULT '',
  container TEXT NOT NULL DEFAULT '',
  vessel TEXT NOT NULL DEFAULT '',
  etd TEXT NOT NULL DEFAULT '',
  eta TEXT NOT NULL DEFAULT '',
  delivery_expected TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_items (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  date_iso TEXT NOT NULL,
  date_text TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  secondary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  source_sheet TEXT NOT NULL DEFAULT '',
  source_row INTEGER,
  source_url TEXT NOT NULL DEFAULT '',
  customer TEXT NOT NULL DEFAULT '',
  customer_no TEXT NOT NULL DEFAULT '',
  po TEXT NOT NULL DEFAULT '',
  invoice TEXT NOT NULL DEFAULT '',
  shipment_no TEXT NOT NULL DEFAULT '',
  container TEXT NOT NULL DEFAULT '',
  mbl TEXT NOT NULL DEFAULT '',
  hbl TEXT NOT NULL DEFAULT '',
  pro TEXT NOT NULL DEFAULT '',
  carrier TEXT NOT NULL DEFAULT '',
  carrier_reference TEXT NOT NULL DEFAULT '',
  tracking_number TEXT NOT NULL DEFAULT '',
  ship_date TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '',
  vessel TEXT NOT NULL DEFAULT '',
  pod TEXT NOT NULL DEFAULT '',
  eta TEXT NOT NULL DEFAULT '',
  delivery_expected TEXT NOT NULL DEFAULT '',
  is_small_parcel INTEGER NOT NULL DEFAULT 0,
  shipping_method TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  shipment_no TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  upc TEXT NOT NULL DEFAULT '',
  expiration_date TEXT NOT NULL DEFAULT '',
  pallet_number TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS freight_moves (
  id TEXT PRIMARY KEY,
  move_type TEXT NOT NULL,
  date_iso TEXT NOT NULL,
  date_code INTEGER NOT NULL,
  destination TEXT NOT NULL DEFAULT '',
  carrier TEXT NOT NULL DEFAULT '',
  cost_usd REAL NOT NULL DEFAULT 0,
  load_type TEXT NOT NULL DEFAULT '',
  is_nj_transfer INTEGER NOT NULL DEFAULT 0,
  distance_band TEXT NOT NULL DEFAULT '',
  source_row INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_entries (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  date_iso TEXT NOT NULL,
  date_code INTEGER NOT NULL,
  amount_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '',
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fulfillment_tk_jobs (
  id TEXT PRIMARY KEY,
  invoice TEXT NOT NULL DEFAULT '',
  customer TEXT NOT NULL DEFAULT '',
  ship_date TEXT NOT NULL DEFAULT '',
  amount_usd REAL NOT NULL DEFAULT 0,
  inspection TEXT NOT NULL DEFAULT '',
  insp_end TEXT NOT NULL DEFAULT '',
  moved_to_packing INTEGER NOT NULL DEFAULT 0,
  dims_count INTEGER NOT NULL DEFAULT 0,
  dim_included_in TEXT NOT NULL DEFAULT '',
  pick_start TEXT NOT NULL DEFAULT '',
  pick_complete INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '',
  pick_anomaly INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  source TEXT PRIMARY KEY,
  last_synced_at INTEGER,
  row_count INTEGER,
  error TEXT
);

-- Workbook registry. This is not exposed directly to the browser; it provides
-- provenance and lets reconciliation distinguish each authoritative document.
CREATE TABLE IF NOT EXISTS google_sheet_documents (
  spreadsheet_id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_synced_at TEXT,
  last_error TEXT
);

-- One row per tab. frontend_enabled is an explicit allow-list: mirrored data is
-- private by default and only operational tabs needed by the product are served.
CREATE TABLE IF NOT EXISTS google_sheet_tabs (
  spreadsheet_id TEXT NOT NULL,
  sheet_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  sheet_index INTEGER NOT NULL DEFAULT 0,
  sheet_type TEXT NOT NULL DEFAULT 'GRID',
  hidden INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'mirror',
  frontend_enabled INTEGER NOT NULL DEFAULT 0,
  redact_columns_json TEXT NOT NULL DEFAULT '[]',
  row_count_hint INTEGER NOT NULL DEFAULT 0,
  column_count_hint INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  last_checked_at TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  PRIMARY KEY (spreadsheet_id, sheet_id),
  FOREIGN KEY (spreadsheet_id) REFERENCES google_sheet_documents(spreadsheet_id) ON DELETE CASCADE
);

-- Chunked raw rows preserve sheet fidelity without hitting D1 row/query limits.
-- payload_json is a JSON array of rows after safety redactions have been applied.
CREATE TABLE IF NOT EXISTS google_sheet_chunks (
  spreadsheet_id TEXT NOT NULL,
  sheet_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  row_start INTEGER NOT NULL,
  row_end INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (spreadsheet_id, sheet_id, chunk_index),
  FOREIGN KEY (spreadsheet_id, sheet_id) REFERENCES google_sheet_tabs(spreadsheet_id, sheet_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS google_sheet_sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  checked_tabs INTEGER NOT NULL DEFAULT 0,
  changed_tabs INTEGER NOT NULL DEFAULT 0,
  error_tabs INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_schedule_items_date ON schedule_items(direction, date_iso);
CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items(category, sku);
CREATE INDEX IF NOT EXISTS idx_freight_moves_date ON freight_moves(date_code, move_type);
CREATE INDEX IF NOT EXISTS idx_sales_entries_date ON sales_entries(source, date_code);
CREATE INDEX IF NOT EXISTS idx_google_sheet_tabs_frontend
  ON google_sheet_tabs(frontend_enabled, spreadsheet_id, title);
CREATE INDEX IF NOT EXISTS idx_google_sheet_chunks_lookup
  ON google_sheet_chunks(spreadsheet_id, sheet_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_google_sheet_sync_runs_started
  ON google_sheet_sync_runs(started_at DESC);
