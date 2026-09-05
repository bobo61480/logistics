/**
 * stylekorean-cms-write-gateway — the ONLY surface allowed to write to CMS.
 *
 * Rollout model:
 *  1. Every write arrives as a validated command and is recorded in the shared
 *     D1 `cms_write_queue` table first (audit trail + idempotency).
 *  2. While CMS_WRITE_DRY_RUN !== "false" (the default), processing only marks
 *     rows `simulated`; CMS is never contacted.
 *  3. Real writes additionally require CMS_WRITE_UPSTREAM_URL and are sent one
 *     queued row at a time from the `/process` drain (hourly cron or manual).
 *
 * Authentication: all mutating/reading endpoints require
 * `Authorization: Bearer ${CMS_WRITE_TOKEN}`. When the secret is missing the
 * worker fails closed with 503 — it never runs unauthenticated.
 */

const MAX_COMMAND_BYTES = 16_384;
const MAX_FIELD_LENGTH = 500;
const MAX_NOTE_LENGTH = 1_000;
const MAX_PROCESS_BATCH = 25;
const MAX_RESULT_BYTES = 2_048;
const WRITE_TIMEOUT_MS = 20_000;

// Rollout allowlist — add new CMS write operations here only after the upstream
// contract is verified in dry-run. Anything else is rejected before it is queued.
const ALLOWED_OPERATIONS = new Set(["sync_outbound_shipment"]);

export type CmsWriteEnv = {
  DB: D1Database;
  CMS_WRITE_TOKEN?: string;
  CMS_WRITE_DRY_RUN?: string;
  CMS_WRITE_UPSTREAM_URL?: string;
};

export type CmsWriteCommand = {
  operation: string;
  shipment: {
    shipmentNo?: string;
    invoice?: string;
    customer?: string;
    status?: string;
  };
  note?: string;
  idempotencyKey?: string;
};

type QueueRow = {
  id: string;
  idempotency_key: string;
  operation: string;
  payload_json: string;
  status: string;
  dry_run: number;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
};

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

function text(value: unknown, max = MAX_FIELD_LENGTH) {
  return String(value ?? "").trim().slice(0, max);
}

export function isDryRun(env: CmsWriteEnv) {
  return text(env.CMS_WRITE_DRY_RUN).toLowerCase() !== "false";
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-shape token check: both sides are hashed so length/content never leak. */
async function tokenMatches(provided: string, expected: string) {
  return (await sha256Hex(provided)) === (await sha256Hex(expected));
}

async function authorize(request: Request, env: CmsWriteEnv): Promise<Response | null> {
  const expected = text(env.CMS_WRITE_TOKEN, 4096);
  if (!expected) return json({ ok: false, error: "CMS write gateway token is not configured" }, 503);
  const header = request.headers.get("authorization") ?? "";
  const provided = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!provided || !(await tokenMatches(provided, expected))) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  return null;
}

