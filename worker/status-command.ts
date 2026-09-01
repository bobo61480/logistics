import { normalizeLogisticsStatus } from "../lib/domain/status";
import { applyConfirmedStatusToSnapshot, recordConfirmedStatusWrite } from "./database";

const MAX_COMMAND_BYTES = 16_384;
const MAX_FIELD_LENGTH = 500;
const WRITE_TIMEOUT_MS = 20_000;
const EDITABLE_SHEETS = new Map([
  ["inbound", new Set(["IMPORTS"])],
  ["outbound", new Set(["Outbound Shipping Schedule", "WH Trucking Request"])],
]);

type StatusCommand = {
  kind: "inbound" | "outbound";
  sourceSheet: string;
  sourceRow: number;
  shipmentNo?: string;
  container?: string;
  mbl?: string;
  hbl?: string;
  pro?: string;
  invoice?: string;
  customer?: string;
  shipDate?: string;
  currentStatus?: string;
  isSmallParcel?: boolean;
  trackingNumber?: string;
  status: string;
};

function hasDatabase(env: Env): env is Env & { DB: D1Database } {
  return "DB" in env;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function hasOversizedField(command: StatusCommand) {
  return Object.values(command).some((value) => typeof value === "string" && value.length > MAX_FIELD_LENGTH);
}

async function writeSheetStatus(env: Env, command: StatusCommand, status: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  try {
    const response = await fetch(env.APPS_SCRIPT_WRITE_URL, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...command, sourceRow: Number(command.sourceRow), status }),
      signal: controller.signal,
    });
    const result = (await response.json().catch(() => null)) as { ok?: boolean; status?: string; error?: string } | null;
    return { response, result };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleStatusCommand(request: Request, env: Env, _context?: ExecutionContext) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ ok: false, error: "Cross-origin status writes are not allowed" }, 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") return json({ ok: false, error: "Cross-site status writes are not allowed" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ ok: false, error: "Content-Type must be application/json" }, 415);
  if (!hasDatabase(env)) return json({ ok: false, error: "D1 frontend database is required for status writes" }, 503);

  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const rateLimit = await env.STATUS_WRITE_RATE_LIMITER.limit({ key: `status-write:${clientIp}` });
  if (!rateLimit.success) {
    return Response.json({ ok: false, error: "Status write rate limit exceeded. Try again in one minute." }, { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } });
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_COMMAND_BYTES) return json({ ok: false, error: "Command is too large" }, 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_COMMAND_BYTES) return json({ ok: false, error: "Command is too large" }, 413);
  const command = (() => { try { return JSON.parse(body) as StatusCommand; } catch { return null; } })();
  if (!command || (command.kind !== "inbound" && command.kind !== "outbound")) return json({ ok: false, error: "Invalid relation kind" }, 400);
  if (!command.sourceSheet || !Number.isInteger(Number(command.sourceRow)) || Number(command.sourceRow) < 1) return json({ ok: false, error: "A valid source sheet and row are required" }, 400);
  if (!EDITABLE_SHEETS.get(command.kind)?.has(command.sourceSheet)) return json({ ok: false, error: "That source sheet is not editable for this relation kind" }, 400);
  if (hasOversizedField(command)) return json({ ok: false, error: "A command field is too large" }, 413);
  const status = normalizeLogisticsStatus(command.status);
  if (!status) return json({ ok: false, error: "Status is not allowed" }, 400);

  const correlationId = crypto.randomUUID();
  let sourceResult: { response: Response; result: { ok?: boolean; status?: string; error?: string } | null };
  try {
    sourceResult = await writeSheetStatus(env, command, status);
  } catch (error) {
    console.error(JSON.stringify({ event: "status-write-upstream-failure", correlationId, error: String(error) }));
    return json({ ok: false, error: "Status source is unavailable", correlationId }, 502);
  }
  if (!sourceResult.response.ok || sourceResult.result?.ok !== true) {
    return json({ ok: false, error: sourceResult.result?.error || `Status source rejected the command (${sourceResult.response.status})`, correlationId }, sourceResult.response.status >= 400 && sourceResult.response.status < 500 ? sourceResult.response.status : 502);
  }
  if (normalizeLogisticsStatus(sourceResult.result.status) !== status) return json({ ok: false, error: "Persisted Sheet status did not match the command", correlationId }, 502);

  const entityId = command.container || command.hbl || command.mbl || command.trackingNumber || command.pro || command.shipmentNo || command.invoice || `${command.sourceSheet}:${command.sourceRow}`;
  let databaseResult: unknown;
  let databaseError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      databaseResult = await applyConfirmedStatusToSnapshot(env.DB, {
        sourceSheet: command.sourceSheet,
        sourceRow: Number(command.sourceRow),
        entityId,
        status,
      });
      databaseError = undefined;
      break;
    } catch (error) {
      databaseError = error;
      console.error(JSON.stringify({ event: "status-d1-write-failure", correlationId, attempt, error: String(error) }));
    }
  }

  if (databaseError) {
    const previous = normalizeLogisticsStatus(command.currentStatus);
    if (previous) {
      try {
        const rollback = await writeSheetStatus(env, command, previous);
        if (!rollback.response.ok || rollback.result?.ok !== true || normalizeLogisticsStatus(rollback.result.status) !== previous) throw new Error(rollback.result?.error || "Rollback confirmation failed");
        return json({ ok: false, error: "D1 update failed; the Google Sheet change was rolled back to keep both stores consistent", correlationId, rolledBack: true }, 502);
      } catch (rollbackError) {
        console.error(JSON.stringify({ event: "status-dual-write-rollback-failure", correlationId, databaseError: String(databaseError), rollbackError: String(rollbackError) }));
        return json({ ok: false, error: "Critical synchronization failure: Sheet changed but D1 could not be updated or rolled back", correlationId, reconciliationRequired: true }, 500);
      }
    }
    return json({ ok: false, error: "D1 update failed and no safe prior status was available for rollback", correlationId, reconciliationRequired: true }, 502);
  }

  try {
    await recordConfirmedStatusWrite(env.DB, {
      correlationId,
      entityType: command.kind,
      entityId,
      previousStatus: command.currentStatus,
      status,
      sourceSheet: command.sourceSheet,
      sourceRow: Number(command.sourceRow),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "status-write-audit-failure", correlationId, error: String(error) }));
  }

  console.log(JSON.stringify({ event: "status-dual-write-confirmed", correlationId, sourceSheet: command.sourceSheet, sourceRow: Number(command.sourceRow), entityId, status }));
  return json({ ...sourceResult.result, status, correlationId, databaseUpdated: true, databaseResult, frontendSource: "d1" });
}
