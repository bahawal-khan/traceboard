import { describe, expect, it } from "vitest";
import { buildOverview, RANGE_SPEC } from "@/lib/dashboard/overview";
import { percentileFromBuckets } from "@/lib/dashboard/percentile";
import type { RollupRow } from "@/lib/dashboard/types";
import { getDemoOverview, getDemoSnapshot } from "@/lib/demo";
import { LATENCY_BOUNDS_MS } from "@/lib/ingest/rollup";

const HOUR = 3_600_000;
const lat = (...pairs: Array<[number, number]>) => {
  const a = new Array<number>(12).fill(0);
  for (const [i, n] of pairs) a[i] = n;
  return a;
};
const row = (over: Partial<RollupRow>): RollupRow => ({
  bucket: 0, model: "m", calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costMicro: 0, latSumMs: 0, lat: lat(), ...over,
});

describe("percentileFromBuckets", () => {
  it("is null without data", () => {
    expect(percentileFromBuckets(lat(), 0.5)).toBeNull();
  });
  it("lands inside the bucket that holds the rank and interpolates linearly", () => {
    // 100 calls, all in b2 = [100, 200) ms
    const b = lat([2, 100]);
    expect(percentileFromBuckets(b, 0.5)).toBe(150);
    expect(percentileFromBuckets(b, 0)).toBe(100);
    expect(percentileFromBuckets(b, 1)).toBe(200);
  });
  it("walks across buckets", () => {
    // 50 in b0 [0,50), 50 in b3 [200,400): the median sits at the edge, p75 is mid-b3
    const b = lat([0, 50], [3, 50]);
    expect(percentileFromBuckets(b, 0.25)).toBe(25);
    expect(percentileFromBuckets(b, 0.75)).toBe(300);
  });
  it("reports the lower edge for the open-ended last bucket", () => {
    expect(percentileFromBuckets(lat([11, 5]), 0.95)).toBe(LATENCY_BOUNDS_MS[10]);
  });
  it("is monotone in q", () => {
    const b = lat([1, 7], [4, 30], [6, 12], [9, 3]);
    let prev = -1;
    for (let q = 0; q <= 1; q += 0.05) {
      const v = percentileFromBuckets(b, q)!;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  it("rejects a wrong bucket count or q out of range", () => {
    expect(() => percentileFromBuckets([1, 2, 3], 0.5)).toThrow();
    expect(() => percentileFromBuckets(lat(), 1.5)).toThrow();
  });
});

describe("buildOverview", () => {
  const now = Date.UTC(2026, 10, 21, 12, 30, 0);
  const newest = Date.UTC(2026, 10, 21, 12, 0, 0);
  const base = { range: "24h" as const, nowMs: now, pricedModels: new Set(["priced"]), eventsToday: 5, eventsLimit: 1900 };

  it("always returns every bucket of the window, zero-filled, with null percentiles where there is no latency", () => {
    const o = buildOverview({ ...base, rows: [] });
    expect(o.series).toHaveLength(RANGE_SPEC["24h"].buckets);
    expect(o.series[o.series.length - 1]!.t).toBe(newest);
    expect(o.series[0]!.t).toBe(newest - 23 * HOUR);
    expect(o.series.every((p) => p.calls === 0 && p.costMicro === 0 && p.p50 === null && p.p95 === null)).toBe(true);
    expect(o.totals.p50).toBeNull();
    expect(o.models).toEqual([]);
  });
  it("sums rows that fall in the same bucket (the reader may return several: one per model, shards already summed)", () => {
    const o = buildOverview({
      ...base,
      rows: [
        row({ bucket: newest, model: "priced", calls: 3, errors: 1, inputTokens: 10, outputTokens: 5, costMicro: 700, lat: lat([2, 3]) }),
        row({ bucket: newest, model: "", calls: 2, lat: lat([0, 2]) }),
      ],
    });
    const p = o.series[o.series.length - 1]!;
    expect([p.calls, p.errors, p.inputTokens, p.outputTokens, p.costMicro]).toEqual([5, 1, 10, 5, 700]);
    expect(o.totals.calls).toBe(5);
  });
  it("ignores rows outside the window", () => {
    const o = buildOverview({ ...base, rows: [row({ bucket: newest - 24 * HOUR, calls: 9 }), row({ bucket: newest + HOUR, calls: 9 })] });
    expect(o.totals.calls).toBe(0);
  });
  it("COST: an unpriced model has null cost, is listed, and makes the total a flagged lower bound", () => {
    const o = buildOverview({
      ...base,
      rows: [
        row({ bucket: newest, model: "priced", calls: 4, costMicro: 1_000 }),
        row({ bucket: newest, model: "mystery-7b", calls: 6, costMicro: 0 }), // what the ingest statement stores for it
      ],
    });
    const mystery = o.models.find((m) => m.model === "mystery-7b")!;
    expect(mystery.costMicro).toBeNull(); // not 0
    expect(mystery.priced).toBe(false);
    expect(o.models.find((m) => m.model === "priced")!.costMicro).toBe(1_000);
    expect(o.unpricedCalls).toBe(6);
    expect(o.unpricedModels).toEqual(["mystery-7b"]);
    expect(o.totals.costMicro).toBe(1_000);
  });
  it("a priced model with a genuine zero cost stays 0, distinct from unknown", () => {
    const o = buildOverview({ ...base, rows: [row({ bucket: newest, model: "priced", calls: 1, costMicro: 0 })] });
    expect(o.models[0]!.costMicro).toBe(0);
    expect(o.unpricedCalls).toBe(0);
  });
  it("events without a model are a 'no model' row, never counted as unpriced, listed last", () => {
    const o = buildOverview({
      ...base,
      rows: [row({ bucket: newest, model: "", calls: 100 }), row({ bucket: newest, model: "priced", calls: 1 })],
    });
    expect(o.models.map((m) => m.model)).toEqual(["priced", null]);
    expect(o.models[1]!.priced).toBe(true);
    expect(o.unpricedCalls).toBe(0);
  });
  it("passes the quota through", () => {
    expect(buildOverview({ ...base, rows: [] }).quota).toEqual({ eventsToday: 5, eventsLimit: 1900 });
  });
});

describe("demo overview (built from the committed snapshot)", () => {
  it("24h and 7d windows are full, and 24h is the tail of 7d", () => {
    const d24 = getDemoOverview("24h");
    const d7 = getDemoOverview("7d");
    expect(d24.series).toHaveLength(24);
    expect(d7.series).toHaveLength(168);
    expect(d7.totals.calls).toBeGreaterThan(d24.totals.calls);
    expect(d7.series.slice(-24)).toEqual(d24.series);
  });
  it("totals equal the snapshot's rollups for the window", () => {
    const s = getDemoSnapshot();
    const d7 = getDemoOverview("7d");
    expect(d7.totals.calls).toBe(s.rollups.filter((r) => r.bucket >= d7.from && r.bucket < d7.to).reduce((a, r) => a + r.calls, 0));
  });
  it("shows the unknown-cost model as unknown, with a lower-bound cost", () => {
    const d = getDemoOverview("7d");
    expect(d.unpricedModels).toEqual(["acme-local-7b"]);
    expect(d.unpricedCalls).toBeGreaterThan(0);
    expect(d.models.find((m) => m.model === "acme-local-7b")!.costMicro).toBeNull();
    expect(d.totals.costMicro).toBeGreaterThan(0);
  });
  it("has plausible approximate latency percentiles (p50 <= p95)", () => {
    const d = getDemoOverview("24h");
    expect(d.totals.p50).not.toBeNull();
    expect(d.totals.p50!).toBeLessThanOrEqual(d.totals.p95!);
  });
});
