import { z } from "zod";
import { QUOTAS, RETENTION } from "@/lib/quotas";
import { InvalidCursorError, NotFoundError } from "./errors";
import { clampWindow, type ClampedWindow } from "./metrics";
import { assertInContext, parseProjectId, projectSelect } from "./project-guard";
import { withTenant, type SessionCtx, type Tx } from "./tenant";

/**
 * Thread LIST reader: one row per thread_id (a conversation), aggregated from `events`. The ONLY place the thread list is read.
 * Same rules as the trace list (lib/repo/traces.ts):
 *
 * - Every statement goes through withTenant; the project is checked in the SAME transaction (foreign, missing, deleted and
 *   malformed project ids all end in the same NotFoundError).
 * - The time range is mandatory and clamped HERE (14 days = the events retention, whole hours, never in the future), so the
 *   statement has a bounded `occurred_at` range (partition pruning) and uses the (project_id, occurred_at desc) index.
 * - Rows scanned are capped (THREAD_LIMITS.maxScanRows). Past the cap the OLDEST events are dropped (whole timestamps only) and
 *   `truncated` is true: "most recently active threads first; older ones may be missing, the oldest shown may be partial".
 * - Order: last activity (newest event start) descending, then thread id descending. Keyset cursor on exactly that pair, opaque
 *   and strictly validated.
 * - Metadata only. No content (event_content is never joined), no error text, no tags, no hashes. Thread ids are shown as sent.
 * - Cost: `null` = nothing is priced, never 0; `costLowerBound` when an event with a model has no cost (same rule as traces).
 * - A thread's events with no trace id still count as events (`spanCount`) but not as traces (`traceCount`): the detail page
 *   can only link to traces.
 */

export const THREAD_LIMITS = {
  maxWindowMs: RETENTION.eventsDays * 24 * 3_600_000,
  bucketMs: 3_600_000,
  defaultPageSize: 50,
  maxPageSize: 100,
  /** Events read per call; same reasoning as the trace list (events quota x retention, plus 15%). */
  maxScanRows: Math.ceil((QUOTAS.eventsPerDayPerProject * RETENTION.eventsDays * 1.15) / 100) * 100,
} as const;

export interface ThreadListOptions {
  /** Mandatory. Clamped: at most 14 days, aligned to whole hours, never beyond the current hour. */
  range: { fromMs: number; toMs: number };
  /** Opaque, from a previous `nextCursor`. Invalid -> InvalidCursorError. */
  cursor?: string | undefined;
  /** Default 50, at most 100. */
  limit?: number | undefined;
  /** Test hook. */
  nowMs?: number;
  /** Test hook: a LOWER scan cap (never higher than THREAD_LIMITS.maxScanRows). */
  scanCap?: number;
}

export const threadListItemSchema = z
  .object({
    threadId: z.string().min(1).max(128),
    /** Earliest event in the window (may be later than the real start when the thread began before the window). */
    startedAtMs: z.number().int().nonnegative(),
    /** Start of the newest event: the sort key. */
    lastActiveAtMs: z.number().int().nonnegative(),
    /** Distinct trace ids (turns). */
    traceCount: z.number().int().nonnegative(),
    /** Events of every kind in the thread. */
    spanCount: z.number().int().positive(),
    errorCount: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    /** Micro-USD. null = nothing priced. With `costLowerBound` the number is a lower bound. */
    costMicro: z.number().int().nonnegative().nullable(),
    costLowerBound: z.boolean(),
    unpricedEvents: z.number().int().nonnegative(),
  })
  .strict();
export type ThreadListItem = z.infer<typeof threadListItemSchema>;

export interface ThreadListResult {
  items: ThreadListItem[];
  nextCursor: string | null;
  /** The scan cap was hit: older events were not read. */
  truncated: boolean;
  window: ClampedWindow;
}

// ---- cursor ----

const CURSOR_MAX_CHARS = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CURSOR_TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

const cursorSchema = z
  .object({
    /** "th" tells a thread cursor from a trace cursor: one is never accepted as the other. */
    k: z.literal("th"),
    v: z.literal(1),
    /** Last activity as UTC text with microseconds, exactly as the database returned it. */
    s: z.string().regex(CURSOR_TS),
    t: z.string().min(1).max(128).regex(NO_CONTROL),
  })
  .strict();
export interface ThreadCursor {
  lastActive: string;
  threadId: string;
}

export function encodeThreadCursor(c: ThreadCursor): string {
  return Buffer.from(JSON.stringify({ k: "th", v: 1, s: c.lastActive, t: c.threadId }), "utf8").toString("base64url");
}

/** Strict: anything that is not exactly a cursor this module produced throws InvalidCursorError (no parse details leak). */
export function decodeThreadCursor(raw: string): ThreadCursor {
  try {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > CURSOR_MAX_CHARS || !BASE64URL.test(raw)) throw new InvalidCursorError();
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    const m = CURSOR_TS.exec(parsed.s)!;
    const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, 0);
    const year = +m[1]!;
    if (year < 2000 || year > 2100 || new Date(ms).toISOString().slice(0, 19) !== parsed.s.slice(0, 19)) throw new InvalidCursorError();
    return { lastActive: parsed.s, threadId: parsed.t };
  } catch {
    throw new InvalidCursorError();
  }
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return THREAD_LIMITS.defaultPageSize;
  return Math.min(Math.max(Math.floor(limit), 1), THREAD_LIMITS.maxPageSize);
}

