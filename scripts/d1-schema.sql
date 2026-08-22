-- StyleKorean Logistics D1 Read Model
-- Mirrors: LOGISTICS MASTER 2026, WMS Invoice & Issue, NATIONAL/IHERB/MBX Dims
-- Authoritative source remains Google Sheets; D1 is the durable local read cache.
-- Generated: 2026-08-14

-- ──────────────────────────────────────────────────────────────
-- 1. imports
--    Raw rows from the IMPORTS tab (ocean + air inbound shipments).
--    Columns confirmed from importSourceRecords() in page.tsx:
--      col 0 = shipment_no, 2 = invoice, 3 = mbl, 4 = hbl,
--      7 = container, 12 = vessel, 13 = etd, 14 = eta,
--      16 = delivery_expected, 27 = status
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS imports (
  id                 TEXT    PRIMARY KEY,   -- 'import-{source_row}'
  source_row         INTEGER NOT NULL,
  shipment_no        TEXT    NOT NULL DEFAULT '',
  invoice            TEXT    NOT NULL DEFAULT '',
  mbl                TEXT    NOT NULL DEFAULT '',
  hbl                TEXT    NOT NULL DEFAULT '',
  container          TEXT    NOT NULL DEFAULT '',
  vessel             TEXT    NOT NULL DEFAULT '',
  etd                TEXT    NOT NULL DEFAULT '',
  eta                TEXT    NOT NULL DEFAULT '',
  delivery_expected  TEXT    NOT NULL DEFAULT '',
  status             TEXT    NOT NULL DEFAULT '',
  synced_at          INTEGER NOT NULL
);

-- ──────────────────────────────────────────────────────────────
-- 2. schedule_items
--    Computed schedule entries for both inbound and outbound.
--    Mirrors the ScheduleItem TypeScript type from page.tsx.
--    Sources: IMPORTS, INBOUND SHIPMENTS DATA, Outbound Shipping
--    Schedule, NATIONAL ORDER PROGRESS, Stylekorean/WMS,
--    Fulfillment TK API.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schedule_items (
  id                 TEXT    PRIMARY KEY,
  direction          TEXT    NOT NULL,           -- 'inbound' | 'outbound'
  date_iso           TEXT    NOT NULL,            -- YYYY-MM-DD (LA timezone)
  date_text          TEXT    NOT NULL DEFAULT '',
  title              TEXT    NOT NULL DEFAULT '',
  reference          TEXT    NOT NULL DEFAULT '',
  secondary          TEXT    NOT NULL DEFAULT '',
  status             TEXT    NOT NULL DEFAULT '',
  source_sheet       TEXT    NOT NULL DEFAULT '',
  source_row         INTEGER,
  source_url         TEXT    NOT NULL DEFAULT '',
  customer           TEXT    NOT NULL DEFAULT '',
  customer_no        TEXT    NOT NULL DEFAULT '',
  po                 TEXT    NOT NULL DEFAULT '',
  invoice            TEXT    NOT NULL DEFAULT '',
  shipment_no        TEXT    NOT NULL DEFAULT '',
  container          TEXT    NOT NULL DEFAULT '',
  mbl                TEXT    NOT NULL DEFAULT '',
  hbl                TEXT    NOT NULL DEFAULT '',
  pro                TEXT    NOT NULL DEFAULT '',
  carrier            TEXT    NOT NULL DEFAULT '',
  carrier_reference  TEXT    NOT NULL DEFAULT '',
  tracking_number    TEXT    NOT NULL DEFAULT '',
  ship_date          TEXT    NOT NULL DEFAULT '',
  mode               TEXT    NOT NULL DEFAULT '',
  vessel             TEXT    NOT NULL DEFAULT '',
  pod                TEXT    NOT NULL DEFAULT '',
  eta                TEXT    NOT NULL DEFAULT '',
  delivery_expected  TEXT    NOT NULL DEFAULT '',
  is_small_parcel    INTEGER NOT NULL DEFAULT 0,  -- boolean
  shipping_method    TEXT    NOT NULL DEFAULT '',
  source_type        TEXT    NOT NULL DEFAULT '',
  department         TEXT    NOT NULL DEFAULT '', -- 'Wholesale'|'B2B/E-Com'|'Nationals'|'MBX'|'NJ'
  synced_at          INTEGER NOT NULL
);

