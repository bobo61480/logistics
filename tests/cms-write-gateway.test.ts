import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker, { isDryRun, type CmsWriteEnv } from "../cms-write-gateway/worker";
import { handleCmsWriteCommand } from "../worker/cms-write-command";

type QueueRow = {
  id: string;
  idempotency_key: string;
  operation: string;
  payload_json: string;
  status: string;
  dry_run: number;
  attempts: number;
  last_error: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
};

/** Minimal in-memory D1 stand-in covering exactly the gateway's queries. */
function fakeD1() {
  const rows = new Map<string, QueueRow>();
  const byIdempotency = new Map<string, string>();
  const db = {
    rows,
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>() {
              if (query.includes("WHERE idempotency_key = ?")) {
                const id = byIdempotency.get(String(params[0]));
                return (id ? rows.get(id) : null) as T | null;
              }
              throw new Error(`Unsupported first() query: ${query}`);
            },
            async run() {
              if (query.startsWith("INSERT INTO cms_write_queue")) {
                const [id, idempotencyKey, operation, payloadJson, dryRun, createdAt, updatedAt] = params;
                rows.set(String(id), {
                  id: String(id),
                  idempotency_key: String(idempotencyKey),
                  operation: String(operation),
                  payload_json: String(payloadJson),
                  status: "queued",
                  dry_run: Number(dryRun),
                  attempts: 0,
                  last_error: null,
                  result_json: null,
                  created_at: String(createdAt),
                  updated_at: String(updatedAt),
                  processed_at: null,
                });
                byIdempotency.set(String(idempotencyKey), String(id));
                return { success: true };
              }
              if (query.includes("SET status = 'processing'")) {
                const [updatedAt, id] = params;
                const row = rows.get(String(id));
                if (row && row.status === "queued") {
                  row.status = "processing";
                  row.attempts += 1;
                  row.updated_at = String(updatedAt);
                }
                return { success: true };
              }
              if (query.includes("SET status = 'simulated'") || query.includes("SET status = 'sent'")) {
                const [resultJson, processedAt, updatedAt, id] = params;
                const row = rows.get(String(id));
                if (row) {
                  row.status = query.includes("'simulated'") ? "simulated" : "sent";
                  row.result_json = String(resultJson);
                  row.processed_at = String(processedAt);
                  row.updated_at = String(updatedAt);
                }
                return { success: true };
              }
              if (query.includes("SET status = 'failed'")) {
                const [lastError, processedAt, updatedAt, id] = params;
                const row = rows.get(String(id));
                if (row) {
                  row.status = "failed";
                  row.last_error = String(lastError);
                  row.processed_at = String(processedAt);
                  row.updated_at = String(updatedAt);
                }
                return { success: true };
              }
              throw new Error(`Unsupported run() query: ${query}`);
            },
            async all<T>() {
              if (query.includes("WHERE status = 'queued'")) {
                const limit = Number(params[0]);
                const results = [...rows.values()]
                  .filter((row) => row.status === "queued")
                  .sort((a, b) => a.created_at.localeCompare(b.created_at))
                  .slice(0, limit);
                return { results: results as T[] };
              }
              if (query.includes("WHERE status = ?")) {
                const [status, limit] = params;
                const results = [...rows.values()]
                  .filter((row) => row.status === String(status))
                  .sort((a, b) => b.created_at.localeCompare(a.created_at))
                  .slice(0, Number(limit));
                return { results: results as T[] };
              }
              throw new Error(`Unsupported all() query: ${query}`);
            },
          };
        },
      };
    },
  };
  return db as unknown as D1Database & { rows: Map<string, QueueRow> };
}

function envWith(overrides: Partial<CmsWriteEnv> = {}): CmsWriteEnv {
  return { DB: fakeD1(), CMS_WRITE_TOKEN: "test-write-token", ...overrides };
}

