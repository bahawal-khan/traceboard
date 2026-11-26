import { TS_WINDOW_MS } from "@/lib/ingest/normalize";
import { InvalidCursorError, NotFoundError } from "./errors";
import { assertInContext, parseProjectId, projectSelect } from "./project-guard";
import { withTenant, type SessionCtx, type Tx } from "./tenant";
import { toItem, type TraceListItem } from "./traces";
import { z } from "zod";

/**
 * "What is new in this project since my cursor": the data layer of GET /api/live (P3.8b) and, later, the SSE stream (P3.9).
 * The ONLY place the live delta is read.
 *
 * - Every statement goes through withTenant; the project is checked in the SAME transaction (foreign, missing, deleted and
 *   malformed project ids all end in the same NotFoundError, see project-guard).
 * - METADATA ONLY: the scan reads (id, received_at, trace_id, status); the trace summaries use the same structural columns as the
 *   trace list. event_content, error text, tags and hashes are never selected.
 * - THE CURSOR IS BASED ON INSERTION, not on the event's own timestamp: `events.received_at` (default now(), set by the database
 *   when the row is inserted) plus the row id as the tie-breaker. `occurred_at` is chosen by the SDK, so a late event
 *   (an old `ts`, a retried batch) would sort BEHIND a cursor built on it and be missed forever; `received_at` only moves forward.
 *   Keyset: `(received_at, id) > (cursor_ts, cursor_id)`, ascending, so a response that hits the cap continues exactly where it
 *   stopped (no gap, no repeat).
 * - SETTLE LAG: now() is the START time of the inserting transaction, not its commit time. A row can therefore become visible a
 *   little after a poll already passed its received_at. Only rows with `received_at <= now() - settleMs` are read, and the cursor
 *   never advances past that horizon, so a transaction that commits within `settleMs` of starting is never skipped. (The ingest
 *   write is one short transaction. A commit that takes longer than the lag, for example behind a long lock wait, can still be
 *   missed by a client that already polled past it: documented, not hidden.)
 * - First call (no cursor): a BASELINE. No query over history; the cursor is simply the current horizon, so a freshly opened page
 *   never downloads anything. A cursor older than `lookbackMs` is a RESET and answers the same baseline with `reset: true`.
 * - Partition pruning: ingest rejects events whose `ts` is outside now +/- 24 h, so a row received after the cursor has
 *   `occurred_at` in [cursor - 24 h, now + 24 h]; the statement bounds `occurred_at` to that range (plus a 1 h slack) so only the
 *   monthly partitions it touches are visited.
 * - Strict, opaque, tagged cursor (`lv`): anything this module did not issue throws InvalidCursorError (no detail leaks).
 */

export const LIVE_LIMITS = {
  /** A cursor older than this is a reset. The live view reads about 15 minutes (see the minute rollup reader). */
  lookbackMs: 15 * 60_000,
  /** Rows read per response. The free quota is 1,900 events a day, so this is only reached by a client that was away for long. */
  maxEvents: 1_000,
  /** Newest traces summarised per response. */
  recentTraces: 5,
  /** Rows newer than now() - settleMs are not read yet (see SETTLE LAG above). */
  settleMs: 1_000,
  /** The ingest timestamp window (now +/- 24 h) plus 1 h slack: the `occurred_at` range around a `received_at`. */
  occurredSlackMs: TS_WINDOW_MS + 3_600_000,
  /** A cursor may be at most this far ahead of this server's clock (database vs function clock skew); further is forged. */
  futureToleranceMs: 60_000,
  /** The trace summaries look this far back for the other events of a trace (the events retention, 14 days). */
  traceLookbackMs: 14 * 24 * 3_600_000,
} as const;

/** The biggest uuid: the "after every row of this timestamp" end of the keyset when a poll has read everything up to the horizon. */
export const LIVE_MAX_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

export interface LiveOptions {
  /** Test hook. */
  nowMs?: number;
  /** Test hook: a LOWER row cap (never above LIVE_LIMITS.maxEvents), so truncation is testable without 1,000 rows. */
  scanCap?: number;
  /** Test hook: a SHORTER settle lag (0 to LIVE_LIMITS.settleMs). Never expose to a request. */
  settleMs?: number;
}

export interface LiveResult {
  /** Always present: the high-water mark to send on the next call. */
  cursor: string;
  /** True when this call had no usable cursor and only returned the starting point (no history). */
  baseline: boolean;
  /** True when the given cursor was older than the lookback and was replaced by a fresh baseline. Implies `baseline`. */
  reset: boolean;
  /** The row cap was hit: more rows are waiting, the cursor stops at the last row counted, poll again right away. */
  truncated: boolean;
  /** Events inserted since the cursor (of every kind, including tool spans). */
  newEvents: number;
  newErrors: number;
  /** Distinct trace ids among the new events. */
  newTraces: number;
  /** Summaries of the newest traces that got events (whole trace, not only the new events), newest start first. */
  traces: TraceListItem[];
}

