# Hybrid Read Model and Control Tower API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser-side multi-workbook assembly with a coherent Cloudflare Worker snapshot/command API and introduce a normalized D1 read model/audit schema without making the database authoritative prematurely.

**Architecture:** Keep the Next.js app as static assets, add a Worker script that handles `/api/*` and delegates all other requests to the `ASSETS` binding. The API can serve a live normalized snapshot from source adapters immediately; D1 becomes an optional mirrored read/audit store activated once a production database binding is provisioned.

**Tech Stack:** Cloudflare Workers + static assets binding, Cloudflare D1, Wrangler 4, TypeScript, Next.js static export, Google Sheets/App Script upstreams.

## Global Constraints

- Sheets remain authoritative during hybrid stabilization.
- Database writes may not overwrite operational Sheets merely due to timestamps.
- Every database row stores source provenance.
- API commands verify source persistence before reporting success.

---

### Task 1: Add a Worker entry point for API + static assets

**Files:**
- Create: `worker/index.ts`
- Modify: `wrangler.toml`
- Test: `tests/worker-routing.test.ts`

**Interfaces:**

```ts
interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  APPS_SCRIPT_WRITE_URL?: string;
}
```

Worker routing:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/logistics/snapshot") return handleSnapshot(request, env);
    if (url.pathname === "/api/logistics/status") return handleStatus(request, env);
    if (url.pathname === "/api/logistics/health") return handleHealth(request, env);
    return env.ASSETS.fetch(request);
  },
};
```

- [ ] Add failing source/routing tests.
- [ ] Configure `main = "worker/index.ts"`, `[assets] binding = "ASSETS"`, and selective `run_worker_first` for `/api/*` while retaining `directory = "./out"`.
- [ ] Run tests/typecheck/build.
- [ ] Commit `feat: add control tower worker API shell`.

### Task 2: Build coherent upstream snapshot fetcher

**Files:**
- Create: `worker/sources.ts`
- Create: `worker/snapshot.ts`
- Reuse/extract: pure adapters under `lib/adapters/*`
- Test: `tests/worker-snapshot.test.ts`

**Interfaces:**

```ts
export type SourceHealth = {
  name: string;
  ok: boolean;
  fetchedAt: string;
  latencyMs: number;
  error?: string;
};

export type OperationalSnapshot = {
  ok: true;
  generatedAt: string;
  sourceHealth: SourceHealth[];
  sources: {
    imports: string[][];
    outbound: string[][];
    nationalOutbound: unknown;
    salesOutbound: unknown;
    inventoryDashboardTable: unknown;
    skwInboundTable: unknown;
    skwStockTable: unknown;
  };
  kpis: unknown;
  automationHealth?: unknown;
};
```

- [ ] Write fixture tests proving one request produces one consistent `generatedAt` and source-health array.
- [ ] Fetch each required source once with bounded timeouts and clear source-specific errors.
- [ ] Return partial health diagnostics but require the core imports/outbound sources before declaring snapshot success.
- [ ] Calculate KPIs from the same fetched source rows rather than issuing a second client-side set of requests.
- [ ] Commit `feat: serve normalized operational snapshot`.

### Task 3: Add safe status command proxy

**Files:**
- Create: `worker/status-command.ts`
- Modify: `worker/index.ts`
- Test: `tests/worker-status.test.ts`

**Interfaces:**

```ts
export type StatusCommand = {
  kind: "inbound" | "outbound";
  sourceSheet: string;
  sourceRow: number;
  shipmentNo?: string;
  container?: string;
  invoice?: string;
  customer?: string;
  shipDate?: string;
  currentStatus?: string;
  status: string;
};
```

- [ ] Validate `status` with the shared canonical status module.
- [ ] Reject missing source identity or invalid row numbers.
- [ ] POST to the configured Apps Script write endpoint.
- [ ] Require `{ ok: true, status: canonicalRequestedStatus }` before returning 200.
- [ ] Never fall back after validation/concurrency errors.
- [ ] Add correlation id in response/logging.
- [ ] Commit `feat: add verified status command proxy`.

### Task 4: Add D1 normalized schema

**Files:**
- Create: `migrations/0001_hybrid_read_model.sql`
- Create: `worker/db.ts`
- Test: `tests/d1-schema.test.ts`

**Interfaces:**

Core schema:

```sql
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

CREATE INDEX IF NOT EXISTS idx_source_records_entity ON source_records(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_automation_events_entity ON automation_events(entity_type, entity_id, created_at);
```

Additional shipment/inventory tables may be introduced in later migrations after source parity proves which fields are stable; avoid premature duplicated schema.

- [ ] Validate migration contents with tests.
- [ ] Add D1 helpers that no-op when `env.DB` is absent.
- [ ] Commit `feat: add hybrid audit read model schema`.

### Task 5: Mirror snapshots/events into D1 without changing authority

**Files:**
- Modify: `worker/snapshot.ts`
- Modify: `worker/status-command.ts`
- Modify: `worker/db.ts`
- Test: `tests/hybrid-reconciliation.test.ts`

- [ ] Hash normalized source records deterministically.
- [ ] Upsert observed source records by `(source, source_key)`.
- [ ] Store status command audit event only after upstream persistence response.
- [ ] Keep Sheets/Apps Script as authoritative command destination.
- [ ] If D1 write fails after source succeeds, return source success with `auditWarning` rather than retrying/destructively rewriting the source.
- [ ] Commit `feat: mirror operations into hybrid audit store`.

### Task 6: Add reconciliation endpoint

**Files:**
- Create: `worker/reconciliation.ts`
- Modify: `worker/index.ts`
- Test: `tests/hybrid-reconciliation.test.ts`

**Interface:** `GET /api/logistics/reconciliation` returns counts for stale source records, unapplied/review events, and most recent automation runs; it does not modify source data.

- [ ] Add read-only query helpers.
- [ ] Return 503 with explicit `databaseConfigured: false` when D1 is not bound.
- [ ] Commit `feat: expose hybrid reconciliation health`.

### Task 7: Provision D1 binding when credentials permit

**Files:**
- Modify: `wrangler.toml` only after Wrangler returns a real database UUID.
- Modify: `.github/workflows/deploy-cloudflare.yml` to apply migrations before deploy when D1 is configured.

- [ ] Run `npx wrangler d1 list --json` using the existing production Cloudflare credentials and search for database name `stylekorean-logistics`.
- [ ] If it does not exist, run `npx wrangler d1 create stylekorean-logistics` exactly once and capture the returned database UUID from Wrangler output.
- [ ] Add this exact returned UUID as `database_id` under a `[[d1_databases]]` block with `binding = "DB"`, `database_name = "stylekorean-logistics"`, and `migrations_dir = "migrations"`.
- [ ] Apply `npx wrangler d1 migrations apply stylekorean-logistics --remote` before Worker deployment.
- [ ] If the available execution environment cannot access the existing Cloudflare credentials, leave `env.DB` optional, deploy the functioning snapshot/status API without D1, and record `D1 binding not provisioned because Cloudflare credentials are inaccessible to the available tools` as the exact external provisioning blocker; do not invent a UUID.

### Task 8: Switch web client to the real same-origin API

**Files:**
- Modify: `lib/api/operational-client.ts`
- Modify: `app/page.tsx`
- Test: `tests/operational-client.test.ts`

- [ ] Once Worker API is deployed, make `/api/logistics/snapshot` and `/api/logistics/status` the real same-origin defaults.
- [ ] Keep direct-Sheets fallback only for snapshot transport failure during parity period.
- [ ] Show `sourceHealth` in the UI instead of generic `3 live workbooks connected` text.
- [ ] Commit `feat: use control tower snapshot API`.

### Task 9: Verify hybrid parity

- [ ] Unit tests, typecheck, build.
- [ ] Deploy Worker.
- [ ] Compare API snapshot shipment counts/KPIs against direct-source fallback for the same refresh window.
- [ ] Confirm status write returns source-confirmed status.
- [ ] Confirm application remains usable when D1 is absent and gains reconciliation when D1 is present.
