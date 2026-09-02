PRAGMA foreign_keys = ON;

-- Relational mirror of every grid-shaped Google Sheet source.
-- Replaces the "re-serialize the whole snapshot on every write" model: a
-- refresh writes only the rows whose content hash changed, and a confirmed
-- status writeback updates exactly one row.
CREATE TABLE IF NOT EXISTS sheet_sources (
  source_key   TEXT PRIMARY KEY,
  row_count    INTEGER NOT NULL CHECK(row_count >= 0),
  column_count INTEGER NOT NULL CHECK(column_count >= 0),
  generated_at TEXT NOT NULL,
  synced_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sheet_rows (
  source_key TEXT NOT NULL,
  row_index  INTEGER NOT NULL CHECK(row_index >= 0),
  row_hash   TEXT NOT NULL,
  cells_json TEXT NOT NULL,
  PRIMARY KEY (source_key, row_index),
  FOREIGN KEY (source_key) REFERENCES sheet_sources(source_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sheet_rows_source
  ON sheet_rows(source_key, row_index);
