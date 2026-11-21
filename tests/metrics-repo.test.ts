import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/repo/metrics.ts against a mocked driver: statement shape, bound parameters, clamping, mapping, and the
 * not-found behaviour. The real database (RLS, shard sums, IDOR) is tests/db/metrics.test.ts, run by the owner.
 */
const m = vi.hoisted(() => ({
  /** One entry per statement AFTER set_config, in order: the rows that statement returns. */
  results: [] as unknown[][],
  transactions: [] as Array<Array<{ sql: string; values: unknown[] }>>,
}));

vi.mock("@/lib/db/client", () => ({
  getSql: () => ({
    transaction: (build: (t: (s: TemplateStringsArray, ...v: unknown[]) => unknown) => unknown[]) => {
      const t = (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
      const queries = build(t) as Array<{ sql: string; values: unknown[] }>;
      m.transactions.push(queries);
      return Promise.resolve([[{ set_config: "x" }], ...m.results]);
    },
  }),
}));

import { PriceBook } from "@/lib/ingest/cost";
import { METRICS_LIMITS, clampWindow, compareRollupRows, readHourlyRollups, readMinuteRollups, readOverview } from "@/lib/repo/metrics";
import { NotFoundError } from "@/lib/repo/errors";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";

const HOUR = 3_600_000;
const MIN = 60_000;
const PID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 10, 21, 12, 30, 0);
const ctx = issueCtx<SessionCtx>({ kind: "session", ownerId: "user_a", projectIds: [PID], readOnly: false });

const row = (over: Record<string, unknown> = {}) => ({
  bucket_ms: String(Date.UTC(2026, 10, 21, 12)), model: "priced-1", calls: "3", errors: "1", input_tokens: "30", output_tokens: "9",
  cost_micro: "700", lat_sum_ms: "900",
  lat_b0: "0", lat_b1: "0", lat_b2: "3", lat_b3: "0", lat_b4: "0", lat_b5: "0", lat_b6: "0", lat_b7: "0", lat_b8: "0", lat_b9: "0", lat_b10: "0", lat_b11: "0",
  ...over,
});
const projectRow = [{ id: PID }];
const prices = () =>
  new PriceBook(async () => [{ model: "priced-1", inputPer1m: "2.00", outputPer1m: "10.00", cachedInputPer1m: null }]);

beforeEach(() => {
  m.results = [];
  m.transactions = [];
});

describe("clampWindow", () => {
  const o = { bucketMs: HOUR, maxWindowMs: 7 * 24 * HOUR, nowMs: NOW };
  const newestEnd = Date.UTC(2026, 10, 21, 13);

  it("aligns to whole buckets and leaves a sane window alone", () => {
    const w = clampWindow({ fromMs: NOW - 5 * HOUR - 17, toMs: NOW }, o);
    expect(w.fromMs % HOUR).toBe(0);
    expect(w.toMs).toBe(newestEnd);
    expect(w.toMs - w.fromMs).toBeGreaterThanOrEqual(5 * HOUR);
  });
  it("shortens a window longer than 7 days by dropping the OLDEST part", () => {
    const w = clampWindow({ fromMs: NOW - 90 * 24 * HOUR, toMs: NOW }, o);
    expect(w.toMs).toBe(newestEnd);
    expect(w.toMs - w.fromMs).toBe(7 * 24 * HOUR);
    expect(w.clamped).toBe(true);
  });
  it("refuses the future beyond the bucket that holds 'now'", () => {
    const w = clampWindow({ fromMs: NOW - HOUR, toMs: NOW + 365 * 24 * HOUR }, o);
    expect(w.toMs).toBe(newestEnd);
  });
  it("makes an inverted or empty window empty, never negative", () => {
    const w = clampWindow({ fromMs: NOW, toMs: NOW - 10 * HOUR }, o);
    expect(w.toMs - w.fromMs).toBe(0);
    expect(clampWindow({ fromMs: -5 * HOUR, toMs: -1 }, o).toMs - clampWindow({ fromMs: -5 * HOUR, toMs: -1 }, o).fromMs).toBe(0);
  });
  it("is not clamped when the window already fits exactly", () => {
    const from = newestEnd - 24 * HOUR;
    expect(clampWindow({ fromMs: from, toMs: newestEnd }, o)).toEqual({ fromMs: from, toMs: newestEnd, clamped: false });
  });
  it("rejects non-finite input", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => clampWindow({ fromMs: bad, toMs: NOW }, o)).toThrow(RangeError);
      expect(() => clampWindow({ fromMs: 0, toMs: bad }, o)).toThrow(RangeError);
    }
    expect(() => clampWindow({ fromMs: 0, toMs: NOW }, { ...o, bucketMs: 0 })).toThrow(RangeError);
  });
  it("the limits are the ones the data model promises", () => {
    expect(METRICS_LIMITS.maxWindowMs).toBe(7 * 24 * HOUR);
    expect(METRICS_LIMITS.minuteMaxWindowMs).toBe(48 * HOUR);
  });
});