// ---- cursor ----

const CURSOR_MAX_CHARS = 256;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CURSOR_TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
/** Any 8-4-4-4-12 lowercase hex id. NOT zod's uuid(): that insists on version and variant bits, and the max id has neither. */
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const cursorSchema = z
  .object({
    /** "lv" tells a live cursor from a trace ("v" only) or thread ("th") cursor: one is never accepted as another. */
    k: z.literal("lv"),
    v: z.literal(1),
    /** received_at as UTC text with microseconds, exactly as the database returned it. */
    s: z.string().regex(CURSOR_TS),
    /** The row id (tie-breaker). */
    i: z.string().regex(CURSOR_ID),
  })
  .strict();

export interface LiveCursor {
  receivedAt: string;
  id: string;
}

export function encodeLiveCursor(c: LiveCursor): string {
  return Buffer.from(JSON.stringify({ k: "lv", v: 1, s: c.receivedAt, i: c.id }), "utf8").toString("base64url");
}

/** Milliseconds (UTC) of a cursor timestamp text; the microseconds are dropped. Pure. */
function cursorMs(text: string): number {
  const m = CURSOR_TS.exec(text)!;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, Math.floor(+m[7]! / 1000));
}

/** Strict: anything that is not exactly a cursor this module produced throws InvalidCursorError. */
export function decodeLiveCursor(raw: string): LiveCursor {
  try {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > CURSOR_MAX_CHARS || !BASE64URL.test(raw)) throw new InvalidCursorError();
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    const m = CURSOR_TS.exec(parsed.s)!;
    const year = +m[1]!;
    // A date that only parses by rolling over (02-31, hour 25) would reach Postgres as an error.
    if (year < 2000 || year > 2100 || new Date(cursorMs(parsed.s)).toISOString().slice(0, 19) !== parsed.s.slice(0, 19)) throw new InvalidCursorError();
    return { receivedAt: parsed.s, id: parsed.i };
  } catch {
    throw new InvalidCursorError();
  }
}

// ---- the statement (ONE static template; every value is a bound parameter) ----
//
// fresh   rows inserted after the cursor and up to the horizon, oldest insertion first, at most cap+1. With no cursor
//         (baseline or reset) the one-time filter makes this return nothing without touching the table.
//         Index: (project_id, received_at, id) is what this wants (see scripts/explain-live.mjs); the existing
//         (project_id, occurred_at desc) index can only serve the bounded occurred_at range and filter the rest.
// kept    the first cap rows of fresh; `truncated` = fresh had more than cap
// tot     counts over kept
// nxt     the next cursor: the last kept row when truncated; else the horizon (or the given cursor, if it is somehow ahead of it)
//         with the biggest id, meaning "everything up to the horizon has been read"
// recent  the newest few traces among kept
// tr      the whole-trace aggregate of those traces (same columns as the trace list, so toItem maps it)
// The left join keeps ONE row (null trace columns) when there are no traces, so the totals and the cursor always come back.
export function liveStatement(
  t: Tx,
  a: {
    pid: string;
    cursorTs: string | null;
    cursorId: string | null;
    settleMs: number;
    fromIso: string;
    toIso: string;
    scanLimit: number;
    cap: number;
    traceLimit: number;
    traceFromIso: string;
  },
) {
  return t`with fresh as (
      select id, received_at, trace_id, status
        from events
       where ${a.cursorTs}::timestamptz is not null
         and project_id = ${a.pid}::uuid
         and occurred_at >= ${a.fromIso}::timestamptz and occurred_at < ${a.toIso}::timestamptz
         and received_at <= now() - ${a.settleMs}::int * interval '1 millisecond'
         and (received_at, id) > (${a.cursorTs}::timestamptz, ${a.cursorId}::uuid)
       order by received_at, id
       limit ${a.scanLimit}::int
    ), kept as (
      select id, received_at, trace_id, status from fresh order by received_at, id limit ${a.cap}::int
    ), tot as (
      select count(*)::int as ev_count,
             count(*) filter (where status = 'error')::int as err_count,
             count(distinct trace_id)::int as trace_count,
             (select count(*) from fresh) > ${a.cap}::int as truncated
        from kept
    ), nxt as (
      select case when tot.truncated then l.received_at
                  when ${a.cursorTs}::timestamptz > h.horizon then ${a.cursorTs}::timestamptz
                  else h.horizon end as ts,
             case when tot.truncated then l.id
                  when ${a.cursorTs}::timestamptz > h.horizon then ${a.cursorId}::uuid
                  else 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid end as id
        from tot
        cross join (select now() - ${a.settleMs}::int * interval '1 millisecond' as horizon) h
        left join (select received_at, id from kept order by received_at desc, id desc limit 1) l on true
    ), recent as (
      select trace_id, max(received_at) as last_r from kept where trace_id is not null
       group by trace_id order by last_r desc, trace_id desc limit ${a.traceLimit}::int
    ), tr as (
      select e.trace_id,
             min(e.occurred_at) as start_at,
             max(e.occurred_at + coalesce(e.latency_ms, 0) * interval '1 millisecond') as end_at,
             count(*) as spans,
             count(*) filter (where e.status = 'error') as errors,
             sum(coalesce(e.input_tokens, 0) + coalesce(e.output_tokens, 0)) as tokens,
             sum(e.cost_usd) as cost,
             count(*) filter (where e.cost_usd is null and e.model is not null and e.model <> '') as unpriced,
             bool_or(e.parent_id is null) as has_root,
             (array_agg(e.name order by e.occurred_at) filter (where e.parent_id is null))[1] as root_name
        from events e join recent r on r.trace_id = e.trace_id
       where e.project_id = ${a.pid}::uuid
         and e.occurred_at >= ${a.traceFromIso}::timestamptz and e.occurred_at < ${a.toIso}::timestamptz
       group by e.trace_id
    )
    select tot.ev_count::text as ev_count, tot.err_count::text as err_count, tot.trace_count::text as trace_count, tot.truncated,
           to_char(nxt.ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as next_ts,
           nxt.id::text as next_id,
           p.trace_id,
           floor(extract(epoch from p.start_at) * 1000)::bigint::text as started_at_ms,
           floor(extract(epoch from (p.end_at - p.start_at)) * 1000)::bigint::text as duration_ms,
           p.spans::text as spans, p.errors::text as errors, p.tokens::text as tokens,
           round(p.cost * 1000000)::bigint::text as cost_micro,
           p.unpriced::text as unpriced, p.has_root, p.root_name
      from tot cross join nxt left join tr p on true
     order by p.start_at desc nulls last, p.trace_id desc`;
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return def;
  return Math.min(Math.max(Math.floor(v), min), max);
}