-- ──────────────────────────────────────────────────────────────
-- 3. inventory_items
--    Mirrors InventoryItem from page.tsx.
--    category distinguishes dashboard vs SKW and inbound vs stock.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_items (
  id               TEXT    PRIMARY KEY,
  category         TEXT    NOT NULL,   -- 'dashboard_inbound'|'dashboard_stock'|'skw_inbound'|'skw_stock'
  shipment_no      TEXT    NOT NULL DEFAULT '',
  product_name     TEXT    NOT NULL DEFAULT '',
  sku              TEXT    NOT NULL DEFAULT '',
  upc              TEXT    NOT NULL DEFAULT '',
  expiration_date  TEXT    NOT NULL DEFAULT '',
  pallet_number    TEXT    NOT NULL DEFAULT '',
  quantity         INTEGER NOT NULL DEFAULT 0,
  location         TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT '',
  synced_at        INTEGER NOT NULL
);

-- ──────────────────────────────────────────────────────────────
-- 4. freight_moves
--    WH Trucking (GID 852802817) + Transfer (GID 1834454901).
--    Used for shipping KPIs: cost by carrier, LTL/FTL split,
--    distance-band averages, NJ transfer tracking.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS freight_moves (
  id             TEXT    PRIMARY KEY,     -- 'trucking-{row}' | 'transfer-{row}'
  move_type      TEXT    NOT NULL,        -- 'trucking' | 'transfer'
  date_iso       TEXT    NOT NULL,        -- YYYY-MM-DD
  date_code      INTEGER NOT NULL,        -- YYYYMMDD for fast range queries
  destination    TEXT    NOT NULL DEFAULT '',
  carrier        TEXT    NOT NULL DEFAULT '',
  cost_usd       REAL    NOT NULL DEFAULT 0,
  load_type      TEXT    NOT NULL DEFAULT '',  -- 'LTL' | 'FTL'
  is_nj_transfer INTEGER NOT NULL DEFAULT 0,   -- boolean
  distance_band  TEXT    NOT NULL DEFAULT '',  -- 'local'|'california'|'out-of-state'|'unknown'
  source_row     INTEGER NOT NULL,
  synced_at      INTEGER NOT NULL
);

-- ──────────────────────────────────────────────────────────────
-- 5. sales_entries
--    WMS Wholesale sheet col G (GID 0, rows from row 3) and
--    NATIONAL ORDER PROGRESS sheet col E/G (GID 99300389).
--    Used for WMS/Nationals MTD + YTD KPI panels.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_entries (
  id          TEXT    PRIMARY KEY,    -- 'wms-{row}' | 'nationals-{row}'
  source      TEXT    NOT NULL,       -- 'wms' | 'nationals'
  date_iso    TEXT    NOT NULL,
  date_code   INTEGER NOT NULL,       -- YYYYMMDD
  amount_usd  REAL    NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT '',
  synced_at   INTEGER NOT NULL
);

-- ──────────────────────────────────────────────────────────────
-- 6. fulfillment_tk_jobs
--    From FULFILLMENT_API_URL (Apps Script doGet op=getSalesOverview),
--    filtered to method='TK'. Mirrors FulfillmentTkJob type.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fulfillment_tk_jobs (
  id                TEXT    PRIMARY KEY,   -- normalized invoice or 'fulfillment-tk-{index}'
  invoice           TEXT    NOT NULL DEFAULT '',
  customer          TEXT    NOT NULL DEFAULT '',
  ship_date         TEXT    NOT NULL DEFAULT '',
  amount_usd        REAL    NOT NULL DEFAULT 0,
  inspection        TEXT    NOT NULL DEFAULT '',
  insp_end          TEXT    NOT NULL DEFAULT '',
  moved_to_packing  INTEGER NOT NULL DEFAULT 0,   -- boolean
  dims_count        INTEGER NOT NULL DEFAULT 0,
  dim_included_in   TEXT    NOT NULL DEFAULT '',
  pick_start        TEXT    NOT NULL DEFAULT '',
  pick_complete     INTEGER NOT NULL DEFAULT 0,   -- boolean
  status            TEXT    NOT NULL DEFAULT '',
  pick_anomaly      INTEGER NOT NULL DEFAULT 0,   -- boolean
  synced_at         INTEGER NOT NULL
);

-- ──────────────────────────────────────────────────────────────
-- 7. sync_log
--    One row per data source. Tracks last successful sync
--    timestamp, row count written, and any error string.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_log (
  source         TEXT    PRIMARY KEY,
  last_synced_at INTEGER,
  row_count      INTEGER,
  error          TEXT
);
