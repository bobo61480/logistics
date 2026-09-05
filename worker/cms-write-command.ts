/**
 * Same-origin entry point for browser-initiated CMS writes.
 *
 * The browser never talks to CMS or the write gateway directly: it posts a small
 * command here, and this handler validates it and forwards it to the
 * stylekorean-cms-write-gateway Worker, which queues it in D1 (dry-run by
 * default). Mirrors the status-command hardening: same-origin only, rate
 * limited, size capped, allowlisted operations.
 */

const MAX_COMMAND_BYTES = 8_192;
const MAX_FIELD_LENGTH = 500;
const GATEWAY_TIMEOUT_MS = 20_000;

const ALLOWED_OPERATIONS = new Set(["sync_outbound_shipment"]);

type CmsWriteRequestBody = {
  operation?: unknown;
  shipmentNo?: unknown;
  invoice?: unknown;
  customer?: unknown;
  status?: unknown;
  note?: unknown;
};

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function text(value: unknown, max = MAX_FIELD_LENGTH) {
  return String(value ?? "").trim().slice(0, max);
}

export async function handleCmsWriteCommand(request: Request, env: Env) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ ok: false, error: "Cross-origin CMS writes are not allowed" }, 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") return json({ ok: false, error: "Cross-site CMS writes are not allowed" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ ok: false, error: "Content-Type must be application/json" }, 415);

  const gatewayUrl = text(env.CMS_WRITE_GATEWAY_URL, 2048);
  const gatewayToken = text(env.CMS_WRITE_TOKEN, 4096);
  if (!gatewayUrl || !gatewayToken) {
    return json({ ok: false, error: "CMS write rollout is not configured on this environment yet" }, 503);
  }

  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const rateLimit = await env.STATUS_WRITE_RATE_LIMITER.limit({ key: `cms-write:${clientIp}` });
  if (!rateLimit.success) {
    return Response.json(
      { ok: false, error: "CMS write rate limit exceeded. Try again in one minute." },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } },
    );
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_COMMAND_BYTES) return json({ ok: false, error: "Command is too large" }, 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_COMMAND_BYTES) return json({ ok: false, error: "Command is too large" }, 413);
  const body = (() => { try { return JSON.parse(rawBody) as CmsWriteRequestBody; } catch { return null; } })();
  if (!body || typeof body !== "object") return json({ ok: false, error: "Invalid CMS write command" }, 400);

  const operation = text(body.operation, 100) || "sync_outbound_shipment";
  if (!ALLOWED_OPERATIONS.has(operation)) return json({ ok: false, error: "That CMS write operation is not supported" }, 400);
  const shipment = {
    shipmentNo: text(body.shipmentNo),
    invoice: text(body.invoice),
    customer: text(body.customer),
    status: text(body.status, 100),
  };
  if (!shipment.shipmentNo && !shipment.invoice) {
    return json({ ok: false, error: "A shipment number or invoice is required" }, 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/enqueue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({ operation, shipment, note: text(body.note, 1_000) }),
      signal: controller.signal,
    });
    const result = (await response.json().catch(() => null)) as
      | { ok?: boolean; id?: string; status?: string; dryRun?: boolean; deduplicated?: boolean; error?: string }
      | null;
    if (!response.ok || result?.ok !== true) {
      return json({ ok: false, error: result?.error || `CMS write gateway failed (${response.status})` }, 502);
    }
    return json({
      ok: true,
      id: result.id,
      status: result.status,
      dryRun: result.dryRun === true,
      deduplicated: result.deduplicated === true,
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502);
  } finally {
    clearTimeout(timer);
  }
}
