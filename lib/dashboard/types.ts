import { z } from "zod";
import { LATENCY_BUCKETS } from "@/lib/ingest/rollup";

/**
 * View-model contract for the dashboard. Two sources fill it: the database readers (lib/repo, P3.3+) and the static demo
 * snapshot (lib/demo). Both go through the SAME pure builders, so the demo cannot drift from what real data looks like.
 *
 * Privacy: nothing here can carry prompt or completion text. Schemas are strict, so an unknown key (for example
 * `input_text`) fails validation instead of passing through.
 *
 * Money: integer micro-USD. `null` means UNKNOWN (no price for the model) and must never be shown as 0.
 */

export const OVERVIEW_RANGES = ["24h", "7d"] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];
export const overviewRangeSchema = z.enum(OVERVIEW_RANGES);

const count = z.number().int().nonnegative();

/**
 * One rollup row exactly as the readers return it: `metrics_hourly` / `metrics_minute` summed over `shard`.
 * `bucket` is the bucket start in epoch milliseconds. `model` is '' for events without a model (agent, tool spans).
 * `costMicro` already excludes unpriced models (the ingest statement adds nothing for them).
 */
export const rollupRowSchema = z.strictObject({
  bucket: z.number().int().nonnegative(),
  model: z.string().max(200),
  calls: count,
  errors: count,
  inputTokens: count,
  outputTokens: count,
  costMicro: count,
  latSumMs: z.number().nonnegative(),
  lat: z.array(count).length(LATENCY_BUCKETS),
});
export type RollupRow = z.infer<typeof rollupRowSchema>;

export interface BucketPoint {
  /** Bucket start, epoch ms. */
  t: number;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costMicro: number;
  /** Approximate (from the latency histogram); null when the bucket has no latency data. */
  p50: number | null;
  p95: number | null;
}

export interface ModelRow {
  /** null = events without a model (agent, tool, retrieval spans). */
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** null = unknown: the model has no price, so its cost is NOT included anywhere. */
  costMicro: number | null;
  priced: boolean;
}

export interface OverviewData {
  range: OverviewRange;
  /** Window start (first bucket) and end (exclusive), epoch ms. */
  from: number;
  to: number;
  bucketMs: number;
  series: BucketPoint[];
  totals: {
    calls: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    /** Sum over priced models only. See `unpricedCalls`. */
    costMicro: number;
    p50: number | null;
    p95: number | null;
  };
  models: ModelRow[];
  /** Calls on named models without a price. When > 0 the cost total is incomplete and the UI must say so. */
  unpricedCalls: number;
  unpricedModels: string[];
  quota: { eventsToday: number; eventsLimit: number };
}

// ---- traces (used from P3.5; part of the snapshot now so the demo contains an orphan, a loop and an unpriced call) ----

export const spanKindSchema = z.enum(["agent", "llm", "retrieval", "tool", "custom"]);

export const spanRowSchema = z.strictObject({
  spanId: z.string().min(1).max(64),
  /** May point at a span that is NOT in this trace (the OTLP filter can drop a parent that arrives later). */
  parentId: z.string().min(1).max(64).nullable(),
  kind: spanKindSchema,
  name: z.string().max(200),
  model: z.string().max(200).nullable(),
  /** Start relative to the trace start. */
  offsetMs: count,
  latencyMs: count.nullable(),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  cachedTokens: count.nullable(),
  /** null = unknown price (or not an LLM call). Never 0 for "unknown". */
  costMicro: count.nullable(),
  status: z.enum(["ok", "error"]),
  /** Already redacted, at most 500 characters. */
  error: z.string().max(500).nullable(),
  /** Hash of the tool arguments (never the arguments). Equal hashes in one trace are what Guard's loop check counts. */
  argsHash: z.string().max(64).nullable(),
});
export type SpanRow = z.infer<typeof spanRowSchema>;

export const traceSummarySchema = z.strictObject({
  traceId: z.string().min(1).max(64),
  name: z.string().max(200),
  startedAt: z.iso.datetime(),
  durationMs: count,
  spanCount: count,
  status: z.enum(["ok", "error"]),
  inputTokens: count,
  outputTokens: count,
  /** Sum of the KNOWN span costs; null when no span has a known cost. */
  costMicro: count.nullable(),
  /** LLM spans whose model has no price. When > 0 the cost above is a lower bound. */
  unpricedSpans: count,
});
export type TraceSummary = z.infer<typeof traceSummarySchema>;

export const traceDetailSchema = z.strictObject({
  summary: traceSummarySchema,
  spans: z.array(spanRowSchema).min(1).max(1000),
});
export type TraceDetail = z.infer<typeof traceDetailSchema>;

export const demoSnapshotSchema = z.strictObject({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  /** Models that have a price in the demo price table. Everything else is unpriced. */
  pricedModels: z.array(z.string().max(200)).max(50),
  usage: z.strictObject({ eventsToday: count }),
  rollups: z.array(rollupRowSchema).max(5000),
  traces: z.array(traceDetailSchema).max(200),
});
export type DemoSnapshot = z.infer<typeof demoSnapshotSchema>;
