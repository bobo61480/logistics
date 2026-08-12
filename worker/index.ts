import { computeKpisFromRows } from "../lib/kpis/compute";
import { fetchOperationalSources } from "./sources";
import { handleStatusCommand } from "./status-command";

export type WorkerEnv = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  APPS_SCRIPT_WRITE_URL?: string;
};

const WORKER_VERSION = "2026-08-12-worker-v2-kpi-snapshot";

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function handleSnapshot() {
  const generatedAt = new Date().toISOString();
  const snapshot = await fetchOperationalSources();
  const coreOk = Boolean(snapshot.sources.imports && snapshot.sources.outbound);
  if (!coreOk) {
    return json({ ok: false, generatedAt, error: "Core Logistics Master sources are unavailable", sourceHealth: snapshot.sourceHealth }, 503);
  }

  let kpis = null;
  let kpiError = "";
  try {
    kpis = computeKpisFromRows(snapshot.kpiRows);
  } catch (error) {
    kpiError = error instanceof Error ? error.message : String(error);
  }

  return json({
    ok: true,
    generatedAt,
    version: WORKER_VERSION,
    sourceHealth: snapshot.sourceHealth,
    sources: snapshot.sources,
    kpis,
    kpiError: kpiError || undefined,
  });
}

function handleHealth() {
  return json({
    ok: true,
    service: "stylekorean-logistics-control-tower",
    version: WORKER_VERSION,
    databaseConfigured: false,
    statusWriteConfigured: true,
    statusWriteMode: "Apps Script source-confirmed proxy",
    checkedAt: new Date().toISOString(),
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/logistics/snapshot") {
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleSnapshot();
    }
    if (url.pathname === "/api/logistics/status") return handleStatusCommand(request, env);
    if (url.pathname === "/api/logistics/health") return handleHealth();
    return env.ASSETS.fetch(request);
  },
};
