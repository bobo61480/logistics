/**
 * src/worker.ts
 * Cloudflare Worker entry point for the StyleKorean Logistics platform.
 *
 * Responsibilities:
 *   1. Serve static Next.js export from ./out via ASSETS binding
 *   2. Handle /api/* routes from src/api.ts (D1 reads + live KPIs)
 *   3. Run scheduled sync every 15 minutes via cron trigger
 */

import { handleApiRequest, type Env } from "./api";
import { syncAll } from "./sync/index";

export default {
  // ── HTTP handler ───────────────────────────────────────────────────────────
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Route /api/* to the API handler; everything else to static assets.
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }

    return env.ASSETS.fetch(request);
  },

  // ── Cron handler (every 15 minutes) ────────────────────────────────────────
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      syncAll(env.LOGISTICS_DB).catch((err) =>
        console.error("[cron] sync failed:", err),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