/**
 * New rows of one project since `cursor`. Throws NotFoundError (project) or InvalidCursorError (cursor); never database text.
 * No cursor, or a cursor older than the lookback, answers a baseline (see the header).
 */
export async function getLiveSince(ctx: SessionCtx, projectIdRaw: string, cursor?: string | undefined, opts: LiveOptions = {}): Promise<LiveResult> {
  const pid = parseProjectId(projectIdRaw);
  assertInContext(ctx, pid);
  const decoded = cursor === undefined ? null : decodeLiveCursor(cursor);
  const nowMs = opts.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new RangeError("invalid time");
  const cap = clampInt(opts.scanCap, LIVE_LIMITS.maxEvents, 1, LIVE_LIMITS.maxEvents);
  const settleMs = clampInt(opts.settleMs, LIVE_LIMITS.settleMs, 0, LIVE_LIMITS.settleMs);

  let reset = false;
  let active: LiveCursor | null = decoded;
  if (decoded) {
    const ms = cursorMs(decoded.receivedAt);
    // Nobody can hold a cursor from the future: it is forged (a small tolerance covers database vs function clock skew).
    if (ms > nowMs + LIVE_LIMITS.futureToleranceMs) throw new InvalidCursorError();
    if (ms < nowMs - LIVE_LIMITS.lookbackMs) {
      reset = true;
      active = null;
    }
  }
  const lowerMs = (active ? cursorMs(active.receivedAt) : nowMs) - LIVE_LIMITS.occurredSlackMs;
  const upperMs = nowMs + LIVE_LIMITS.occurredSlackMs;

  const [proj, raw] = await withTenant(ctx, (t) => [
    projectSelect(t, ctx, pid),
    liveStatement(t, {
      pid,
      cursorTs: active?.receivedAt ?? null,
      cursorId: active?.id ?? null,
      settleMs,
      fromIso: new Date(lowerMs).toISOString(),
      toIso: new Date(upperMs).toISOString(),
      scanLimit: cap + 1,
      cap,
      traceLimit: LIVE_LIMITS.recentTraces,
      traceFromIso: new Date(nowMs - LIVE_LIMITS.traceLookbackMs).toISOString(),
    }),
  ]);
  if (!proj?.[0]) throw new NotFoundError();

  const rows = raw ?? [];
  const head = rows[0];
  if (!head) throw new Error("live: the statement returned no row");
  const traces = rows.filter((r) => r.trace_id !== null && r.trace_id !== undefined).map(toItem);
  return {
    cursor: encodeLiveCursor({ receivedAt: String(head.next_ts), id: String(head.next_id) }),
    baseline: active === null,
    reset,
    truncated: head.truncated === true,
    newEvents: Number(head.ev_count),
    newErrors: Number(head.err_count),
    newTraces: Number(head.trace_count),
    traces,
  };
}