describe("the two statements", () => {
  it("hourly and minute read the same columns and differ only in the table", async () => {
    // Statement order in a transaction: [0] set_config (added by withTenant), [1] project check, [2] rollups, [3] usage.
    m.results = [projectRow, []];
    await readHourlyRollups(ctx, PID, { fromMs: NOW - HOUR, toMs: NOW }, NOW);
    m.results = [projectRow, []];
    await readMinuteRollups(ctx, PID, { fromMs: NOW - HOUR, toMs: NOW }, NOW);
    const hourly = m.transactions[0]![2]!.sql;
    const minute = m.transactions[1]![2]!.sql;
    expect(hourly).toContain("from metrics_hourly");
    expect(minute).toContain("from metrics_minute");
    expect(hourly.replace("metrics_hourly", "metrics_minute")).toBe(minute);
  });

  it("SUMS over shard: groups by (bucket, model) only and never mentions the shard column", async () => {
    m.results = [projectRow, []];
    await readHourlyRollups(ctx, PID, { fromMs: NOW - HOUR, toMs: NOW }, NOW);
    const sql = m.transactions[0]![2]!.sql;
    expect(sql).toContain("group by bucket, model");
    expect(sql).not.toMatch(/\bshard\b/);
    for (const col of ["calls", "errors", "input_tokens", "output_tokens", "cost_micro", "lat_sum_ms", ...Array.from({ length: 12 }, (_, i) => `lat_b${i}`)]) {
      expect(sql, col).toContain(`sum(${col})::text`);
    }
  });

  it("binds project, bounds and the row cap as parameters (no string-built SQL)", async () => {
    m.results = [projectRow, []];
    await readHourlyRollups(ctx, PID, { fromMs: NOW - 3 * HOUR, toMs: NOW }, NOW);
    const [projectQ, rollupQ] = m.transactions[0]!.slice(1) as [{ sql: string; values: unknown[] }, { sql: string; values: unknown[] }];
    expect(projectQ.values).toEqual([PID, "user_a"]);
    expect(rollupQ.values).toEqual([PID, new Date(Date.UTC(2026, 10, 21, 9)).toISOString(), new Date(Date.UTC(2026, 10, 21, 13)).toISOString(), METRICS_LIMITS.maxRows + 1]);
    expect(rollupQ.sql).not.toContain(PID);
  });

  it("ALWAYS filters by the project and requires bounded time on both sides", async () => {
    m.results = [projectRow, []];
    await readHourlyRollups(ctx, PID, { fromMs: NOW - HOUR, toMs: NOW }, NOW);
    expect(m.transactions[0]![2]!.sql).toMatch(/where project_id = \?::uuid and bucket >= \?::timestamptz and bucket < \?::timestamptz/);
    expect(m.transactions[0]![2]!.sql).toMatch(/limit \?::int$/);
  });
});

