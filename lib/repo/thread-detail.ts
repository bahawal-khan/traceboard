import { NotFoundError } from "./errors";
import { assertInContext, parseProjectId, projectSelect } from "./project-guard";
import { withTenant, type SessionCtx, type Tx } from "./tenant";
import { traceDetailWindow, traceIdSchema } from "./trace-detail";
import { toItem, type TraceListItem } from "./traces";

/**
 * Thread DETAIL reader: the turns of ONE thread (one summary per trace), oldest first. The only place it is read.
 *
 * - Every statement goes through withTenant; the project is checked in the SAME transaction.
 * - ONE NotFoundError for everything that is not a readable thread of the caller's project: a foreign, missing, deleted or
 *   malformed project id, a malformed thread id, a thread that does not exist, another project's thread and an expired one.
 * - Time-bounded like the trace detail (14-day retention window, plus 24 h ahead), so monthly partitions are pruned; the
 *   (project_id, thread_id) partial index finds the rows.
 * - Two caps, both reported through `truncated`: at most THREAD_DETAIL_LIMITS.maxScanEvents events are read (the OLDEST are
 *   kept, whole timestamps only, so the result never depends on which tied row a LIMIT cut) and at most maxTurns turns are
 *   returned (the earliest). Either way the conversation start is kept and the newest part may be missing.
 * - Order is total: turn start (microseconds) ascending, then trace id ascending. There is no cursor: the result is bounded
 *   by the caps, not paged.
 * - A turn is a trace as far as THIS thread sees it: it counts only the events that carry this thread id.
 * - Metadata only: no content (event_content is never joined), no error text, no tags, no hashes. Each turn carries its trace
 *   id, which the page turns into a link to the trace detail (a test keeps the id valid for that page).
 * - Cost: same rules as the trace list (null is never 0, `costLowerBound` when an event with a model has no price).
 */

export const THREAD_DETAIL_LIMITS = {
  maxScanEvents: 5_000,
  maxTurns: 200,
} as const;

/** One turn = the list's trace summary. */
export type ThreadTurn = TraceListItem;

export interface ThreadDetail {
  threadId: string;
  /** Oldest first. */
  turns: ThreadTurn[];
  /** Events of this thread that have no trace id: counted, but they cannot be a turn or a link. */
  untracedEvents: number;
  /** A cap was hit: the newest events or turns are missing. */
  truncated: boolean;
  window: { fromMs: number; toMs: number };
}

export interface GetThreadOptions {
  /** Test hook. */
  nowMs?: number;
  /** Test hook: a LOWER event scan cap (never higher than THREAD_DETAIL_LIMITS.maxScanEvents). */
  scanCap?: number;
  /** Test hook: a LOWER turn cap (never higher than THREAD_DETAIL_LIMITS.maxTurns). */
  turnCap?: number;
}

// ONE static template; every value is a bound parameter.
// scan   the oldest events of the thread (any trace id), at most cap+1
// bounds how many were read, the newest timestamp, how many have no trace id
// kept   all of scan, or, when the cap was hit, only events OLDER than the newest timestamp read
// agg    one row per trace
// page   earliest turns first, turn limit + 1 (the extra row only proves "more")
// The left join keeps ONE row (null trace columns) when there are no turns, so `scanned` is always returned.
export function threadDetailStatement(
  t: Tx,
  a: { pid: string; threadId: string; fromIso: string; toIso: string; scanLimit: number; cap: number; fetchLimit: number },
) {
  return t`with scan as (
      select trace_id, parent_id, name, status, model, input_tokens, output_tokens, latency_ms, cost_usd, occurred_at
        from events
       where project_id = ${a.pid}::uuid and thread_id = ${a.threadId}::text
         and occurred_at >= ${a.fromIso}::timestamptz and occurred_at < ${a.toIso}::timestamptz
       order by occurred_at asc
       limit ${a.scanLimit}::int
    ), bounds as (
      select count(*)::int as scanned, max(occurred_at) as newest from scan
    ), kept as (
      select s.* from scan s cross join bounds b where b.scanned <= ${a.cap}::int or s.occurred_at < b.newest
    ), agg as (
      select trace_id,
             min(occurred_at) as start_at,
             max(occurred_at + coalesce(latency_ms, 0) * interval '1 millisecond') as end_at,
             count(*) as spans,
             count(*) filter (where status = 'error') as errors,
             sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) as tokens,
             sum(cost_usd) as cost,
             count(*) filter (where cost_usd is null and model is not null and model <> '') as unpriced,
             bool_or(parent_id is null) as has_root,
             (array_agg(name order by occurred_at) filter (where parent_id is null))[1] as root_name
        from kept
       where trace_id is not null
       group by trace_id
    ), page as (
      select * from agg order by start_at asc, trace_id asc limit ${a.fetchLimit}::int
    )
    select b.scanned, b.scanned > ${a.cap}::int as truncated,
           (select count(*) from kept where trace_id is null)::text as untraced,
           p.trace_id,
           floor(extract(epoch from p.start_at) * 1000)::bigint::text as started_at_ms,
           floor(extract(epoch from (p.end_at - p.start_at)) * 1000)::bigint::text as duration_ms,
           p.spans::text as spans, p.errors::text as errors, p.tokens::text as tokens,
           round(p.cost * 1000000)::bigint::text as cost_micro,
           p.unpriced::text as unpriced, p.has_root, p.root_name
      from bounds b left join page p on true
     order by p.start_at asc nulls last, p.trace_id asc`;
}

/** Throws NotFoundError for every way the thread cannot be shown (see the header). Never returns text from the database in an error. */
export async function getThread(ctx: SessionCtx, projectIdRaw: string, threadIdRaw: string, opts: GetThreadOptions = {}): Promise<ThreadDetail> {
  const pid = parseProjectId(projectIdRaw);
  assertInContext(ctx, pid);
  const parsed = traceIdSchema.safeParse(threadIdRaw); // the ingest rule for every id: 1 to 128 characters, no control characters
  if (!parsed.success) throw new NotFoundError();
  const threadId = parsed.data;
  const cap = Math.min(Math.max(Math.floor(opts.scanCap ?? THREAD_DETAIL_LIMITS.maxScanEvents) || 1, 1), THREAD_DETAIL_LIMITS.maxScanEvents);
  const turnCap = Math.min(Math.max(Math.floor(opts.turnCap ?? THREAD_DETAIL_LIMITS.maxTurns) || 1, 1), THREAD_DETAIL_LIMITS.maxTurns);
  const window = traceDetailWindow(opts.nowMs ?? Date.now());

  const [proj, raw] = await withTenant(ctx, (t) => [
    projectSelect(t, ctx, pid),
    threadDetailStatement(t, {
      pid,
      threadId,
      fromIso: new Date(window.fromMs).toISOString(),
      toIso: new Date(window.toMs).toISOString(),
      scanLimit: cap + 1,
      cap,
      fetchLimit: turnCap + 1,
    }),
  ]);
  if (!proj?.[0]) throw new NotFoundError();
  const rows = raw ?? [];
  if (rows.length === 0 || Number(rows[0]!.scanned) === 0) throw new NotFoundError();

  const turnRows = rows.filter((r) => r.trace_id !== null && r.trace_id !== undefined);
  const turnsTruncated = turnRows.length > turnCap;
  return {
    threadId,
    turns: (turnsTruncated ? turnRows.slice(0, turnCap) : turnRows).map(toItem),
    untracedEvents: Number(rows[0]!.untraced),
    truncated: rows[0]!.truncated === true || turnsTruncated,
    window,
  };
}
