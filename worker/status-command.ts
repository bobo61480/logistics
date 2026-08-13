import { normalizeLogisticsStatus } from "../lib/domain/status";
import { recordConfirmedStatusWrite } from "./database";

const MAX_COMMAND_BYTES = 16_384;
const MAX_FIELD_LENGTH = 500;
const WRITE_TIMEOUT_MS = 20_000;
const EDITABLE_SHEETS = new Map([
  ["inbound", new Set(["IMPORTS"])],
  ["outbound", new Set(["Outbound Shipping Schedule"])],
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

export async function handleStatusCommand(request: Request, env: Env, context?: ExecutionContext) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ ok: false, error: "Cross-origin status writes are not allowed" }, 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return json({ ok: false, error: "Cross-site status writes are not allowed" }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ ok: false, error: "Content-Type must be application/json" }, 415);
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_COMMAND_BYTES) return json({ ok: false, error: "Command is too large" }, 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_COMMAND_BYTES) {
    return json({ ok: false, error: "Command is too large" }, 413);
  }
  const command = (() => {
    try { return JSON.parse(body) as StatusCommand; }
    catch { return null; }
  })();
  if (!command || (command.kind !== "inbound" && command.kind !== "outbound")) {
    return json({ ok: false, error: "Invalid relation kind" }, 400);
  }
  if (!command.sourceSheet || !Number.isInteger(Number(command.sourceRow)) || Number(command.sourceRow) < 1) {
    return json({ ok: false, error: "A valid source sheet and row are required" }, 400);
  }
  if (!EDITABLE_SHEETS.get(command.kind)?.has(command.sourceSheet)) {
    return json({ ok: false, error: "That source sheet is not editable for this relation kind" }, 400);
  }
  if (hasOversizedField(command)) return json({ ok: false, error: "A command field is too large" }, 413);
  const status = normalizeLogisticsStatus(command.status);
  if (!status) return json({ ok: false, error: "Status is not allowed" }, 400);

  const correlationId = crypto.randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(env.APPS_SCRIPT_WRITE_URL, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...command, sourceRow: Number(command.sourceRow), status }),
      signal: controller.signal,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "status-write-upstream-failure", correlationId, error: String(error) }));
    return json({ ok: false, error: "Status source is unavailable", correlationId }, 502);
  } finally {
    clearTimeout(timer);
  }
  const result = (await response.json().catch(() => null)) as { ok?: boolean; status?: string; error?: string } | null;
  if (!response.ok || result?.ok !== true) {
    return json(
      { ok: false, error: result?.error || `Status source rejected the command (${response.status})`, correlationId },
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }
  if (normalizeLogisticsStatus(result.status) !== status) {
    return json({ ok: false, error: "Persisted status did not match the command", correlationId }, 502);
  }
  if (hasDatabase(env) && context) {
    const entityId = command.shipmentNo || command.invoice || command.container || `${command.sourceSheet}:${command.sourceRow}`;
    context.waitUntil(recordConfirmedStatusWrite(env.DB, {
      correlationId,
      entityType: command.kind,
      entityId,
      previousStatus: command.currentStatus,
      status,
      sourceSheet: command.sourceSheet,
      sourceRow: Number(command.sourceRow),
    }).catch((error) => {
      console.error(JSON.stringify({ event: "status-write-audit-failure", correlationId, error: String(error) }));
    }));
  }
  return json({ ...result, status, correlationId });
}