function normalizeCommand(raw: unknown): CmsWriteCommand {
  if (!raw || typeof raw !== "object") throw new Error("Invalid CMS write command");
  const input = raw as Record<string, unknown>;
  const operation = text(input.operation, 100) || "sync_outbound_shipment";
  if (!ALLOWED_OPERATIONS.has(operation)) {
    throw new Error(`CMS write operation is not allowlisted: ${operation}`);
  }
  const shipmentRaw = (input.shipment && typeof input.shipment === "object" ? input.shipment : {}) as Record<string, unknown>;
  const shipment = {
    shipmentNo: text(shipmentRaw.shipmentNo),
    invoice: text(shipmentRaw.invoice),
    customer: text(shipmentRaw.customer),
    status: text(shipmentRaw.status, 100),
  };
  if (!shipment.shipmentNo && !shipment.invoice) {
    throw new Error("A shipment number or invoice is required for a CMS write");
  }
  const note = text(input.note, MAX_NOTE_LENGTH);
  const idempotencyKey = text(input.idempotencyKey, 200);
  return {
    operation,
    shipment,
    ...(note ? { note } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

async function enqueue(env: CmsWriteEnv, command: CmsWriteCommand) {
  const now = new Date().toISOString();
  const payloadJson = JSON.stringify({ operation: command.operation, shipment: command.shipment, note: command.note ?? "" });
  const idempotencyKey = command.idempotencyKey || (await sha256Hex(payloadJson));
  const id = crypto.randomUUID();
  const dryRun = isDryRun(env);

  const existing = await env.DB.prepare(
    "SELECT id, status, dry_run, created_at FROM cms_write_queue WHERE idempotency_key = ?",
  ).bind(idempotencyKey).first<Pick<QueueRow, "id" | "status" | "dry_run" | "created_at">>();
  if (existing) {
    return { id: existing.id, status: existing.status, dryRun: existing.dry_run === 1, deduplicated: true };
  }

  await env.DB.prepare(
    `INSERT INTO cms_write_queue
       (id, idempotency_key, operation, payload_json, status, dry_run, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, ?)`,
  ).bind(id, idempotencyKey, command.operation, payloadJson, dryRun ? 1 : 0, now, now).run();

  return { id, status: "queued" as const, dryRun, deduplicated: false };
}

async function executeUpstreamWrite(env: CmsWriteEnv, row: QueueRow) {
  const upstream = text(env.CMS_WRITE_UPSTREAM_URL, 2048);
  if (!upstream) throw new Error("CMS_WRITE_UPSTREAM_URL is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  try {
    const response = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: row.payload_json,
      signal: controller.signal,
    });
    const bodyText = (await response.text()).slice(0, MAX_RESULT_BYTES);
    if (!response.ok) throw new Error(`CMS write upstream returned HTTP ${response.status}`);
    return bodyText;
  } finally {
    clearTimeout(timer);
  }
}

async function processQueue(env: CmsWriteEnv, limit = MAX_PROCESS_BATCH) {
  const dryRun = isDryRun(env);
  const rows = await env.DB.prepare(
    "SELECT * FROM cms_write_queue WHERE status = 'queued' ORDER BY created_at LIMIT ?",
  ).bind(Math.max(1, Math.min(limit, MAX_PROCESS_BATCH))).all<QueueRow>();

  const summary = { processed: 0, simulated: 0, sent: 0, failed: 0 };
  for (const row of rows.results ?? []) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE cms_write_queue SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'",
    ).bind(now, row.id).run();

    try {
      if (dryRun) {
        // Dry-run rollout: validate + record only. CMS is never contacted.
        await env.DB.prepare(
          "UPDATE cms_write_queue SET status = 'simulated', result_json = ?, processed_at = ?, updated_at = ? WHERE id = ?",
        ).bind(JSON.stringify({ dryRun: true, note: "Validated but not sent to CMS (dry-run)." }), now, now, row.id).run();
        summary.simulated += 1;
      } else {
        const resultText = await executeUpstreamWrite(env, row);
        await env.DB.prepare(
          "UPDATE cms_write_queue SET status = 'sent', result_json = ?, processed_at = ?, updated_at = ? WHERE id = ?",
        ).bind(JSON.stringify({ upstreamResponse: resultText }), now, now, row.id).run();
        summary.sent += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await env.DB.prepare(
        "UPDATE cms_write_queue SET status = 'failed', last_error = ?, processed_at = ?, updated_at = ? WHERE id = ?",
      ).bind(message.slice(0, MAX_FIELD_LENGTH), now, now, row.id).run();
      summary.failed += 1;
    }
    summary.processed += 1;
  }
  return { ok: true as const, dryRun, ...summary };
}

async function readBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_COMMAND_BYTES) throw new Error("Command is too large");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_COMMAND_BYTES) throw new Error("Command is too large");
  return JSON.parse(body) as unknown;
}

export default {
  async fetch(request: Request, env: CmsWriteEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // Safe metadata only — never leak token, upstream URL, or payload contents.
      return json({
        ok: true,
        service: "stylekorean-cms-write-gateway",
        dryRun: isDryRun(env),
        upstreamConfigured: Boolean(text(env.CMS_WRITE_UPSTREAM_URL, 2048)),
        tokenConfigured: Boolean(text(env.CMS_WRITE_TOKEN, 4096)),
      });
    }

    if (url.pathname === "/enqueue" && request.method === "POST") {
      const denied = await authorize(request, env);
      if (denied) return denied;
      try {
        const command = normalizeCommand(await readBody(request));
        const result = await enqueue(env, command);
        return json({ ok: true, ...result }, result.deduplicated ? 200 : 201);
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (url.pathname === "/queue" && request.method === "GET") {
      const denied = await authorize(request, env);
      if (denied) return denied;
      const status = text(url.searchParams.get("status"), 20) || "queued";
      if (!["queued", "processing", "simulated", "sent", "failed"].includes(status)) {
        return json({ ok: false, error: "Unknown queue status filter" }, 400);
      }
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 100));
      const rows = await env.DB.prepare(
        "SELECT id, operation, status, dry_run, attempts, last_error, created_at, processed_at FROM cms_write_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?",
      ).bind(status, limit).all();
      return json({ ok: true, status, rows: rows.results ?? [] });
    }

    if (url.pathname === "/process" && request.method === "POST") {
      const denied = await authorize(request, env);
      if (denied) return denied;
      return json(await processQueue(env));
    }

    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: CmsWriteEnv, context: ExecutionContext) {
    context.waitUntil(processQueue(env).catch((error) => {
      console.error(JSON.stringify({ event: "cms-write-queue-drain-failed", error: String(error) }));
      throw error;
    }));
  },
};
