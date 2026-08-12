import { fetchOperationalSources } from "./sources";
import { handleStatusCommand } from "./status-command";

export type WorkerEnv = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  APPS_SCRIPT_WRITE_URL?: string;
};

const WORKER_VERSION = "2026-08-12-worker-v1";

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
    return json(
      {
        ok: false,
        generatedAt,
        error: "Core Logistics Master sources are unavailable",
        sourceHealth: snapshot.sourceHealth,
      },
      503,
    );
  }
  return json({
    ok: true,
    generatedAt,
    version: WORKER_VERSION,
    sourceHealth: snapshot.sourceHealth,
    sources: snapshot.sources,
    // The existing client computes live KPIs from source workbooks when this is null.
    // A later hybrid-read-model wave moves the same pure calculation server-side.
    kpis: null,
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
