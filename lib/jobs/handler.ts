import { isCronAuthorized } from "@/lib/jobs/cron-auth";
import type { DailyJobResult, JobStore } from "@/lib/jobs/daily";
import { runDailyJob } from "@/lib/jobs/daily";
import { json } from "@/lib/http/respond";
import { logger, type Logger } from "@/lib/logger";
import { requestIdFrom } from "@/lib/request-id";

export interface DailyJobDeps {
  secret: () => string | undefined;
  store: () => JobStore;
  run?: (store: JobStore, log: Logger) => Promise<DailyJobResult>;
  log?: Logger;
}

/**
 * GET /api/jobs/daily. Vercel Cron issues GET. Auth is the CRON_SECRET bearer only (no Clerk, no API key; the proxy bypasses
 * Clerk for /api/jobs). Unauthenticated callers get a bare 401 before anything touches the database. 200 when every step
 * succeeded (including a run that stopped on its time budget: `complete:false`), 500 when a step failed.
 */
export function createDailyJobHandler(deps: DailyJobDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = requestIdFrom(request.headers);
    const log = (deps.log ?? logger).child({ requestId, route: "jobs/daily" });
    if (!isCronAuthorized(request.headers, deps.secret())) return json({ error: "unauthorized" }, 401, requestId);
    try {
      const result = await (deps.run ?? ((s, l) => runDailyJob(s, { log: l })))(deps.store(), log);
      return json(result, result.ok ? 200 : 500, requestId);
    } catch (err) {
      log.error("daily job crashed", { err });
      return json({ ok: false, error: "job_failed" }, 500, requestId);
    }
  };
}
