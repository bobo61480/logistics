CREATE TABLE IF NOT EXISTS source_records (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(source, source_key)
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  checked_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS automation_events (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  source TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_record_id TEXT,
  previous_json TEXT,
  proposed_json TEXT,
  decision TEXT NOT NULL,
  confidence REAL,
  actor TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  next_retry_at TEXT,
  correlation_id TEXT,
  verification TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kpi_snapshots (
  generated_at TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  source_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_records_entity
  ON source_records(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_automation_events_entity
  ON automation_events(entity_type, entity_id, created_at);
