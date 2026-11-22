import { z } from "zod";
import { QUOTAS, RETENTION } from "@/lib/quotas";
import { InvalidCursorError, NotFoundError } from "./errors";
import { clampWindow, type ClampedWindow } from "./metrics";
import { assertInContext, parseProjectId, projectSelect } from "./project-guard";
import { withTenant, type SessionCtx, type Tx } from "./tenant";

/**
 * Trace LIST reader: one row per trace_id, aggregated from `events`. The ONLY place the trace list is read.
 *
 * - Every statement goes through withTenant; the project is checked in the SAME transaction (shared guard with the metrics
 *   reader: foreign, missing, deleted and malformed ids all end in the same NotFoundError).
 * - The time range is mandatory and clamped HERE (14 days = the events retention, aligned to the hour, never in the future),
 *   so the statement always has a bounded `occurred_at` range (partition pruning) and the (project_id, occurred_at desc) index.
 * - Rows scanned are capped (TRACE_LIMITS.maxScanRows). Past the cap the OLDEST events are dropped (whole timestamps only) and
 *   `truncated` is true; the list is then "newest traces first, older ones may be missing or partial", never silently wrong.
 * - Pagination is keyset on (start, trace_id), both descending, with an opaque strictly validated cursor.
 * - Only structural columns are selected. No prompt/response text (that lives in event_content and is never joined), no
 *   error text, no tags, no hashes.
 * - Cost: `null` = no cost is known (every priced-looking event is unpriced), never 0. `costLowerBound` is true when at least
 *   one LLM event (an event with a model) has no cost, same rule as the metrics reader. Events without a model (tool spans)
 *   are not unpriced: they cost nothing.
 */

export const TRACE_LIMITS = {
  /** 14 days: the events retention. Nothing older exists. */
  maxWindowMs: RETENTION.eventsDays * 24 * 3_600_000,
  bucketMs: 3_600_000,
  defaultPageSize: 50,
  maxPageSize: 100,
  /**
   * Events read per call. The real worst case is the events quota x the retention (1,900 x 14 = 26,600); the cap sits just
   * above it, so on the free plan it is only reached by a project that was allowed more than the quota.
   */
  maxScanRows: Math.ceil((QUOTAS.eventsPerDayPerProject * RETENTION.eventsDays * 1.15) / 100) * 100,
} as const;

export const traceStatusFilter = z.enum(["ok", "error"]);
export type TraceStatusFilter = z.infer<typeof traceStatusFilter>;

export interface TraceListOptions {
  /** Mandatory. Clamped: at most 14 days, aligned to whole hours, never beyond the current hour. */
  range: { fromMs: number; toMs: number };
  /** "error": traces with at least one failed event. "ok": traces with none. Applied after grouping. */
  status?: TraceStatusFilter | undefined;
  /** Opaque, from a previous `nextCursor`. Invalid -> InvalidCursorError. */
  cursor?: string | undefined;
  /** Default 50, at most 100. */
  limit?: number | undefined;
  /** Test hook. */
  nowMs?: number;
  /** Test hook: a LOWER scan cap (never higher than TRACE_LIMITS.maxScanRows), so truncation can be tested without 30,000 rows. */
  scanCap?: number;
}

export const traceListItemSchema = z
  .object({
    traceId: z.string().min(1).max(128),
    startedAtMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    spanCount: z.number().int().positive(),
    errorCount: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    /** Micro-USD. null = nothing priced (every LLM event is unpriced). With `costLowerBound` the number is a lower bound. */
    costMicro: z.number().int().nonnegative().nullable(),
    costLowerBound: z.boolean(),
    unpricedEvents: z.number().int().nonnegative(),
    /** Name of the root span (the earliest event without a parent); null when there is no root or it has no name. */
    rootName: z.string().nullable(),
    /** False for an orphan trace: every event points at a parent that was never received (or is outside the window). */
    hasRoot: z.boolean(),
  })
  .strict();
export type TraceListItem = z.infer<typeof traceListItemSchema>;

