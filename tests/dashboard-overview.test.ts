import { describe, expect, it } from "vitest";
import { buildOverview, overviewWindow, RANGE_SPEC } from "@/lib/dashboard/overview";
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
  it("flags EACH bucket that holds unpriced events as a cost lower bound, and only those", () => {
    const o = buildOverview({
      ...base,
      rows: [
        row({ bucket: newest, model: "priced", calls: 4, costMicro: 1_000 }),
        row({ bucket: newest, model: "mystery-7b", calls: 6 }),
        row({ bucket: newest - HOUR, model: "priced", calls: 2, costMicro: 300 }),
        row({ bucket: newest - 2 * HOUR, model: "", calls: 9 }), // spans without a model are not "unpriced"
        row({ bucket: newest - 3 * HOUR, model: "mystery-7b", calls: 0 }), // no calls, nothing to flag
      ],
    });
    const at = (i: number) => o.series[o.series.length - 1 - i]!;
    expect([at(0).costLowerBound, at(0).unpricedCalls]).toEqual([true, 6]);
    expect([at(1).costLowerBound, at(1).unpricedCalls]).toEqual([false, 0]);
    expect([at(2).costLowerBound, at(2).unpricedCalls]).toEqual([false, 0]);
    expect([at(3).costLowerBound, at(3).unpricedCalls]).toEqual([false, 0]);
    expect(o.series.filter((p) => p.costLowerBound)).toHaveLength(1);
    expect(at(0).costMicro).toBe(1_000); // the flagged bucket keeps its known cost; it does not become null or zero
  });
  it("a bucket's flagged calls add up to the overview's unpricedCalls", () => {
    const o = buildOverview({
      ...base,
      rows: [row({ bucket: newest, model: "x-1", calls: 3 }), row({ bucket: newest - HOUR, model: "x-1", calls: 4 }), row({ bucket: newest - HOUR, model: "x-2", calls: 5 })],
    });
    expect(o.series.reduce((s, p) => s + p.unpricedCalls, 0)).toBe(o.unpricedCalls);
    expect(o.unpricedCalls).toBe(12);
  });
  it("passes the truncated flag through, false by default", () => {
    expect(buildOverview({ ...base, rows: [] }).truncated).toBe(false);
    expect(buildOverview({ ...base, rows: [], truncated: true }).truncated).toBe(true);
  });
  it("overviewWindow is the window buildOverview lays out", () => {
    for (const range of ["24h", "7d"] as const) {
      const w = overviewWindow(range, now);
      const o = buildOverview({ ...base, range, rows: [] });
      expect([o.from, o.to, o.series.length]).toEqual([w.from, w.to, w.buckets]);
      expect(w.to - w.from).toBe(w.buckets * w.bucketMs);
    }
  });
});

describe("buildOverview does not depend on the order of the rows", () => {
  const now = Date.UTC(2026, 10, 21, 12, 30, 0);
  const newest = Date.UTC(2026, 10, 21, 12, 0, 0);
  const rows = [
    row({ bucket: newest, model: "priced", calls: 4, errors: 1, inputTokens: 40, outputTokens: 9, costMicro: 1_000, latSumMs: 800, lat: lat([2, 3], [4, 1]) }),
    row({ bucket: newest, model: "mystery-7b", calls: 6, inputTokens: 5, lat: lat([6, 6]) }),
    row({ bucket: newest, model: "", calls: 3, lat: lat([0, 3]) }),
    row({ bucket: newest - HOUR, model: "priced", calls: 2, costMicro: 300, lat: lat([2, 2]) }),
    row({ bucket: newest - HOUR, model: "other", calls: 2, costMicro: 5, lat: lat([3, 2]) }),
    row({ bucket: newest - 5 * HOUR, model: "mystery-7b", calls: 1, lat: lat([11, 1]) }),
    row({ bucket: newest - 5 * HOUR, model: "priced", calls: 2, costMicro: 50, lat: lat([1, 2]) }),
  ];
  const run = (r: RollupRow[]) => buildOverview({ range: "24h", nowMs: now, rows: r, pricedModels: new Set(["priced", "other"]), eventsToday: 7, eventsLimit: 1900 });
  const expected = run(rows);

  // deterministic Fisher-Yates with a tiny LCG: no Math.random in tests
  const shuffled = (seed: number) => {
    const a = [...rows];
    let s = seed;
    for (let i = a.length - 1; i > 0; i--) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const j = s % (i + 1);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };

  it("gives a deep-equal overview for the reversed rows, every rotation and 40 shuffles", () => {
    expect(run([...rows].reverse())).toEqual(expected);
    for (let k = 1; k < rows.length; k++) expect(run([...rows.slice(k), ...rows.slice(0, k)])).toEqual(expected);
    for (let seed = 1; seed <= 40; seed++) expect(run(shuffled(seed))).toEqual(expected);
  });
  it("the derived lists are explicitly ordered: models by calls then name, 'no model' last, unpriced names sorted", () => {
    // calls: priced 4+2+2 = 8, mystery-7b 6+1 = 7, other 2; the 3 spans without a model are the last row whatever their count
    expect(expected.models.map((m) => m.model)).toEqual(["priced", "mystery-7b", "other", null]);
    expect(expected.unpricedModels).toEqual(["mystery-7b"]);
    expect(expected.series.map((p) => p.t)).toEqual([...expected.series.map((p) => p.t)].sort((a, b) => a - b)); // buckets ascend
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