// ---- the statement (ONE static template; every value is a bound parameter) ----
//
// scan   newest events of the project that have a thread id, at most cap+1
// bounds how many were read and the oldest timestamp
// kept   all of scan, or, when the cap was hit, only events NEWER than the oldest timestamp read (whole timestamps)
// agg    one row per thread_id
// page   keyset cursor on (last_at, thread_id) descending, page size + 1 (the extra row only proves "more")
// The left join keeps ONE row (null thread columns) when the page is empty, so `scanned`/`truncated` are always returned.
export function threadListStatement(
  t: Tx,
  a: {
    pid: string;
    fromIso: string;
    toIso: string;
    scanLimit: number;
    cap: number;
    cursorLast: string | null;
    cursorThread: string | null;
    fetchLimit: number;
  },
) {
  return t`with scan as (
      select thread_id, trace_id, status, model, input_tokens, output_tokens, cost_usd, occurred_at
        from events
       where project_id = ${a.pid}::uuid and occurred_at >= ${a.fromIso}::timestamptz and occurred_at < ${a.toIso}::timestamptz
         and thread_id is not null
       order by occurred_at desc
       limit ${a.scanLimit}::int
    ), bounds as (
      select count(*)::int as scanned, min(occurred_at) as oldest from scan
    ), kept as (
      select s.* from scan s cross join bounds b where b.scanned <= ${a.cap}::int or s.occurred_at > b.oldest
    ), agg as (
      select thread_id,
             min(occurred_at) as first_at,
             max(occurred_at) as last_at,
             count(distinct trace_id) as traces,
             count(*) as spans,
             count(*) filter (where status = 'error') as errors,
             sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) as tokens,
             sum(cost_usd) as cost,
             count(*) filter (where cost_usd is null and model is not null and model <> '') as unpriced
        from kept
       group by thread_id
    ), page as (
      select * from agg
       where (${a.cursorLast}::timestamptz is null or (last_at, thread_id) < (${a.cursorLast}::timestamptz, ${a.cursorThread}::text))
       order by last_at desc, thread_id desc
       limit ${a.fetchLimit}::int
    )
    select b.scanned, b.scanned > ${a.cap}::int as truncated,
           p.thread_id,
           floor(extract(epoch from p.first_at) * 1000)::bigint::text as started_at_ms,
           floor(extract(epoch from p.last_at) * 1000)::bigint::text as last_active_ms,
           to_char(p.last_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_text,
           p.traces::text as traces, p.spans::text as spans, p.errors::text as errors, p.tokens::text as tokens,
           round(p.cost * 1000000)::bigint::text as cost_micro,
           p.unpriced::text as unpriced
      from bounds b left join page p on true
     order by p.last_at desc nulls last, p.thread_id desc`;
}

function toItem(r: Record<string, unknown>): ThreadListItem {
  const unpriced = Number(r.unpriced);
  const costMicro = r.cost_micro === null || r.cost_micro === undefined ? null : Number(r.cost_micro);
  return threadListItemSchema.parse({
    threadId: String(r.thread_id),
    startedAtMs: Number(r.started_at_ms),
    lastActiveAtMs: Number(r.last_active_ms),
    traceCount: Number(r.traces),
    spanCount: Number(r.spans),
    errorCount: Number(r.errors),
    totalTokens: Number(r.tokens),
    // No cost on any event: a real 0 when nothing needed a price (tool-only), unknown when something did.
    costMicro: costMicro === null && unpriced === 0 ? 0 : costMicro,
    costLowerBound: unpriced > 0,
    unpricedEvents: unpriced,
  });
}

/** Most recently active first. Throws NotFoundError (project) or InvalidCursorError (cursor); never database text. */
export async function listThreads(ctx: SessionCtx, projectIdRaw: string, opts: ThreadListOptions): Promise<ThreadListResult> {
  const pid = parseProjectId(projectIdRaw);
  assertInContext(ctx, pid);
  const cursor = opts.cursor === undefined ? null : decodeThreadCursor(opts.cursor);
  const limit = pageSize(opts.limit);
  const nowMs = opts.nowMs ?? Date.now();
  const cap = Math.min(Math.max(Math.floor(opts.scanCap ?? THREAD_LIMITS.maxScanRows) || 1, 1), THREAD_LIMITS.maxScanRows);
  const window = clampWindow(opts.range, { bucketMs: THREAD_LIMITS.bucketMs, maxWindowMs: THREAD_LIMITS.maxWindowMs, nowMs });

  const [proj, raw] = await withTenant(ctx, (t) => [
    projectSelect(t, ctx, pid),
    threadListStatement(t, {
      pid,
      fromIso: new Date(window.fromMs).toISOString(),
      toIso: new Date(window.toMs).toISOString(),
      scanLimit: cap + 1,
      cap,
      cursorLast: cursor?.lastActive ?? null,
      cursorThread: cursor?.threadId ?? null,
      fetchLimit: limit + 1,
    }),
  ]);
  if (!proj?.[0]) throw new NotFoundError();

  const rows = (raw ?? []).filter((r) => r.thread_id !== null && r.thread_id !== undefined);
  const truncated = (raw ?? [])[0]?.truncated === true;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(toItem),
    nextCursor: hasMore && last ? encodeThreadCursor({ lastActive: String(last.last_text), threadId: String(last.thread_id) }) : null,
    truncated,
    window,
  };
}

/** `listThreads` for a cursor that comes from a URL: an unusable cursor returns the FIRST page (never an error page). */
export async function listThreadsTolerant(
  ctx: SessionCtx,
  projectIdRaw: string,
  opts: ThreadListOptions,
): Promise<{ result: ThreadListResult; usedCursor: boolean }> {
  try {
    return { result: await listThreads(ctx, projectIdRaw, opts), usedCursor: opts.cursor !== undefined };
  } catch (e) {
    if (e instanceof InvalidCursorError) return { result: await listThreads(ctx, projectIdRaw, { ...opts, cursor: undefined }), usedCursor: false };
    throw e;
  }
}
