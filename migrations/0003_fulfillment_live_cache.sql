-- Durable cache for the authoritative SK-B2B fulfillment Apps Script feed.
-- This keeps fulfillment picking/inspection/packing state available even when
-- Google Apps Script has a slow cold start or transient redirect/CORS issue.
CREATE TABLE IF NOT EXISTS fulfillment_live_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  job_count INTEGER NOT NULL DEFAULT 0,
  source_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fulfillment_live_cache_updated_at
  ON fulfillment_live_cache(updated_at);
