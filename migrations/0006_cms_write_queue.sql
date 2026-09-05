PRAGMA foreign_keys = ON;

-- CMS write rollout: every browser-initiated CMS write is first recorded here as
-- a queued command. The write gateway (stylekorean-cms-write-gateway) drains the
-- queue; in dry-run mode rows are marked 'simulated' and CMS is never called.
-- This table is the audit trail for the entire write path.
CREATE TABLE IF NOT EXISTS cms_write_queue (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  operation       TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK(status IN ('queued', 'processing', 'simulated', 'sent', 'failed')),
  dry_run         INTEGER NOT NULL DEFAULT 1,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error      TEXT,
  result_json     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  processed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_cms_write_queue_status
  ON cms_write_queue(status, created_at);
