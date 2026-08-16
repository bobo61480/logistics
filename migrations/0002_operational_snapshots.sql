PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS operational_snapshots (
  id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  version TEXT NOT NULL,
  source_count INTEGER NOT NULL CHECK(source_count >= 0),
  part_count INTEGER NOT NULL CHECK(part_count >= 0),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operational_snapshot_parts (
  snapshot_id TEXT NOT NULL,
  part_name TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK(part_index >= 0),
  payload_text TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0 AND payload_bytes <= 524288),
  PRIMARY KEY(snapshot_id, part_name, part_index),
  FOREIGN KEY(snapshot_id) REFERENCES operational_snapshots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operational_state (
  key TEXT PRIMARY KEY CHECK(key = 'current_snapshot'),
  snapshot_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(snapshot_id) REFERENCES operational_snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_operational_snapshots_generated
  ON operational_snapshots(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_parts_snapshot
  ON operational_snapshot_parts(snapshot_id, part_name, part_index);
