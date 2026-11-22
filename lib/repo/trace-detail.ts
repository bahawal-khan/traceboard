import { z } from "zod";
import { RETENTION } from "@/lib/quotas";
import { NotFoundError } from "./errors";
import { assertInContext, parseProjectId, projectSelect } from "./project-guard";
import { withTenant, type SessionCtx, type Tx } from "./tenant";

/**
 * Trace DETAIL reader: the spans of ONE trace, structure and numbers only. The only place the span list is read.
 *
 * - Every statement goes through withTenant; the project is checked in the SAME transaction (shared guard with the metrics
 *   and list readers).
 * - ONE NotFoundError for everything that is not a readable trace of the caller's project: a foreign, missing, deleted or
 *   malformed project id, a malformed trace id, a trace that does not exist, a trace that belongs to another project, and a
 *   trace that is older than the retention window. Nothing an outsider can observe tells these apart.
 * - Time-bounded: `occurred_at` is limited to the 14-day retention window (plus the 24 h the ingest accepts into the future,
 *   so the detail never shows fewer spans than the list counted), which prunes the monthly partitions; the project and
 *   trace id are matched with the (project_id, trace_id) index.
 * - Row cap: at most TRACE_DETAIL_LIMITS.maxSpans spans; the OLDEST are kept (the top of the tree), the rest are dropped and
 *   `truncated` says so.
 * - Only metadata columns. No content (event_content is never joined), no error TEXT (a flag only), no tags, no hashes.
 * - Cost: `costMicro` null means "no cost on this span"; `unpriced` is true when the span HAS a model but no cost (the list's
 *   rule), so the UI can say "no price" instead of showing a dash that looks like "not applicable".
 */

export const TRACE_DETAIL_LIMITS = {
  /** Spans returned. A trace can hold at most the events quota per day (1,900) from one day; 2,000 covers a full day with margin. */
  maxSpans: 2_000,
  retentionMs: RETENTION.eventsDays * 24 * 3_600_000,
  bucketMs: 3_600_000,
  /** The ingest accepts timestamps up to 24 h ahead; the window reaches that far so a late-clock span is not hidden. */
  futureMs: 24 * 3_600_000,
} as const;

/** The same rule ingest applies to a trace id (1 to 128 characters, no control characters), checked before any database call. */
export const traceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\u0000-\u001f\u007f]*$/);

export const spanRowSchema = z
  .object({
    /** The span id, or `ev-<event id>` for an event sent without one (so every row has a unique key). */
    key: z.string().min(1),
    parentId: z.string().nullable(),
    name: z.string().nullable(),
    kind: z.string().nullable(),
    model: z.string().nullable(),
    isError: z.boolean(),
    /** Start in microseconds since the epoch (exact; a millisecond number would reorder spans that start together). */
    startUs: z.number().int().nonnegative(),
    /** Passed through as stored: the tree builder treats a negative value as unknown, so one odd row never breaks the page. */
    latencyMs: z.number().int().nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cachedTokens: z.number().int().nonnegative().nullable(),
    costMicro: z.number().int().nonnegative().nullable(),
    unpriced: z.boolean(),
  })
  .strict();
export type SpanRow = z.infer<typeof spanRowSchema>;

export interface TraceDetail {
  traceId: string;
  /** Oldest first (start, then event id). The tree builder orders them for display. */
  spans: SpanRow[];
  /** More spans exist than the cap: the newest ones are missing. */
  truncated: boolean;
  window: { fromMs: number; toMs: number };
}

export interface GetTraceOptions {
  /** Test hook. */
  nowMs?: number;
  /** Test hook: a LOWER cap (never higher than TRACE_DETAIL_LIMITS.maxSpans). */
  spanCap?: number;
}

/** Pure. Whole hours, 14 days back from the end of the current hour, 24 h ahead of it. */
export function traceDetailWindow(nowMs: number): { fromMs: number; toMs: number } {
  if (!Number.isFinite(nowMs)) throw new RangeError("invalid time");
  const hourEnd = (Math.floor(nowMs / TRACE_DETAIL_LIMITS.bucketMs) + 1) * TRACE_DETAIL_LIMITS.bucketMs;
  return { fromMs: hourEnd - TRACE_DETAIL_LIMITS.retentionMs, toMs: hourEnd + TRACE_DETAIL_LIMITS.futureMs };
}

// One static statement, every value a bound parameter. Ordered oldest first so the cap keeps the top of the tree.
function spansSelect(t: Tx, a: { pid: string; traceId: string; fromIso: string; toIso: string; limit: number }) {
  return t`select coalesce(span_id, 'ev-' || event_id::text) as span_key, parent_id, name, kind, model, status,
           latency_ms, input_tokens, output_tokens, cached_tokens,
           round(cost_usd * 1000000)::bigint::text as cost_micro,
           (cost_usd is null and model is not null and model <> '') as unpriced,
           floor(extract(epoch from occurred_at) * 1000000)::bigint::text as start_us
      from events
     where project_id = ${a.pid}::uuid and trace_id = ${a.traceId}::text
       and occurred_at >= ${a.fromIso}::timestamptz and occurred_at < ${a.toIso}::timestamptz
     order by occurred_at asc, event_id asc
     limit ${a.limit}::int`;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toSpan(r: Record<string, unknown>): SpanRow {
  return spanRowSchema.parse({
    key: String(r.span_key),
    parentId: str(r.parent_id),
    name: str(r.name),
    kind: str(r.kind),
    model: str(r.model),
    isError: r.status === "error",
    startUs: Number(r.start_us),
    latencyMs: num(r.latency_ms),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cachedTokens: num(r.cached_tokens),
    costMicro: num(r.cost_micro),
    unpriced: r.unpriced === true,
  });
}

/** Throws NotFoundError for every way the trace cannot be shown (see the header). Never returns text from the database in an error. */
export async function getTrace(ctx: SessionCtx, projectIdRaw: string, traceIdRaw: string, opts: GetTraceOptions = {}): Promise<TraceDetail> {
  const pid = parseProjectId(projectIdRaw);
  assertInContext(ctx, pid);
  const parsedTrace = traceIdSchema.safeParse(traceIdRaw);
  if (!parsedTrace.success) throw new NotFoundError();
  const traceId = parsedTrace.data;
  const cap = Math.min(Math.max(Math.floor(opts.spanCap ?? TRACE_DETAIL_LIMITS.maxSpans) || 1, 1), TRACE_DETAIL_LIMITS.maxSpans);
  const window = traceDetailWindow(opts.nowMs ?? Date.now());

  const [proj, raw] = await withTenant(ctx, (t) => [
    projectSelect(t, ctx, pid),
    spansSelect(t, { pid, traceId, fromIso: new Date(window.fromMs).toISOString(), toIso: new Date(window.toMs).toISOString(), limit: cap + 1 }),
  ]);
  if (!proj?.[0]) throw new NotFoundError();
  const rows = raw ?? [];
  if (rows.length === 0) throw new NotFoundError();

  const truncated = rows.length > cap;
  return { traceId, spans: (truncated ? rows.slice(0, cap) : rows).map(toSpan), truncated, window };
}
