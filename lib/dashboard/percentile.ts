import { LATENCY_BOUNDS_MS, LATENCY_BUCKETS } from "@/lib/ingest/rollup";

/**
 * Approximate percentile from the 12 log-spaced latency buckets (b0 < 50 ms ... b11 >= 51,200 ms).
 * The value is interpolated linearly inside the bucket that holds the rank, so it is only as good as the bucket width:
 * always label it "approx" in the UI. The last bucket is open-ended, so a rank that lands there reports its lower edge.
 * Returns null when there is no latency data (events without latency are in no bucket).
 */
export function percentileFromBuckets(buckets: readonly number[], q: number): number | null {
  if (buckets.length !== LATENCY_BUCKETS) throw new Error("expected 12 latency buckets");
  if (!(q >= 0 && q <= 1)) throw new Error("q must be in [0, 1]");
  let total = 0;
  for (const n of buckets) total += n;
  if (total <= 0) return null;

  const rank = q * total;
  let before = 0;
  for (let k = 0; k < LATENCY_BUCKETS; k++) {
    const n = buckets[k] ?? 0;
    if (n <= 0) continue;
    if (rank <= before + n) {
      const lo = k === 0 ? 0 : LATENCY_BOUNDS_MS[k - 1]!;
      if (k === LATENCY_BUCKETS - 1) return lo; // open-ended bucket
      const hi = LATENCY_BOUNDS_MS[k]!;
      return Math.round(lo + ((rank - before) / n) * (hi - lo));
    }
    before += n;
  }
  return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1]!; // unreachable; keeps the type total
}