describe("readHourlyRollups / readMinuteRollups", () => {
  it("maps driver strings to numbers and returns rows oldest first", async () => {
    m.results = [
      projectRow,
      [row({ bucket_ms: String(Date.UTC(2026, 10, 21, 12)) }), row({ bucket_ms: String(Date.UTC(2026, 10, 21, 11)), model: "" })],
    ];
    const r = await readHourlyRollups(ctx, PID, { fromMs: NOW - 5 * HOUR, toMs: NOW }, NOW);
    expect(r.truncated).toBe(false);
    expect(r.rows.map((x) => x.bucket)).toEqual([Date.UTC(2026, 10, 21, 11), Date.UTC(2026, 10, 21, 12)]);
    expect(r.rows[1]).toEqual({
      bucket: Date.UTC(2026, 10, 21, 12), model: "priced-1", calls: 3, errors: 1, inputTokens: 30, outputTokens: 9, costMicro: 700,
      latSumMs: 900, lat: [0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
  });

  it("clamps what it asks the database for: 7 days at most (hourly), 48 hours at most (minute), nothing in the future", async () => {
    m.results = [projectRow, []];
    const h = await readHourlyRollups(ctx, PID, { fromMs: 0, toMs: NOW + 10 * 365 * 24 * HOUR }, NOW);
    expect(h.window.toMs - h.window.fromMs).toBe(7 * 24 * HOUR);
    expect(h.window.toMs).toBe(Date.UTC(2026, 10, 21, 13));
    expect(h.window.clamped).toBe(true);
    const asked = m.transactions[0]![2]!.values;
    expect(new Date(String(asked[2])).getTime() - new Date(String(asked[1])).getTime()).toBe(7 * 24 * HOUR);

    m.results = [projectRow, []];
    const mi = await readMinuteRollups(ctx, PID, { fromMs: 0, toMs: NOW }, NOW);
    expect(mi.window.toMs - mi.window.fromMs).toBe(48 * HOUR);
    expect(mi.window.toMs % MIN).toBe(0);
  });

  it("flags truncation when the row cap is hit and keeps the NEWEST rows", async () => {
    const many = Array.from({ length: METRICS_LIMITS.maxRows + 1 }, (_, i) => row({ bucket_ms: String(NOW - i * MIN), model: `m${i}` })); // newest first
    m.results = [projectRow, many];
    const r = await readMinuteRollups(ctx, PID, { fromMs: NOW - 60 * MIN, toMs: NOW }, NOW);
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(METRICS_LIMITS.maxRows);
    expect(r.rows[r.rows.length - 1]!.model).toBe("m0"); // the newest survived
    expect(r.rows.map((x) => x.model)).not.toContain(`m${METRICS_LIMITS.maxRows}`); // the extra (oldest) row was dropped
  });

  it("fails loudly on a row the strict schema rejects (never draws a wrong chart)", async () => {
    for (const bad of [{ calls: "NaN" }, { calls: "-1" }, { lat_b3: "1.5" }, { cost_micro: "abc" }]) {
      m.results = [projectRow, [row(bad)]];
      await expect(readHourlyRollups(ctx, PID, { fromMs: NOW - HOUR, toMs: NOW }, NOW)).rejects.toThrow();
    }
  });
});

describe("not found: foreign, missing, deleted and malformed ids are indistinguishable", () => {
  const reasons = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e;
    }
  };

  it("a malformed id and an id outside the context fail BEFORE the database, with the same error", async () => {
    const a = await reasons(() => readOverview(ctx, "not-a-uuid", "24h", { nowMs: NOW, prices: prices() }));
    const b = await reasons(() => readOverview(ctx, OTHER, "24h", { nowMs: NOW, prices: prices() }));
    const c = await reasons(() => readHourlyRollups(ctx, OTHER, { fromMs: 0, toMs: NOW }, NOW));
    const d = await reasons(() => readMinuteRollups(ctx, "' or 1=1 --", { fromMs: 0, toMs: NOW }, NOW));
    for (const e of [a, b, c, d]) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect((e as Error).message).toBe("not found");
    }
    expect(m.transactions).toHaveLength(0); // no database access at all
  });

  it("a project in the context that the database no longer shows (deleted) is the same NotFoundError", async () => {
    m.results = [[], []];
    const e = await reasons(() => readHourlyRollups(ctx, PID, { fromMs: NOW - HOUR, toMs: NOW }, NOW));
    expect(e).toBeInstanceOf(NotFoundError);
    expect((e as Error).message).toBe("not found");

    m.results = [[], [], []];
    const o = await reasons(() => readOverview(ctx, PID, "24h", { nowMs: NOW, prices: prices() }));
    expect(o).toBeInstanceOf(NotFoundError);
  });

  it("never returns rollup rows when the project row is missing, even if the driver handed some back", async () => {
    m.results = [[], [row()]];
    await expect(readHourlyRollups(ctx, PID, { fromMs: NOW - HOUR, toMs: NOW }, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("readOverview", () => {
  const T = Date.UTC(2026, 10, 21, 12, 0, 0);

  it("is ONE database round trip: project, rollups, usage (in that order) after set_config", async () => {
    m.results = [projectRow, [row()], [{ events: "42" }]];
    await readOverview(ctx, PID, "24h", { nowMs: NOW, prices: prices() });
    expect(m.transactions).toHaveLength(1);
    const q = m.transactions[0]!;
    expect(q).toHaveLength(4); // withTenant prepends set_config; build() adds the three
    expect(q[0]!.sql).toContain("set_config('app.owner_id'");
    expect(q[1]!.sql).toMatch(/^select id from projects where id = \?::uuid and owner_id = \?$/);
    expect(q[2]!.sql).toContain("from metrics_hourly");
    expect(q[3]!.sql).toMatch(/from usage_daily where project_id = \?::uuid and day = \?::date$/);
    expect(q[3]!.values).toEqual([PID, "2026-11-21"]);
  });

  it("fetches exactly the window buildOverview lays out (24h = 24 whole hours ending in the current one)", async () => {
    m.results = [projectRow, [], []];
    const o = await readOverview(ctx, PID, "24h", { nowMs: NOW, prices: prices() });
    const [, from, to] = m.transactions[0]![2]!.values as [string, string, string, number]; // [project, from, to, limit]
    expect(new Date(from).getTime()).toBe(o.from);
    expect(new Date(to).getTime()).toBe(o.to);
    expect(o.series).toHaveLength(24);
  });

  it("7d asks for 168 hours and never more", async () => {
    m.results = [projectRow, [], []];
    const o = await readOverview(ctx, PID, "7d", { nowMs: NOW, prices: prices() });
    expect(o.series).toHaveLength(168);
    expect(o.to - o.from).toBe(7 * 24 * HOUR);
  });

  it("builds the overview from the rows: totals, cost, quota, percentiles", async () => {
    m.results = [projectRow, [row({ bucket_ms: String(T) })], [{ events: "42" }]];
    const o = await readOverview(ctx, PID, "24h", { nowMs: NOW, prices: prices() });
    expect(o.totals).toMatchObject({ calls: 3, errors: 1, inputTokens: 30, outputTokens: 9, costMicro: 700 });
    expect(o.totals.p50).toBe(150); // all 3 calls in b2 = [100, 200) ms
    expect(o.quota).toEqual({ eventsToday: 42, eventsLimit: 1900 });
    expect(o.truncated).toBe(false);
    expect(o.unpricedCalls).toBe(0);
  });

  it("eventsToday is 0 when nothing was ingested today (no usage row)", async () => {
    m.results = [projectRow, [], []];
    expect((await readOverview(ctx, PID, "24h", { nowMs: NOW, prices: prices() })).quota.eventsToday).toBe(0);
  });

  it("COST: an unpriced model stays null, its bucket is flagged as a lower bound, a priced one is not", async () => {
    m.results = [
      projectRow,
      [
        row({ bucket_ms: String(T), model: "priced-1", calls: "4", cost_micro: "1000" }),
        row({ bucket_ms: String(T), model: "mystery-7b", calls: "6", cost_micro: "0" }),
        row({ bucket_ms: String(T - HOUR), model: "priced-1", calls: "2", cost_micro: "300" }),
      ],
      [],
    ];
    const o = await readOverview(ctx, PID, "24h", { nowMs: NOW, prices: prices() });
    const newest = o.series[o.series.length - 1]!;
    const prev = o.series[o.series.length - 2]!;
    expect(newest.costLowerBound).toBe(true);
    expect(newest.unpricedCalls).toBe(6);
    expect(newest.costMicro).toBe(1000);
    expect(prev.costLowerBound).toBe(false);
    expect(prev.unpricedCalls).toBe(0);
    expect(o.models.find((x) => x.model === "mystery-7b")!.costMicro).toBeNull();
    expect(o.models.find((x) => x.model === "priced-1")!.costMicro).toBe(1300);
    expect(o.unpricedModels).toEqual(["mystery-7b"]);
    expect(o.totals.costMicro).toBe(1300);
  });

  it("prices a dated model id by the ingest rule (one date suffix stripped), not as unknown", async () => {
    m.results = [projectRow, [row({ bucket_ms: String(T), model: "priced-1-2026-11-01" })], []];
    const o = await readOverview(ctx, PID, "24h", { nowMs: NOW, prices: prices() });
    expect(o.unpricedCalls).toBe(0);
    expect(o.models[0]!.priced).toBe(true);
  });

  it("carries the truncated flag through to the view model", async () => {
    const many = Array.from({ length: METRICS_LIMITS.maxRows + 1 }, (_, i) => row({ bucket_ms: String(T), model: `m${i}` }));
    m.results = [projectRow, many, []];
    expect((await readOverview(ctx, PID, "24h", { nowMs: NOW, prices: prices() })).truncated).toBe(true);
  });

  it("rejects an unknown range instead of widening the window", async () => {
    await expect(readOverview(ctx, PID, "90d" as never, { nowMs: NOW, prices: prices() })).rejects.toThrow();
    expect(m.transactions).toHaveLength(0);
  });
});

describe.each([
  { name: "readHourlyRollups", step: HOUR, read: () => readHourlyRollups(ctx, PID, { fromMs: NOW - 5 * HOUR, toMs: NOW }, NOW) },
  { name: "readMinuteRollups", step: MIN, read: () => readMinuteRollups(ctx, PID, { fromMs: NOW - 60 * MIN, toMs: NOW }, NOW) },
])("$name: result order is deterministic", ({ step, read }) => {
  const T = Date.UTC(2026, 10, 21, 12);
  const at = (bucket: number, model: string) => row({ bucket_ms: String(bucket), model });
  const keys = (rows: Array<{ bucket: number; model: string }>) => rows.map((r) => [r.bucket, r.model]);

  // The database order the statements produce: bucket DESC, then model ASC (what the LIMIT relies on).
  const dbOrder = () => [at(T, ""), at(T, "a-model"), at(T, "b-model"), at(T - step, "a-model"), at(T - step, "z-model")];
  const expected = [
    [T - step, "a-model"],
    [T - step, "z-model"],
    [T, ""],
    [T, "a-model"],
    [T, "b-model"],
  ];

  it("returns the oldest bucket first and, INSIDE a bucket, models ascending (the whole-array reverse put them descending)", async () => {
    m.results = [projectRow, dbOrder()];
    expect(keys((await read()).rows)).toEqual(expected);
  });

  it("does not depend on the order the driver returned the rows in", async () => {
    const base = dbOrder();
    const permutations = [[...base].reverse(), [...base.slice(2), ...base.slice(0, 2)], [base[3]!, base[0]!, base[4]!, base[2]!, base[1]!]];
    for (const p of permutations) {
      m.results = [projectRow, p];
      expect(keys((await read()).rows)).toEqual(expected);
    }
  });

  it("orders models by plain code units, not by locale or collation ('B' < 'Z' < 'a' < 'z' < 'é')", async () => {
    m.results = [projectRow, ["é", "a-model", "Z", "z", "B-model"].map((x) => at(T, x))];
    expect((await read()).rows.map((r) => r.model)).toEqual(["B-model", "Z", "a-model", "z", "é"]);
  });

  it("asks the database for the same rows as before: bucket DESC then model, so the LIMIT drops the oldest", async () => {
    m.results = [projectRow, []];
    await read();
    const sql = m.transactions[0]![2]!.sql;
    expect(sql).toMatch(/order by bucket desc, model limit \?::int$/);
    expect(m.transactions[0]![2]!.values.at(-1)).toBe(METRICS_LIMITS.maxRows + 1);
  });

  it("TRUNCATED mid-bucket: drops the last rows of the database order (the OLDEST bucket's highest models) and still returns ascending", async () => {
    const cap = METRICS_LIMITS.maxRows; // 5,000 kept, the 5,001st only proves the cap was hit
    const oldest = T - 2499 * step;
    const raw = [];
    for (let k = 0; k < 2499; k++) raw.push(at(T - k * step, "a"), at(T - k * step, "b")); // 4,998 rows, newest bucket first
    raw.push(at(oldest, "a"), at(oldest, "b"), at(oldest, "c")); // 3 rows in the oldest bucket: 5,001 in all
    expect(raw).toHaveLength(cap + 1);
    m.results = [projectRow, raw];

    const r = await read();
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(cap);
    // the cut fell INSIDE the oldest bucket: its "c" was dropped, its "a" and "b" were kept
    expect(keys(r.rows.slice(0, 2))).toEqual([[oldest, "a"], [oldest, "b"]]);
    expect(r.rows.some((x) => x.bucket === oldest && x.model === "c")).toBe(false);
    // the newest buckets are complete
    expect(keys(r.rows.slice(-2))).toEqual([[T, "a"], [T, "b"]]);
    // strictly ascending overall: no duplicates, no inversions anywhere
    for (let i = 1; i < r.rows.length; i++) expect(compareRollupRows(r.rows[i - 1]!, r.rows[i]!)).toBeLessThan(0);
  });

  it("TRUNCATED at a bucket boundary: the whole oldest bucket is dropped and nothing newer is", async () => {
    const cap = METRICS_LIMITS.maxRows;
    const raw = [];
    for (let k = 0; k < cap / 2; k++) raw.push(at(T - k * step, "a"), at(T - k * step, "b")); // exactly 5,000 rows
    raw.push(at(T - (cap / 2) * step, "a")); // the 5,001st row belongs to the next-older bucket
    m.results = [projectRow, raw];
    const r = await read();
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(cap);
    expect(r.rows[0]!.bucket).toBe(T - (cap / 2 - 1) * step);
    expect(r.rows.every((x) => x.bucket >= T - (cap / 2 - 1) * step)).toBe(true);
  });

  it("exactly the cap is NOT truncated", async () => {
    m.results = [projectRow, Array.from({ length: METRICS_LIMITS.maxRows }, (_, k) => at(T - k * step, "a"))];
    const r = await read();
    expect(r.truncated).toBe(false);
    expect(r.rows).toHaveLength(METRICS_LIMITS.maxRows);
  });
});

describe("compareRollupRows", () => {
  it("is a total order: antisymmetric, transitive on samples, 0 only for the same (bucket, model)", () => {
    const rows = [
      { bucket: 1, model: "" }, { bucket: 1, model: "a" }, { bucket: 1, model: "B" }, { bucket: 2, model: "" }, { bucket: 0, model: "z" },
    ];
    for (const a of rows) {
      expect(compareRollupRows(a, a)).toBe(0);
      for (const b of rows) {
        if (a !== b) {
          expect(compareRollupRows(a, b)).not.toBe(0);
          expect(Math.sign(compareRollupRows(a, b))).toBe(-Math.sign(compareRollupRows(b, a)));
        }
      }
    }
    const sorted = [...rows].sort(compareRollupRows);
    expect(sorted.map((r) => `${r.bucket}:${r.model}`)).toEqual(["0:z", "1:", "1:B", "1:a", "2:"]);
  });
});

describe("the rollup tables are read only through lib/repo/metrics.ts", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(ts|tsx)$/.test(p) ? [p] : [];
    });
  }
  it("no other file selects from them (the ingest statement only writes)", () => {
    const reading = /\b(from|join)\s+metrics_(hourly|minute)\b/i;
    const offenders = [...walk("app"), ...walk("lib"), ...walk("components")].filter((f) => f !== "lib/repo/metrics.ts" && reading.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("the reader sets no write statements and builds no SQL by concatenation", () => {
    const src = readFileSync("lib/repo/metrics.ts", "utf8");
    expect(src).not.toMatch(/\b(insert into|update\s+\w+\s+set|delete from)\b/i);
    expect(src).not.toMatch(/sql\.query|\.unsafe\(|"\s*\+\s*(pid|projectId)/);
  });
});