function authedRequest(path: string, init: RequestInit = {}, token = "test-write-token") {
  return new Request(`https://write-gateway.example${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const validCommand = JSON.stringify({
  operation: "sync_outbound_shipment",
  shipment: { shipmentNo: "SH-1001", invoice: "INV-9", customer: "ULTA", status: "SHIPPED" },
});

describe("CMS write gateway", () => {
  it("defaults to dry-run unless CMS_WRITE_DRY_RUN is explicitly 'false'", () => {
    expect(isDryRun(envWith())).toBe(true);
    expect(isDryRun(envWith({ CMS_WRITE_DRY_RUN: "true" }))).toBe(true);
    expect(isDryRun(envWith({ CMS_WRITE_DRY_RUN: "false" }))).toBe(false);
  });

  it("fails closed with 503 when CMS_WRITE_TOKEN is not configured", async () => {
    const env = envWith({ CMS_WRITE_TOKEN: undefined });
    const response = await worker.fetch(authedRequest("/enqueue", { method: "POST", body: validCommand }), env);
    expect(response.status).toBe(503);
  });

  it("rejects missing or wrong bearer tokens with 401", async () => {
    const env = envWith();
    const missing = await worker.fetch(new Request("https://write-gateway.example/enqueue", { method: "POST", body: validCommand }), env);
    expect(missing.status).toBe(401);
    const wrong = await worker.fetch(authedRequest("/enqueue", { method: "POST", body: validCommand }, "nope"), env);
    expect(wrong.status).toBe(401);
  });

  it("queues a valid write command in dry-run without contacting CMS", async () => {
    const env = envWith();
    const response = await worker.fetch(authedRequest("/enqueue", { method: "POST", body: validCommand }), env);
    const body = await response.json() as { ok?: boolean; status?: string; dryRun?: boolean; id?: string };

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ ok: true, status: "queued", dryRun: true });
    const row = (env.DB as ReturnType<typeof fakeD1>).rows.get(String(body.id));
    expect(row?.status).toBe("queued");
    expect(row?.dry_run).toBe(1);
  });

  it("deduplicates retries by idempotency key", async () => {
    const env = envWith();
    const first = await worker.fetch(authedRequest("/enqueue", { method: "POST", body: validCommand }), env);
    const second = await worker.fetch(authedRequest("/enqueue", { method: "POST", body: validCommand }), env);
    const a = await first.json() as { id?: string; deduplicated?: boolean };
    const b = await second.json() as { id?: string; deduplicated?: boolean; status?: string };

    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(b.id).toBe(a.id);
    expect((env.DB as ReturnType<typeof fakeD1>).rows.size).toBe(1);
  });

  it("rejects operations outside the write allowlist", async () => {
    const env = envWith();
    const response = await worker.fetch(
      authedRequest("/enqueue", {
        method: "POST",
        body: JSON.stringify({ operation: "delete_everything", shipment: { invoice: "INV-1" } }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { error?: string };
    expect(body.error).toContain("not allowlisted");
  });

  it("marks queued writes as simulated during dry-run processing", async () => {
    const env = envWith();
    await worker.fetch(authedRequest("/enqueue", { method: "POST", body: validCommand }), env);
    const response = await worker.fetch(authedRequest("/process", { method: "POST" }), env);
    const body = await response.json() as { ok?: boolean; dryRun?: boolean; simulated?: number; sent?: number };

    expect(body).toMatchObject({ ok: true, dryRun: true, simulated: 1, sent: 0 });
    const row = [...(env.DB as ReturnType<typeof fakeD1>).rows.values()][0];
    expect(row.status).toBe("simulated");
  });

  it("fails loudly instead of writing when dry-run is off but no upstream is configured", async () => {
    const env = envWith({ CMS_WRITE_DRY_RUN: "false" });
    await worker.fetch(authedRequest("/enqueue", { method: "POST", body: validCommand }), env);
    const response = await worker.fetch(authedRequest("/process", { method: "POST" }), env);
    const body = await response.json() as { dryRun?: boolean; failed?: number };

    expect(body).toMatchObject({ dryRun: false, failed: 1 });
    const row = [...(env.DB as ReturnType<typeof fakeD1>).rows.values()][0];
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("CMS_WRITE_UPSTREAM_URL");
  });

  it("health exposes only safe rollout metadata", async () => {
    const response = await worker.fetch(new Request("https://write-gateway.example/health"), envWith());
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, dryRun: true, upstreamConfigured: false, tokenConfigured: true });
    expect(JSON.stringify(body)).not.toContain("test-write-token");
  });
});

describe("main Worker /api/logistics/cms-write command", () => {
  function mainEnv(overrides: Record<string, unknown> = {}) {
    return {
      CMS_WRITE_GATEWAY_URL: "https://write-gateway.example",
      CMS_WRITE_TOKEN: "test-write-token",
      STATUS_WRITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ...overrides,
    } as unknown as Env;
  }

  it("returns 503 before the rollout is configured instead of failing silently", async () => {
    const response = await handleCmsWriteCommand(
      new Request("https://stylekorean.dpdns.org/api/logistics/cms-write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: validCommand,
      }),
      mainEnv({ CMS_WRITE_GATEWAY_URL: "", CMS_WRITE_TOKEN: "" }),
    );
    expect(response.status).toBe(503);
    const body = await response.json() as { error?: string };
    expect(body.error).toContain("not configured");
  });

  it("rejects cross-origin write attempts", async () => {
    const response = await handleCmsWriteCommand(
      new Request("https://stylekorean.dpdns.org/api/logistics/cms-write", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: validCommand,
      }),
      mainEnv(),
    );
    expect(response.status).toBe(403);
  });

  it("rejects non-allowlisted operations before reaching the gateway", async () => {
    const response = await handleCmsWriteCommand(
      new Request("https://stylekorean.dpdns.org/api/logistics/cms-write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "drop_tables", invoice: "INV-1" }),
      }),
      mainEnv(),
    );
    expect(response.status).toBe(400);
  });
});

describe("CMS write rollout deployment contract", () => {
  const workflow = readFileSync(".github/workflows/deploy-cms-write-gateway.yml", "utf8");
  const config = readFileSync("wrangler.cms-write-gateway.toml", "utf8");
  const migration = readFileSync("migrations/0006_cms_write_queue.sql", "utf8");
  const page = readFileSync("app/page.tsx", "utf8");
  const button = readFileSync("app/send-to-cms-button.tsx", "utf8");

  it("fails fast when required secrets are missing and never passes them on the command line", () => {
    for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CMS_WRITE_TOKEN"]) {
      expect(workflow).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    expect(workflow).toContain("Missing required GitHub Actions secrets");
    expect(workflow).toContain(`printf '%s' "$CMS_WRITE_TOKEN" | npx wrangler secret put CMS_WRITE_TOKEN`);
    expect(workflow).not.toMatch(/wrangler secret put CMS_WRITE_TOKEN[^\n]*--value/i);
  });

  it("keeps the write gateway in dry-run by default and verifies that after deploy", () => {
    expect(config).toContain('CMS_WRITE_DRY_RUN = "true"');
    expect(config).not.toMatch(/CMS_WRITE_UPSTREAM_URL\s*=\s*"https?:/);
    expect(workflow).toContain('"dryRun":true');
  });

  it("stores queued writes in the shared D1 schema with an audit-friendly shape", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cms_write_queue");
    expect(migration).toContain("idempotency_key TEXT NOT NULL UNIQUE");
    expect(migration).toContain("CHECK(status IN ('queued', 'processing', 'simulated', 'sent', 'failed'))");
    expect(config).toContain('database_name = "stylekorean-logistics-read-model"');
  });

  it("renders a two-step Send to CMS control for outbound shipments only", () => {
    expect(page).toContain('import { SendToCmsButton } from "./send-to-cms-button";');
    expect(page).toContain('item.direction === "outbound"');
    expect(button).toContain("Confirm send to CMS");
    expect(button).toContain("/api/logistics/cms-write");
  });
});
