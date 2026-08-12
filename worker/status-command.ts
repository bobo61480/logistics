import { normalizeLogisticsStatus } from "../lib/domain/status";

const DEFAULT_WRITE_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbz770kmpwqMTA-h-lzeLARgVnDh_VDjh-70OOKk_yE-iXJTmzAsVXUtln17QTOURO1R/exec";

export type StatusCommandEnv = { APPS_SCRIPT_WRITE_URL?: string };

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

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export async function handleStatusCommand(request: Request, env: StatusCommandEnv) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const command = (await request.json().catch(() => null)) as StatusCommand | null;
  if (!command || (command.kind !== "inbound" && command.kind !== "outbound")) {
    return json({ ok: false, error: "Invalid relation kind" }, 400);
  }
  if (!command.sourceSheet || !Number.isInteger(Number(command.sourceRow)) || Number(command.sourceRow) < 1) {
    return json({ ok: false, error: "A valid source sheet and row are required" }, 400);
  }
  const status = normalizeLogisticsStatus(command.status);
  if (!status) return json({ ok: false, error: "Status is not allowed" }, 400);

  const correlationId = crypto.randomUUID();
  const endpoint = env.APPS_SCRIPT_WRITE_URL || DEFAULT_WRITE_ENDPOINT;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...command, sourceRow: Number(command.sourceRow), status }),
  });
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
  return json({ ...result, status, correlationId });
}
