import type { UsageToday } from "@/lib/events/store";
import { withTenant, type ApiKeyCtx } from "./tenant";

/** Today's (UTC) counters for the key's own project, or null when nothing was ingested yet today. */
export async function readUsageToday(ctx: ApiKeyCtx): Promise<UsageToday | null> {
  const projectId = ctx.projectIds[0];
  if (ctx.projectIds.length !== 1 || !projectId) return null;
  const [rows] = await withTenant(ctx, (t) => [
    t`select events::text as events, requests::text as requests, cost_micro::text as cost_micro
        from usage_daily
       where project_id = ${projectId}::uuid and day = (now() at time zone 'UTC')::date`,
  ]);
  const r = rows[0];
  // Counters stay far below 2^53, so Number() is exact (see the driver note in docs/ARCHITECTURE.md).
  return r ? { events: Number(r.events), requests: Number(r.requests), costMicro: Number(r.cost_micro) } : null;
}
