import { buildOverview, overviewWindow } from "@/lib/dashboard/overview";
import { overviewRangeSchema, rollupRowSchema, type OverviewData, type OverviewRange, type RollupRow } from "@/lib/dashboard/types";
import { PriceBook } from "@/lib/ingest/cost";
import { QUOTAS, RETENTION } from "@/lib/quotas";
import { projectId } from "@/lib/validation/projects";
import { NotFoundError } from "./errors";
import { loadModelPrices } from "./prices";
import { withTenant, type SessionCtx, type Tx } from "./tenant";

/**
 * Dashboard metrics reader: the ONLY place that reads `metrics_hourly` and `metrics_minute` for the UI.
 *
 * - Every statement goes through withTenant (RLS: `project_id = any(app.project_ids)`), and the project is checked in the
 *   SAME transaction. A project that is not yours, does not exist, was deleted, or whose id is not a UUID all end in the
 *   SAME NotFoundError, so nothing tells them apart (no existence oracle).
 * - Rows are summed over `shard` (minute rollups are written to 8 shards; older hourly rows may carry shards 1-7) and
 *   grouped by (bucket, model). Two statements, both static templates with bound parameters.
 * - Windows and row counts are clamped HERE, not trusted from the caller.
 * - Cost: the rollups hold 0 for an unpriced model, which looks like a free one. The reader reports which models have a
 *   price (the ingest lookup rule, via PriceBook.hasPrice) and buildOverview flags the buckets and totals as lower bounds.
 */

export const METRICS_LIMITS = {
  /** Nothing in the UI reads more than 7 days, whatever the caller asks for. */
  maxWindowMs: 7 * 24 * 3_600_000,
  hourlyBucketMs: 3_600_000,
  minuteBucketMs: 60_000,
  /** Minute rollups are only kept this long (the daily job deletes older rows). */
  minuteMaxWindowMs: RETENTION.minuteRollupsHours * 3_600_000,
  /**
   * Rows returned per statement. A window has at most 168 hourly buckets x (distinct models), so this is only reached by
   * an absurd number of distinct model names; the reader then flags `truncated` instead of silently dropping data.
   */
  maxRows: 5_000,
} as const;

export interface MetricsWindow {
  fromMs: number;
  toMs: number;
}

export interface ClampedWindow extends MetricsWindow {
  /** True when the requested window was changed (shortened, moved, or aligned to bucket boundaries by more than a no-op). */
  clamped: boolean;
}

/**
 * Pure. Aligns to whole buckets, refuses the future beyond the bucket that contains "now", and shortens a too-long window
 * by dropping its OLDEST part (the newest data matters most). An inverted or empty window becomes an empty one.
 * Throws RangeError for non-finite input; callers validate before this, so reaching it is a bug, not user input.
 */
