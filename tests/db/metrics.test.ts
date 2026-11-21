import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { PriceBook } from "@/lib/ingest/cost";
import { ctxFromSession } from "@/lib/repo/ctx";
import { NotFoundError } from "@/lib/repo/errors";
import { readHourlyRollups, readMinuteRollups, readOverview } from "@/lib/repo/metrics";
import { createProject, deleteProject } from "@/lib/repo/projects";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";
import { cleanupOwners } from "./helpers/cleanup";

/**
 * The dashboard metrics reader against the real database as app_rw, with Clerk mocked: shard sums, window clamps, cost
 * rules and, above all, tenant isolation. Rollup rows are seeded through the same RLS-scoped door the app uses.
 * Skipped without DATABASE_URL. Run alone with `npm run test:db:metrics`.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

const HOUR = 3_600_000;
const MIN = 60_000;

interface Seed {
  bucketMs: number;
  model?: string;
  shard?: number;
  calls?: number;
  errors?: number;
  input?: number;
  output?: number;
  cost?: number;
  latSum?: number;
  /** Calls counted in latency bucket b2 ([100, 200) ms) and b6 ([3200, 6400) ms). */
  latB2?: number;
  latB6?: number;
}

run("metrics reader (database)", () => {
  const sql = neon(url!);
  const users: string[] = [];
  const nowMs = Date.now();
  const hourStart = Math.floor(nowMs / HOUR) * HOUR;
  const minuteStart = Math.floor(nowMs / MIN) * MIN;
  const today = new Date(nowMs).toISOString().slice(0, 10);

  const prices = () =>
    new PriceBook(async () => [
      { model: "priced-1", inputPer1m: "2.00", outputPer1m: "10.00", cachedInputPer1m: null },
      { model: "free-1", inputPer1m: "0", outputPer1m: "0", cachedInputPer1m: null },
    ]);

  const asUser = async () => {
    const u = `test_${randomUUID()}`;
    users.push(u);
    await sql`select claim_user_slot(${u}, 100000)`;
    return u;
  };
  const sessionCtx = async (u: string) => {
    mockAuth.mockResolvedValue({ userId: u });
    return (await ctxFromSession())!;
  };
  /** A user with one project: the ctx is created AFTER the project, so it lists it. */
  const tenant = async () => {
    const owner = await asUser();
    mockAuth.mockResolvedValue({ userId: owner });
    const first = (await ctxFromSession())!;
    const project = await createProject(first, { name: "metrics" });
    const ctx = await sessionCtx(owner);
    return { owner, projectId: project.id, ctx };
  };
  const raw = (owner: string, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${ids.join(",")}, true)`,
      ...build(t),
    ]);

  const seedHourly = (owner: string, pid: string, rows: Seed[]) =>
    raw(owner, [pid], (t) =>
      rows.map(
        (r) =>
          t`insert into metrics_hourly (project_id, bucket, model, shard, calls, errors, input_tokens, output_tokens, cost_micro, lat_sum_ms, lat_b2, lat_b6)
            values (${pid}::uuid, ${new Date(r.bucketMs).toISOString()}::timestamptz, ${r.model ?? ""}, ${r.shard ?? 0}, ${r.calls ?? 0}, ${r.errors ?? 0},
                    ${r.input ?? 0}, ${r.output ?? 0}, ${r.cost ?? 0}, ${r.latSum ?? 0}, ${r.latB2 ?? 0}, ${r.latB6 ?? 0})`,
      ),
    );
  const seedMinute = (owner: string, pid: string, rows: Seed[]) =>
    raw(owner, [pid], (t) =>
      rows.map(
        (r) =>
          t`insert into metrics_minute (project_id, bucket, model, shard, calls, errors, input_tokens, output_tokens, cost_micro, lat_sum_ms, lat_b2, lat_b6)
            values (${pid}::uuid, ${new Date(r.bucketMs).toISOString()}::timestamptz, ${r.model ?? ""}, ${r.shard ?? 0}, ${r.calls ?? 0}, ${r.errors ?? 0},
                    ${r.input ?? 0}, ${r.output ?? 0}, ${r.cost ?? 0}, ${r.latSum ?? 0}, ${r.latB2 ?? 0}, ${r.latB6 ?? 0})`,
      ),
    );
  const seedUsage = (owner: string, pid: string, events: number) =>
    raw(owner, [pid], (t) => [t`insert into usage_daily (project_id, day, events) values (${pid}::uuid, ${today}::date, ${events})`]);

  const failure = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return e as Error;
    }
    return null;
  };

  beforeEach(() => {
    mockAuth.mockResolvedValue({ userId: null });
  });

  afterAll(async () => {
    await cleanupOwners(sql, users);
  });

  // ---- shard sums ----

  it("HOURLY: sums every shard of the same (bucket, model), including values beyond 2^31", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seedHourly(owner, projectId, [
      { bucketMs: hourStart, model: "priced-1", shard: 0, calls: 5, errors: 1, input: 3_000_000_000, output: 7, cost: 100, latSum: 500, latB2: 5 },
      { bucketMs: hourStart, model: "priced-1", shard: 1, calls: 4, errors: 0, input: 3_000_000_000, output: 3, cost: 50, latSum: 400, latB2: 3, latB6: 1 }, // legacy shards 1-7 may exist
      { bucketMs: hourStart, model: "priced-1", shard: 7, calls: 1, errors: 2, input: 3_000_000_000, output: 0, cost: 25, latSum: 10, latB6: 1 },
    ]);
    const { rows, truncated } = await readHourlyRollups(ctx, projectId, { fromMs: hourStart - HOUR, toMs: nowMs }, nowMs);
    expect(truncated).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bucket: hourStart, model: "priced-1", calls: 10, errors: 3, inputTokens: 9_000_000_000, outputTokens: 10, costMicro: 175, latSumMs: 910,
    });
    expect(rows[0]!.lat[2]).toBe(8);
    expect(rows[0]!.lat[6]).toBe(2);
    expect(rows[0]!.lat.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("MINUTE: sums all 8 shards of one (minute, model) into one row", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seedMinute(owner, projectId, Array.from({ length: 8 }, (_, shard) => ({ bucketMs: minuteStart, model: "priced-1", shard, calls: shard + 1, input: 10, cost: 5, latB2: shard + 1 })));
    const { rows } = await readMinuteRollups(ctx, projectId, { fromMs: minuteStart - 10 * MIN, toMs: nowMs }, nowMs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bucket: minuteStart, model: "priced-1", calls: 36, inputTokens: 80, costMicro: 40 });
    expect(rows[0]!.lat[2]).toBe(36);
  });

  it("keeps different models and different buckets apart, oldest bucket first", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seedHourly(owner, projectId, [
      { bucketMs: hourStart, model: "b-model", calls: 1 },
      { bucketMs: hourStart, model: "a-model", calls: 2 },
      { bucketMs: hourStart - HOUR, model: "a-model", calls: 4 },
      { bucketMs: hourStart, model: "", calls: 8 },
    ]);
    const { rows } = await readHourlyRollups(ctx, projectId, { fromMs: hourStart - 2 * HOUR, toMs: nowMs }, nowMs);
    expect(rows.map((r) => [r.bucket, r.model, r.calls])).toEqual([
      [hourStart - HOUR, "a-model", 4],
      [hourStart, "", 8],
      [hourStart, "a-model", 2],
      [hourStart, "b-model", 1],
    ]);
  });

  // ---- windows ----

  it("never returns more than 7 days, however much is asked for, and nothing from the future", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seedHourly(owner, projectId, [
      { bucketMs: hourStart, calls: 1 },
      { bucketMs: hourStart - 6 * 24 * HOUR, calls: 2 }, // inside 7 days
      { bucketMs: hourStart - 10 * 24 * HOUR, calls: 4 }, // exists in the table (retention is 90 days) but must not be read
      { bucketMs: hourStart + 5 * HOUR, calls: 8 }, // future
    ]);
    const r = await readHourlyRollups(ctx, projectId, { fromMs: 0, toMs: nowMs + 365 * 24 * HOUR }, nowMs);
    expect(r.rows.map((x) => x.calls)).toEqual([2, 1]);
    expect(r.window.toMs - r.window.fromMs).toBe(7 * 24 * HOUR);
    expect(r.window.clamped).toBe(true);
  });

  it("minute reads stop at 48 hours", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seedMinute(owner, projectId, [
      { bucketMs: minuteStart, calls: 1 },
      { bucketMs: minuteStart - 47 * HOUR, calls: 2 },
      { bucketMs: minuteStart - 60 * HOUR, calls: 4 },
    ]);
    const r = await readMinuteRollups(ctx, projectId, { fromMs: 0, toMs: nowMs }, nowMs);
    expect(r.rows.map((x) => x.calls)).toEqual([2, 1]);
  });

  // ---- the overview, end to end ----

  it("readOverview: totals, quota, percentiles from the 12 buckets, unknown cost stays null and is flagged per bucket", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seedHourly(owner, projectId, [
      { bucketMs: hourStart, model: "priced-1", calls: 4, errors: 1, input: 100, output: 40, cost: 1_000, latSum: 600, latB2: 4 },
      { bucketMs: hourStart, model: "mystery-7b", calls: 6, input: 50, output: 20, cost: 0, latSum: 6_000, latB6: 6 }, // unpriced: ingest stored 0
      { bucketMs: hourStart, model: "free-1", calls: 2, cost: 0, latB2: 2 }, // priced at 0: a GENUINE zero
      { bucketMs: hourStart - HOUR, model: "priced-1", calls: 2, cost: 300, latB2: 2 },
      { bucketMs: hourStart - HOUR, model: "", calls: 3, latB2: 3 },
    ]);
    await seedUsage(owner, projectId, 77);

    const o = await readOverview(ctx, projectId, "24h", { nowMs, prices: prices() });
    expect(o.series).toHaveLength(24);
    expect(o.totals).toMatchObject({ calls: 17, errors: 1, inputTokens: 150, outputTokens: 60, costMicro: 1_300 });
    expect(o.quota).toEqual({ eventsToday: 77, eventsLimit: 1_900 });
    expect(o.truncated).toBe(false);

    const newest = o.series[23]!;
    const prev = o.series[22]!;
    expect(newest).toMatchObject({ calls: 12, costMicro: 1_000, unpricedCalls: 6, costLowerBound: true });
    expect(prev).toMatchObject({ calls: 5, costMicro: 300, unpricedCalls: 0, costLowerBound: false });
    expect(newest.p50).not.toBeNull();
    expect(prev.p50).toBe(150); // 5 calls, all in b2 = [100, 200) ms, interpolated at the middle

    const byModel = new Map(o.models.map((m) => [m.model, m]));
    expect(byModel.get("mystery-7b")).toMatchObject({ priced: false, costMicro: null, calls: 6 }); // unknown, NOT 0
    expect(byModel.get("free-1")).toMatchObject({ priced: true, costMicro: 0 }); // a real zero is still 0
    expect(byModel.get("priced-1")).toMatchObject({ priced: true, costMicro: 1_300 });
    expect(byModel.get(null)).toMatchObject({ calls: 3, priced: true });
    expect(o.unpricedModels).toEqual(["mystery-7b"]);
    expect(o.unpricedCalls).toBe(6);
  });

  it("readOverview 7d covers 168 hourly buckets; an empty project is all zeros with null percentiles and 0 events today", async () => {
    const { projectId, ctx } = await tenant();
    const o = await readOverview(ctx, projectId, "7d", { nowMs, prices: prices() });
    expect(o.series).toHaveLength(168);
    expect(o.totals).toMatchObject({ calls: 0, costMicro: 0, p50: null, p95: null });
    expect(o.series.every((p) => p.p50 === null && !p.costLowerBound)).toBe(true);
    expect(o.quota.eventsToday).toBe(0);
    expect(o.models).toEqual([]);
  });

  // ---- tenant isolation ----

  it("IDOR: user B can never read project A's metrics, by any reader", async () => {
    const a = await tenant();
    const b = await tenant();
    await seedHourly(a.owner, a.projectId, [{ bucketMs: hourStart, model: "priced-1", calls: 99 }]);
    await seedMinute(a.owner, a.projectId, [{ bucketMs: minuteStart, model: "priced-1", calls: 99 }]);
    await seedUsage(a.owner, a.projectId, 99);

    const errors = [
      await failure(() => readOverview(b.ctx, a.projectId, "24h", { nowMs, prices: prices() })),
      await failure(() => readHourlyRollups(b.ctx, a.projectId, { fromMs: hourStart - HOUR, toMs: nowMs }, nowMs)),
      await failure(() => readMinuteRollups(b.ctx, a.projectId, { fromMs: minuteStart - MIN, toMs: nowMs }, nowMs)),
    ];
    for (const e of errors) expect(e).toBeInstanceOf(NotFoundError);

    // ... and A still reads their own data (the data really exists).
    expect((await readOverview(a.ctx, a.projectId, "24h", { nowMs, prices: prices() })).totals.calls).toBe(99);
  });

  it("a wrong project id gives the SAME answer as a missing one, a malformed one and a deleted one", async () => {
    const a = await tenant();
    const b = await tenant();
    const gone = await createProject(await sessionCtx(b.owner), { name: "gone" });
    const bCtx = await sessionCtx(b.owner); // lists both of B's projects
    await deleteProject(bCtx, gone.id); // bCtx is now stale: it still lists a deleted project

    const attempts = await Promise.all([
      failure(() => readOverview(b.ctx, a.projectId, "24h", { nowMs, prices: prices() })), // someone else's project
      failure(() => readOverview(b.ctx, randomUUID(), "24h", { nowMs, prices: prices() })), // never existed
      failure(() => readOverview(b.ctx, "not-a-uuid", "24h", { nowMs, prices: prices() })), // malformed
      failure(() => readOverview(bCtx, gone.id, "24h", { nowMs, prices: prices() })), // deleted, but still in this context
    ]);
    for (const e of attempts) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect(e!.message).toBe("not found");
      expect(e!.name).toBe("NotFoundError");
    }
  });

  it("defence in depth: a context that WRONGLY lists another owner's project still cannot read it (explicit owner filter)", async () => {
    const a = await tenant();
    const b = await tenant();
    await seedHourly(a.owner, a.projectId, [{ bucketMs: hourStart, model: "priced-1", calls: 99 }]);
    // A bug elsewhere put A's project id into B's context. RLS alone would then allow the rollup rows; the owner filter must not.
    const forged = issueCtx<SessionCtx>({ kind: "session", ownerId: b.owner, projectIds: [b.projectId, a.projectId], readOnly: false });
    expect(await failure(() => readOverview(forged, a.projectId, "24h", { nowMs, prices: prices() }))).toBeInstanceOf(NotFoundError);
    expect(await failure(() => readHourlyRollups(forged, a.projectId, { fromMs: hourStart - HOUR, toMs: nowMs }, nowMs))).toBeInstanceOf(NotFoundError);
  });

  it("RLS under the reader: another tenant's rollup rows are invisible even to a raw statement", async () => {
    const a = await tenant();
    const b = await tenant();
    await seedHourly(a.owner, a.projectId, [{ bucketMs: hourStart, calls: 5 }]);
    await seedMinute(a.owner, a.projectId, [{ bucketMs: minuteStart, calls: 5 }]);
    const [, h, mi] = await raw(b.owner, [b.projectId], (t) => [
      t`select count(*)::int as n from metrics_hourly where project_id = ${a.projectId}::uuid`,
      t`select count(*)::int as n from metrics_minute where project_id = ${a.projectId}::uuid`,
    ]);
    expect([h![0]!.n, mi![0]!.n]).toEqual([0, 0]);
  });

  it("one owner's two projects never leak into each other", async () => {
    const owner = await asUser();
    mockAuth.mockResolvedValue({ userId: owner });
    const first = (await ctxFromSession())!;
    const p1 = await createProject(first, { name: "one" });
    const p2 = await createProject(first, { name: "two" });
    const ctx = await sessionCtx(owner);
    await seedHourly(owner, p1.id, [{ bucketMs: hourStart, model: "priced-1", calls: 3 }]);
    await seedHourly(owner, p2.id, [{ bucketMs: hourStart, model: "priced-1", calls: 40 }]);
    await seedUsage(owner, p2.id, 40);
    const o1 = await readOverview(ctx, p1.id, "24h", { nowMs, prices: prices() });
    const o2 = await readOverview(ctx, p2.id, "24h", { nowMs, prices: prices() });
    expect(o1.totals.calls).toBe(3);
    expect(o1.quota.eventsToday).toBe(0);
    expect(o2.totals.calls).toBe(40);
    expect(o2.quota.eventsToday).toBe(40);
  });

  it("is read-only: reading changes no rollup or usage row", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seedHourly(owner, projectId, [{ bucketMs: hourStart, model: "priced-1", calls: 7 }]);
    const snapshot = () => raw(owner, [projectId], (t) => [t`select sum(calls)::int as n, count(*)::int as c from metrics_hourly where project_id = ${projectId}::uuid`]);
    const before = (await snapshot())[1]![0];
    await readOverview(ctx, projectId, "7d", { nowMs, prices: prices() });
    await readHourlyRollups(ctx, projectId, { fromMs: 0, toMs: nowMs }, nowMs);
    expect((await snapshot())[1]![0]).toEqual(before);
  });
});
