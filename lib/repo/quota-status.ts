import { QUOTAS } from "@/lib/quotas";
import { NotFoundError } from "./errors";
import { assertInContext, parseProjectId, projectSelect } from "./project-guard";
import { withTenant, type SessionCtx } from "./tenant";

/** What a project page needs to show its notices: today's event count against the daily limit, and the storage-guard conserve flag. */
export interface ProjectStatus {
  /** Events ingested today (UTC day) by this project; 0 when nothing was ingested yet today. */
  eventsToday: number;
  eventsLimit: number;
  /** app_state `conserve` (set by the storage guard at warn or critical, or by an operator); false when unset. */
  conserve: boolean;
}

/**
 * One database round trip, three small statements, metadata only (two counters and one flag; no event rows, no content):
 * the ownership check, today's usage_daily row, and the global `conserve` flag (app_rw has SELECT on app_state, no migration).
 * The ownership check comes first and the result is thrown away as NotFoundError before anything else is used, with the SAME
 * error as every other reader (a project that is not yours, does not exist, was deleted, or whose id is not a UUID).
 * "Today" is the database's UTC day, the same key the ingest statement writes and the Overview meter reads.
 */
export async function readProjectStatus(ctx: SessionCtx, projectIdRaw: string): Promise<ProjectStatus> {
  const pid = parseProjectId(projectIdRaw);
  assertInContext(ctx, pid);
  const [proj, usage, state] = await withTenant(ctx, (t) => [
    projectSelect(t, ctx, pid),
    t`select events::text as events from usage_daily where project_id = ${pid}::uuid and day = (now() at time zone 'UTC')::date`,
    t`select (value = 'true'::jsonb) as conserve from app_state where key = 'conserve'`,
  ]);
  if (!proj?.[0]) throw new NotFoundError();
  const events = usage?.[0] ? Number(usage[0].events) : 0;
  return {
    eventsToday: Number.isFinite(events) && events >= 0 ? events : 0,
    eventsLimit: QUOTAS.eventsPerDayPerProject,
    conserve: state?.[0]?.conserve === true,
  };
}