export function clampWindow(win: MetricsWindow, o: { bucketMs: number; maxWindowMs: number; nowMs: number }): ClampedWindow {
  const { fromMs, toMs } = win;
  if (![fromMs, toMs, o.bucketMs, o.maxWindowMs, o.nowMs].every(Number.isFinite) || o.bucketMs <= 0 || o.maxWindowMs <= 0) {
    throw new RangeError("invalid metrics window");
  }
  const newestEnd = (Math.floor(o.nowMs / o.bucketMs) + 1) * o.bucketMs; // end of the current bucket
  let to = Math.min(Math.ceil(toMs / o.bucketMs) * o.bucketMs, newestEnd);
  let from = Math.floor(Math.max(fromMs, 0) / o.bucketMs) * o.bucketMs;
  from = Math.max(from, to - o.maxWindowMs);
  if (from >= to) {
    from = to;
    to = from;
  }
  return { fromMs: from, toMs: to, clamped: from !== fromMs || to !== toMs };
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---- the two statements (static templates; the bucket count and the row cap are bound parameters) ----
// Both read the SAME columns and differ only in the table. tests/metrics-repo.test.ts proves they stay identical.

function hourlySelect(t: Tx, pid: string, fromIso: string, toIso: string, limit: number) {
  return t`select (extract(epoch from bucket) * 1000)::bigint::text as bucket_ms, model,
      sum(calls)::text as calls, sum(errors)::text as errors,
      sum(input_tokens)::text as input_tokens, sum(output_tokens)::text as output_tokens,
      sum(cost_micro)::text as cost_micro, sum(lat_sum_ms)::text as lat_sum_ms,
      sum(lat_b0)::text as lat_b0, sum(lat_b1)::text as lat_b1, sum(lat_b2)::text as lat_b2, sum(lat_b3)::text as lat_b3,
      sum(lat_b4)::text as lat_b4, sum(lat_b5)::text as lat_b5, sum(lat_b6)::text as lat_b6, sum(lat_b7)::text as lat_b7,
      sum(lat_b8)::text as lat_b8, sum(lat_b9)::text as lat_b9, sum(lat_b10)::text as lat_b10, sum(lat_b11)::text as lat_b11
    from metrics_hourly
   where project_id = ${pid}::uuid and bucket >= ${fromIso}::timestamptz and bucket < ${toIso}::timestamptz
   group by bucket, model
   order by bucket desc, model
   limit ${limit}::int`;
}

function minuteSelect(t: Tx, pid: string, fromIso: string, toIso: string, limit: number) {
  return t`select (extract(epoch from bucket) * 1000)::bigint::text as bucket_ms, model,
      sum(calls)::text as calls, sum(errors)::text as errors,
      sum(input_tokens)::text as input_tokens, sum(output_tokens)::text as output_tokens,
      sum(cost_micro)::text as cost_micro, sum(lat_sum_ms)::text as lat_sum_ms,
      sum(lat_b0)::text as lat_b0, sum(lat_b1)::text as lat_b1, sum(lat_b2)::text as lat_b2, sum(lat_b3)::text as lat_b3,
      sum(lat_b4)::text as lat_b4, sum(lat_b5)::text as lat_b5, sum(lat_b6)::text as lat_b6, sum(lat_b7)::text as lat_b7,
      sum(lat_b8)::text as lat_b8, sum(lat_b9)::text as lat_b9, sum(lat_b10)::text as lat_b10, sum(lat_b11)::text as lat_b11
    from metrics_minute
   where project_id = ${pid}::uuid and bucket >= ${fromIso}::timestamptz and bucket < ${toIso}::timestamptz
   group by bucket, model
   order by bucket desc, model
   limit ${limit}::int`;
}

/** The project row, visible only to its owner (RLS plus the explicit owner filter, like getProject). */
function projectSelect(t: Tx, ctx: SessionCtx, pid: string) {
  return t`select id from projects where id = ${pid}::uuid and owner_id = ${ctx.ownerId}`;
}

const LAT_KEYS = ["lat_b0", "lat_b1", "lat_b2", "lat_b3", "lat_b4", "lat_b5", "lat_b6", "lat_b7", "lat_b8", "lat_b9", "lat_b10", "lat_b11"] as const;

/**
 * Driver rows (bigints and sums arrive as strings) -> RollupRow. Parsed with the strict schema, so a surprise from the
 * driver or the database fails loudly here instead of drawing a wrong chart.
 */
function toRollupRow(r: Record<string, unknown>): RollupRow {
  return rollupRowSchema.parse({
    bucket: Number(r.bucket_ms),
    model: String(r.model),
    calls: Number(r.calls),
    errors: Number(r.errors),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costMicro: Number(r.cost_micro),
    latSumMs: Number(r.lat_sum_ms),
    lat: LAT_KEYS.map((k) => Number(r[k])),
  });
}

/**
 * The order every reader returns: oldest bucket first and, inside a bucket, model ascending by plain UTF-16 code-unit
 * comparison (the `<` operator). NOT localeCompare and NOT the database collation, so the result is the same on every
 * server and database. Rows are unique per (bucket, model), so the order is total.
 */
export function compareRollupRows(a: Pick<RollupRow, "bucket" | "model">, b: Pick<RollupRow, "bucket" | "model">): number {
  if (a.bucket !== b.bucket) return a.bucket < b.bucket ? -1 : 1;
  if (a.model === b.model) return 0;
  return a.model < b.model ? -1 : 1;
}

/**
 * The statements return rows `bucket desc, model` so that the row cap (LIMIT) keeps the NEWEST buckets and drops the
 * oldest. One extra row is requested to detect the cap: the cap drops the LAST rows of that database order. Reversing
 * the array would also reverse the models inside each bucket, so the kept rows are sorted explicitly instead; the
 * result does not depend on the order the database returned them in.
 */
function finishRows(raw: readonly Record<string, unknown>[]): { rows: RollupRow[]; truncated: boolean } {
  const truncated = raw.length > METRICS_LIMITS.maxRows;
  const kept = truncated ? raw.slice(0, METRICS_LIMITS.maxRows) : raw;
  return { rows: kept.map(toRollupRow).sort(compareRollupRows), truncated };
}

/** A malformed id is "not found", exactly like a missing or foreign one. */
function parseProjectId(id: string): string {
  const parsed = projectId.safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}

/** Cheap pre-check, no database: a project outside the context's own list can never be read. Same error as a missing one. */
function assertInContext(ctx: SessionCtx, pid: string): void {
  if (!ctx.projectIds.includes(pid)) throw new NotFoundError();
}

export interface RollupRead {
  rows: RollupRow[];
  /** The row cap was hit: older buckets may be missing. */
  truncated: boolean;
  window: ClampedWindow;
}

async function readRollups(
  ctx: SessionCtx,
  rawProjectId: string,
  win: MetricsWindow,
  granularity: "hour" | "minute",
  nowMs: number,
): Promise<RollupRead> {
  const pid = parseProjectId(rawProjectId);
  assertInContext(ctx, pid);
  const window = clampWindow(win, {
    bucketMs: granularity === "hour" ? METRICS_LIMITS.hourlyBucketMs : METRICS_LIMITS.minuteBucketMs,
    maxWindowMs: granularity === "hour" ? METRICS_LIMITS.maxWindowMs : METRICS_LIMITS.minuteMaxWindowMs,
    nowMs,
  });
  const select = granularity === "hour" ? hourlySelect : minuteSelect;
  const [proj, raw] = await withTenant(ctx, (t) => [
    projectSelect(t, ctx, pid),
    select(t, pid, iso(window.fromMs), iso(window.toMs), METRICS_LIMITS.maxRows + 1),
  ]);
  if (!proj[0]) throw new NotFoundError();
  return { ...finishRows(raw), window };
}

/** Hourly rollups of one of the caller's projects, summed over shards. Window clamped to 7 days. */
export function readHourlyRollups(ctx: SessionCtx, projectIdRaw: string, win: MetricsWindow, nowMs: number = Date.now()): Promise<RollupRead> {
  return readRollups(ctx, projectIdRaw, win, "hour", nowMs);
}

/** Minute rollups (for the live view), summed over the 8 shards. Window clamped to the 48 h they are kept. */
export function readMinuteRollups(ctx: SessionCtx, projectIdRaw: string, win: MetricsWindow, nowMs: number = Date.now()): Promise<RollupRead> {
  return readRollups(ctx, projectIdRaw, win, "minute", nowMs);
}

let sharedPrices: PriceBook | undefined;
/** One price list per server instance (the ingest path has its own; both refresh every 10 minutes). */
function defaultPrices(): PriceBook {
  sharedPrices ??= new PriceBook(loadModelPrices);
  return sharedPrices;
}

export interface ReadOverviewOptions {
  /** Test hook. Defaults to the current time. */
  nowMs?: number;
  /** Test hook. Defaults to the instance's price list. */
  prices?: PriceBook;
}

/**
 * Everything the Overview needs for one project and range, in ONE database round trip: the project check, the hourly
 * rollups (summed over shards) and today's event count, then `buildOverview`, the same function the demo uses.
 *
 * Throws NotFoundError for a project that is not the caller's, does not exist, or is not a UUID: all indistinguishable.
 */
export async function readOverview(ctx: SessionCtx, projectIdRaw: string, range: OverviewRange, opts: ReadOverviewOptions = {}): Promise<OverviewData> {
  const pid = parseProjectId(projectIdRaw);
  assertInContext(ctx, pid);
  const safeRange = overviewRangeSchema.parse(range);
  const nowMs = opts.nowMs ?? Date.now();
  const w = overviewWindow(safeRange, nowMs);
  const window = clampWindow({ fromMs: w.from, toMs: w.to }, { bucketMs: w.bucketMs, maxWindowMs: METRICS_LIMITS.maxWindowMs, nowMs });
  const prices = opts.prices ?? defaultPrices();

  const day = new Date(nowMs).toISOString().slice(0, 10); // UTC day, the key of usage_daily
  // The price list is cached per instance, so this normally costs nothing; when stale it refreshes in parallel.
  const [results] = await Promise.all([
    withTenant(ctx, (t) => [
      projectSelect(t, ctx, pid),
      hourlySelect(t, pid, iso(window.fromMs), iso(window.toMs), METRICS_LIMITS.maxRows + 1),
      t`select events::text as events from usage_daily where project_id = ${pid}::uuid and day = ${day}::date`,
    ]),
    prices.ready(),
  ]);
  const [proj, raw, usage] = results;
  if (!proj?.[0]) throw new NotFoundError();

  const { rows, truncated } = finishRows(raw ?? []);
  const pricedModels = new Set<string>();
  for (const r of rows) if (r.model !== "" && prices.hasPrice(r.model)) pricedModels.add(r.model);

  return buildOverview({
    range: safeRange,
    nowMs,
    rows,
    pricedModels,
    eventsToday: usage && usage[0] ? Number(usage[0].events) : 0,
    eventsLimit: QUOTAS.eventsPerDayPerProject,
    truncated,
  });
}
