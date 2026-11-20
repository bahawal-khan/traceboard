/**
 * Constants shared by the write-time rollups (lib/events/pg-store.ts) and, later, the readers.
 *
 * Latency histogram: 12 log-spaced buckets b0..b11 in `metrics_minute` / `metrics_hourly`.
 * `width_bucket(latency_ms, LATENCY_BOUNDS_MS)` returns 0 for < 50 ms, k for the k-th range, and 11 for
 * >= 51,200 ms. Events without a latency are counted in `calls` but in no bucket and not in `lat_sum_ms`,
 * so bucket totals can be smaller than `calls`. p50/p95 derived from the buckets are approximate.
 */
export const LATENCY_BOUNDS_MS = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200] as const;
export const LATENCY_BUCKETS = LATENCY_BOUNDS_MS.length + 1; // 12

/**
 * Hot `(project, minute, model)` rows in `metrics_minute` are spread over this many shard rows. `metrics_hourly` is NOT
 * sharded: it is always written with shard 0 (P2.6b). The column stays, so readers must still SUM over `shard` for both
 * tables (older hourly rows may carry shards 1-7).
 */
export const ROLLUP_SHARDS = 8;

export const randomShard = (): number => Math.floor(Math.random() * ROLLUP_SHARDS);
