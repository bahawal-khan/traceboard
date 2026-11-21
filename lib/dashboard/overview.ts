import { LATENCY_BUCKETS } from "@/lib/ingest/rollup";
import { percentileFromBuckets } from "./percentile";
import type { BucketPoint, ModelRow, OverviewData, OverviewRange, RollupRow } from "./types";

const HOUR_MS = 3_600_000;

/** Window per range. Both use hourly buckets (the hourly rollup lives 90 days, the minute rollup only 48 h). */
export const RANGE_SPEC: Record<OverviewRange, { buckets: number; bucketMs: number }> = {
  "24h": { buckets: 24, bucketMs: HOUR_MS },
  "7d": { buckets: 7 * 24, bucketMs: HOUR_MS },
};

/**
 * The window of a range: `buckets` whole buckets ending with the one that contains `nowMs`. The database reader fetches
 * exactly [from, to) and `buildOverview` lays out exactly these buckets, so the two cannot disagree.
 */
export function overviewWindow(range: OverviewRange, nowMs: number): { from: number; to: number; buckets: number; bucketMs: number } {
  const { buckets, bucketMs } = RANGE_SPEC[range];
  const newest = Math.floor(nowMs / bucketMs) * bucketMs;
  return { from: newest - (buckets - 1) * bucketMs, to: newest + bucketMs, buckets, bucketMs };
}

export interface BuildOverviewInput {
  range: OverviewRange;
  /** "Now" in epoch ms. The newest bucket is the one containing it (a partial hour). */
  nowMs: number;
  /** Rows already summed over `shard`. Rows outside the window are ignored. */
  rows: readonly RollupRow[];
  /** Models that have a price. Any other NAMED model is unpriced. */
  pricedModels: ReadonlySet<string>;
  eventsToday: number;
  eventsLimit: number;
  /** The reader hit its row cap: totals are partial (see OverviewData.truncated). Default false. */
  truncated?: boolean;
}

const emptyLat = () => new Array<number>(LATENCY_BUCKETS).fill(0);

/**
 * Pure: rollup rows in, view model out. Every bucket of the window exists (zero-filled), so charts keep a continuous
 * axis, but latency percentiles are null where there was no latency data (a gap, not a zero).
 *
 * COST RULE: the rollups only hold the cost of PRICED models. A call on an unpriced model adds nothing to cost, so the
 * total is a lower bound whenever `unpricedCalls > 0`, and the per-model cost of an unpriced model is null (unknown),
 * never 0.
 */
export function buildOverview(input: BuildOverviewInput): OverviewData {
  const { from, to, buckets, bucketMs } = overviewWindow(input.range, input.nowMs);

  const points = new Map<number, BucketPoint & { lat: number[] }>();
  for (let i = 0; i < buckets; i++) {
    const t = from + i * bucketMs;
    points.set(t, {
      t, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costMicro: 0,
      unpricedCalls: 0, costLowerBound: false, p50: null, p95: null, lat: emptyLat(),
    });
  }

  const byModel = new Map<string, { calls: number; inputTokens: number; outputTokens: number; costMicro: number }>();
  const totalLat = emptyLat();

  for (const r of input.rows) {
    const p = points.get(Math.floor(r.bucket / bucketMs) * bucketMs);
    if (!p || r.bucket < from || r.bucket >= to) continue;
    p.calls += r.calls;
    p.errors += r.errors;
    p.inputTokens += r.inputTokens;
    p.outputTokens += r.outputTokens;
    p.costMicro += r.costMicro;
    if (r.model !== "" && !input.pricedModels.has(r.model) && r.calls > 0) {
      // Rollups hold 0 for an unpriced model, which looks exactly like a free one: flag the bucket instead.
      p.unpricedCalls += r.calls;
      p.costLowerBound = true;
    }
    for (let k = 0; k < LATENCY_BUCKETS; k++) {
      p.lat[k]! += r.lat[k] ?? 0;
      totalLat[k]! += r.lat[k] ?? 0;
    }
    const m = byModel.get(r.model) ?? { calls: 0, inputTokens: 0, outputTokens: 0, costMicro: 0 };
    m.calls += r.calls;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.costMicro += r.costMicro;
    byModel.set(r.model, m);
  }

  const series: BucketPoint[] = [];
  const totals = { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costMicro: 0, p50: null as number | null, p95: null as number | null };
  for (const p of points.values()) {
    const { lat, ...rest } = p;
    series.push({ ...rest, p50: percentileFromBuckets(lat, 0.5), p95: percentileFromBuckets(lat, 0.95) });
    totals.calls += p.calls;
    totals.errors += p.errors;
    totals.inputTokens += p.inputTokens;
    totals.outputTokens += p.outputTokens;
    totals.costMicro += p.costMicro;
  }
  totals.p50 = percentileFromBuckets(totalLat, 0.5);
  totals.p95 = percentileFromBuckets(totalLat, 0.95);

  const models: ModelRow[] = [];
  let unpricedCalls = 0;
  const unpricedModels: string[] = [];
  for (const [model, m] of byModel) {
    const named = model !== "";
    const priced = !named || input.pricedModels.has(model);
    if (named && !priced) {
      unpricedCalls += m.calls;
      unpricedModels.push(model);
    }
    models.push({
      model: named ? model : null,
      calls: m.calls,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      // Unknown, not zero: an unpriced model's cost cannot be derived from the rollups.
      costMicro: priced ? m.costMicro : null,
      priced,
    });
  }
  // Most used first; the "no model" row last; stable by name.
  models.sort((a, b) => (a.model === null ? 1 : 0) - (b.model === null ? 1 : 0) || b.calls - a.calls || (String(a.model) < String(b.model) ? -1 : 1));
  unpricedModels.sort();

  return {
    range: input.range,
    from,
    to,
    bucketMs,
    series,
    totals,
    models,
    unpricedCalls,
    unpricedModels,
    quota: { eventsToday: input.eventsToday, eventsLimit: input.eventsLimit },
    truncated: input.truncated ?? false,
  };
}