export interface TraceListResult {
  items: TraceListItem[];
  /** Pass to the next call; null on the last page. */
  nextCursor: string | null;
  /** The scan cap was hit: older events were not read, so older traces may be missing and the oldest shown may be partial. */
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
    v: z.literal(1),
    /** Trace start as UTC text with microseconds (exactly what the database returned; ms would lose the tail and repeat rows). */
    s: z.string().regex(CURSOR_TS),
    t: z.string().min(1).max(128).regex(NO_CONTROL),
  })
  .strict();
export interface TraceCursor {
  start: string;
  traceId: string;
}

export function encodeCursor(c: TraceCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, s: c.start, t: c.traceId }), "utf8").toString("base64url");
}

/** Strict: anything that is not exactly a cursor this module produced throws InvalidCursorError (no parse details leak). */
export function decodeCursor(raw: string): TraceCursor {
  try {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > CURSOR_MAX_CHARS || !BASE64URL.test(raw)) throw new InvalidCursorError();
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    const m = CURSOR_TS.exec(parsed.s)!;
    const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, 0);
    // A date that only parses by rolling over (02-31, hour 25) or lies outside the plausible range would reach Postgres as an error.
    const year = +m[1]!;
    if (year < 2000 || year > 2100 || new Date(ms).toISOString().slice(0, 19) !== parsed.s.slice(0, 19)) throw new InvalidCursorError();
    return { start: parsed.s, traceId: parsed.t };
  } catch {
    throw new InvalidCursorError();
  }
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TRACE_LIMITS.defaultPageSize;
  return Math.min(Math.max(Math.floor(limit), 1), TRACE_LIMITS.maxPageSize);
}

// ---- the statement (ONE static template; every value is a bound parameter) ----
//
// scan   newest events of the project in the window, at most cap+1 (index: project_id, occurred_at desc; ordered Append over
//        the monthly partitions the range touches, stops at the limit)
// bounds how many were read and the oldest timestamp
// kept   all of scan, or, when the cap was hit, only events NEWER than the oldest timestamp read (whole timestamps, so the
//        result never depends on which of several equal-timestamp rows the limit happened to cut)
// agg    one row per trace_id (hash aggregate over at most `cap` narrow rows)
// page   cursor and status filter, ordered by (start desc, trace_id desc), page size + 1 (the extra row only proves "more")
// The left join keeps ONE row (with null trace columns) when the page is empty, so `scanned`/`truncated` are always returned.
export function traceListStatement(
  t: Tx,
  a: {
    pid: string;
    fromIso: string;
    toIso: string;
    scanLimit: number;
    cap: number;
    cursorStart: string | null;
    cursorTrace: string | null;
    status: string | null;
    fetchLimit: number;
  },
) {
  return t`with scan as (
      select trace_id, parent_id, name, status, model, input_tokens, output_tokens, latency_ms, cost_usd, occurred_at
        from events
       where project_id = ${a.pid}::uuid and occurred_at >= ${a.fromIso}::timestamptz and occurred_at < ${a.toIso}::timestamptz
         and trace_id is not null
       order by occurred_at desc
       limit ${a.scanLimit}::int
    ), bounds as (
      select count(*)::int as scanned, min(occurred_at) as oldest from scan
    ), kept as (
      select s.* from scan s cross join bounds b where b.scanned <= ${a.cap}::int or s.occurred_at > b.oldest
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
       group by trace_id
    ), page as (
      select * from agg
       where (${a.cursorStart}::timestamptz is null or (start_at, trace_id) < (${a.cursorStart}::timestamptz, ${a.cursorTrace}::text))
         and (${a.status}::text is null or (${a.status}::text = 'error') = (errors > 0))
       order by start_at desc, trace_id desc
       limit ${a.fetchLimit}::int
    )
    select b.scanned, b.scanned > ${a.cap}::int as truncated,
           p.trace_id,
           floor(extract(epoch from p.start_at) * 1000)::bigint::text as started_at_ms,
           to_char(p.start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as start_text,
           floor(extract(epoch from (p.end_at - p.start_at)) * 1000)::bigint::text as duration_ms,
           p.spans::text as spans, p.errors::text as errors, p.tokens::text as tokens,
           round(p.cost * 1000000)::bigint::text as cost_micro,
           p.unpriced::text as unpriced, p.has_root, p.root_name
      from bounds b left join page p on true
     order by p.start_at desc nulls last, p.trace_id desc`;
}

