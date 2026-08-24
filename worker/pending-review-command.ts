import { recordPendingReviewDecision } from "./database";

const MAX_COMMAND_BYTES = 4_096;
const MAX_FIELD_LENGTH = 500;
const WRITE_TIMEOUT_MS = 20_000;

type ReviewCommand = {
  reviewKey: string;
  decision: "approve" | "reject";
  shipmentId?: string;
};

function hasDatabase(env: Env): env is Env & { DB: D1Database } {
  return "DB" in env;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function hasOversizedField(command: ReviewCommand) {
  return Object.values(command).some((value) => typeof value === "string" && value.length > MAX_FIELD_LENGTH);
}

/**
 * Proxies an approve/reject decision on a Gmail-ingestion PENDING
 * VERIFICATION row to Apps Script. Mirrors handleStatusCommand
 * (status-command.ts) field-for-field: same origin/fetch-site checks, same
 * rate limiter (a distinct key prefix on the shared STATUS_WRITE_RATE_LIMITER
 * binding rather than a second Cloudflare resource), same size limits, same
 * timeout+abort, same "trust only a confirmed upstream response" contract.
 */
export async function handlePendingReviewCommand(request: Request, env: Env, context?: ExecutionContext) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ ok: false, error: "Cross-origin review writes are not allowed" }, 403);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return json({ ok: false, error: "Cross-site review writes are not allowed" }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ ok: false, error: "Content-Type must be application/json" }, 415);
  }
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const rateLimit = await env.STATUS_WRITE_RATE_LIMITER.limit({ key: `pending-review:${clientIp}` });
  if (!rateLimit.success) {
    console.warn(JSON.stringify({ event: "pending-review-rate-limited", clientIpPresent: clientIp !== "unknown" }));
    return Response.json(
      { ok: false, error: "Review rate limit exceeded. Try again in one minute." },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } },
    );
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_COMMAND_BYTES) return json({ ok: false, error: "Command is too large" }, 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_COMMAND_BYTES) {
    return json({ ok: false, error: "Command is too large" }, 413);
  }
  const command = (() => {
    try { return JSON.parse(body) as ReviewCommand; }
    catch { return null; }
  })();
  if (!command || !command.reviewKey || typeof command.reviewKey !== "string") {
    return json({ ok: false, error: "A review key is required" }, 400);
  }
  if (command.decision !== "approve" && command.decision !== "reject") {
    return json({ ok: false, error: "Decision must be approve or reject" }, 400);
  }
  if (hasOversizedField(command)) return json({ ok: false, error: "A command field is too large" }, 413);

  const correlationId = crypto.randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(env.APPS_SCRIPT_WRITE_URL, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "reviewPending", reviewKey: command.reviewKey, decision: command.decision }),
      signal: controller.signal,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "pending-review-upstream-failure", correlationId, error: String(error) }));
    return json({ ok: false, error: "Review source is unavailable", correlationId }, 502);
  } finally {
    clearTimeout(timer);
  }
  const result = (await response.json().catch(() => null)) as
    | { ok?: boolean; action?: string; row?: number; status?: string; error?: string }
    | null;
  if (!response.ok || result?.ok !== true) {
    return json(
      { ok: false, error: result?.error || `Review source rejected the command (${response.status})`, correlationId },
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }
  console.log(JSON.stringify({
    event: "pending-review-confirmed",
    correlationId,
    decision: command.decision,
    row: result.row,
    auditedInD1: Boolean(hasDatabase(env) && context),
  }));
  if (hasDatabase(env) && context) {
    context.waitUntil(recordPendingReviewDecision(env.DB, {
      correlationId,
      reviewKey: command.reviewKey,
      shipmentId: command.shipmentId,
      decision: command.decision,
      resultingStatus: result.status || "",
    }).catch((error) => {
      console.error(JSON.stringify({ event: "pending-review-audit-failure", correlationId, error: String(error) }));
    }));
  }
  return json({ ...result, correlationId });
}