function toItem(r: Record<string, unknown>): TraceListItem {
  const unpriced = Number(r.unpriced);
  const costMicro = r.cost_micro === null || r.cost_micro === undefined ? null : Number(r.cost_micro);
  return traceListItemSchema.parse({
    traceId: String(r.trace_id),
    startedAtMs: Number(r.started_at_ms),
    durationMs: Number(r.duration_ms),
    spanCount: Number(r.spans),
    errorCount: Number(r.errors),
    totalTokens: Number(r.tokens),
    // No cost on any event: 0 when nothing in the trace needed a price (tool-only), unknown when something did.
    costMicro: costMicro === null && unpriced === 0 ? 0 : costMicro,
    costLowerBound: unpriced > 0,
    unpricedEvents: unpriced,
    rootName: r.root_name === null || r.root_name === undefined ? null : String(r.root_name),
    hasRoot: r.has_root === true,
  });
}

/**
 * Newest traces first. Throws NotFoundError (project), InvalidCursorError (cursor) or ZodError (status filter: a caller bug,
 * validate before). Never returns text from the database in an error.
 */
export async function listTraces(ctx: SessionCtx, projectIdRaw: string, opts: TraceListOptions): Promise<TraceListResult> {
  const pid = parseProjectId(projectIdRaw);
  assertInContext(ctx, pid);
  const status = opts.status === undefined ? null : traceStatusFilter.parse(opts.status);
  const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  const limit = pageSize(opts.limit);
  const nowMs = opts.nowMs ?? Date.now();
  const cap = Math.min(Math.max(Math.floor(opts.scanCap ?? TRACE_LIMITS.maxScanRows) || 1, 1), TRACE_LIMITS.maxScanRows);
  const window = clampWindow(opts.range, { bucketMs: TRACE_LIMITS.bucketMs, maxWindowMs: TRACE_LIMITS.maxWindowMs, nowMs });

  const [proj, raw] = await withTenant(ctx, (t) => [
    projectSelect(t, ctx, pid),
    traceListStatement(t, {
      pid,
      fromIso: new Date(window.fromMs).toISOString(),
      toIso: new Date(window.toMs).toISOString(),
      scanLimit: cap + 1,
      cap,
      cursorStart: cursor?.start ?? null,
      cursorTrace: cursor?.traceId ?? null,
      status,
      fetchLimit: limit + 1,
    }),
  ]);
  if (!proj?.[0]) throw new NotFoundError();

  const rows = (raw ?? []).filter((r) => r.trace_id !== null && r.trace_id !== undefined);
  const truncated = (raw ?? [])[0]?.truncated === true;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(toItem),
    nextCursor: hasMore && last ? encodeCursor({ start: String(last.start_text), traceId: String(last.trace_id) }) : null,
    truncated,
    window,
  };
}

/**
 * `listTraces` for a cursor that comes straight from a URL: when the cursor is not one this module issued, the FIRST page is
 * returned instead of an error (a hand-edited link must never produce an error page). `usedCursor` says which one the caller
 * got. Every other failure propagates unchanged. The bad cursor is rejected before any database call, so the fallback costs
 * one transaction, not two.
 */
export async function listTracesTolerant(
  ctx: SessionCtx,
  projectIdRaw: string,
  opts: TraceListOptions,
): Promise<{ result: TraceListResult; usedCursor: boolean }> {
  try {
    return { result: await listTraces(ctx, projectIdRaw, opts), usedCursor: opts.cursor !== undefined };
  } catch (e) {
    if (e instanceof InvalidCursorError) return { result: await listTraces(ctx, projectIdRaw, { ...opts, cursor: undefined }), usedCursor: false };
    throw e;
  }
}
