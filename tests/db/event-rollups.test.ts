import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { PgEventStore } from "@/lib/events/pg-store";
import { MissingPartitionError } from "@/lib/events/store";
import type { NormalizedEvent } from "@/lib/ingest/normalize";
import { createApiKey } from "@/lib/repo/api-keys";
import { ctxFromApiKey, ctxFromSession } from "@/lib/repo/ctx";
import { createProject } from "@/lib/repo/projects";

/**
 * Write-time rollups, usage and budgets, all computed from the rows the insert actually produced.
 * Real database as app_rw. Skipped without DATABASE_URL.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

run("event rollups (database)", () => {
  const sql = neon(url!);
  const users: string[] = [];
  const raw = (owner: string, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${ids.join(",")}, true)`,
      ...build(t),
    ]);
  const q = async (x: { owner: string; project: string }, text: string) => (await raw(x.owner, [x.project], (t) => [t.query(text)]))[1] as Record<string, unknown>[];

  /** A tenant with an ingest key and three budgets: project/day (alert), project/month (block), trace/run (alert). */
  const tenant = async () => {
    const owner = `test_${randomUUID()}`;
    users.push(owner);
    await sql`select claim_user_slot(${owner}, 100000)`;
    mockAuth.mockResolvedValue({ userId: owner });
    const project = (await createProject((await ctxFromSession())!, { name: "rollup-test" })).id;
    const { secret } = await createApiKey((await ctxFromSession())!, project, { scopes: ["ingest"] });
    const ids = { day: randomUUID(), month: randomUUID(), run: randomUUID() };
    await raw(owner, [project], (t) => [
      t`insert into budgets (id, project_id, scope, period, limit_usd, action) values (${ids.day}, ${project}, 'project', 'day', 5, 'alert')`,
      t`insert into budgets (id, project_id, scope, period, limit_usd, action) values (${ids.month}, ${project}, 'project', 'month', 50, 'block')`,
      t`insert into budgets (id, project_id, scope, period, limit_usd, action) values (${ids.run}, ${project}, 'trace', 'run', 1, 'alert')`,
    ]);
    return { owner, project, budgets: ids, ctx: (await ctxFromApiKey(secret))! };
  };

  // Fixed minute inside the last hour so everything lands in one minute/hour bucket per test run.
  const t0 = new Date(Math.floor((Date.now() - 600_000) / 60_000) * 60_000);
  const ev = (o: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
    eventId: randomUUID(), occurredAt: new Date(t0.getTime() + 5000),
    traceId: null, spanId: null, parentId: null, threadId: null, kind: "llm", name: null, model: null, provider: null,
    inputTokens: null, outputTokens: null, cachedTokens: null, latencyMs: null, ttftMs: null, costMicro: null, costUsd: null,
    status: "ok", error: null, promptHash: null, argsHash: null, userIdHash: null, tags: null, content: null,
    ...o,
  });
  const priced = (model: string, inTok: number, outTok: number, micro: number, o: Partial<NormalizedEvent> = {}) =>
    ev({ model, inputTokens: inTok, outputTokens: outTok, costMicro: micro, costUsd: (micro / 1e6).toFixed(6), ...o });

  /** Every number the rollups, usage and budgets hold, in one comparable object. */
  const snapshot = async (x: { owner: string; project: string }) => ({
    minute: await q(x, "select model, shard, calls, input_tokens::text as it, output_tokens::text as ot, cost_micro::text as cm, errors, lat_sum_ms::text as ls, lat_b0, lat_b1, lat_b2, lat_b3, lat_b4, lat_b5, lat_b6, lat_b7, lat_b8, lat_b9, lat_b10, lat_b11 from metrics_minute order by bucket, model, shard"),
    hourly: await q(x, "select model, shard, calls, input_tokens::text as it, output_tokens::text as ot, cost_micro::text as cm, errors, lat_sum_ms::text as ls, lat_b0, lat_b1, lat_b2, lat_b3, lat_b4, lat_b5, lat_b6, lat_b7, lat_b8, lat_b9, lat_b10, lat_b11 from metrics_hourly order by bucket, model, shard"),
    usage: await q(x, "select events::text as events, requests::text as requests, cost_micro::text as cm from usage_daily"),
    budget: await q(x, "select budget_id, period_key, spent_micro::text as spent from budget_usage order by budget_id, period_key"),
    events: await q(x, "select count(*)::int as n from events"),
  });

  beforeAll(async () => {
    await sql`select ensure_event_partitions((date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date, 5)`;
  });
  afterAll(async () => {
    for (const u of users) await raw(u, [], (t) => [t`delete from projects where owner_id = ${u}`, t`select release_user_slot()`]);
  });

  it("writes minute and hourly rollups, usage and budget rows for a batch", async () => {
    const a = await tenant();
    const store = new PgEventStore({ pickShard: () => 3 });
    const r = await store.persist(a.ctx, [
      priced("gpt-4o", 100, 20, 1500, { latencyMs: 30, traceId: "trA" }), // bucket 0
      priced("gpt-4o", 200, 40, 2500, { latencyMs: 120, status: "error", traceId: "trA" }), // bucket 2
      priced("claude", 10, 5, 400, { latencyMs: 60000, traceId: "trB" }), // bucket 11
      ev({ kind: "tool", name: "search", traceId: "trA" }), // no model, no cost, no latency
    ]);
    expect(r.inserted).toBe(4);
    expect(r.usage).toEqual({ events: 4, requests: 1, costMicro: 4400 });

    const s = await snapshot(a);
    expect(s.minute).toHaveLength(3); // gpt-4o, claude, '' (model-less)
    const gpt = s.minute.find((m) => m.model === "gpt-4o")!;
    expect(gpt).toMatchObject({ shard: 3, calls: 2, it: "300", ot: "60", cm: "4000", errors: 1, ls: "150", lat_b0: 1, lat_b2: 1, lat_b1: 0, lat_b11: 0 });
    expect(s.minute.find((m) => m.model === "claude")).toMatchObject({ calls: 1, cm: "400", lat_b11: 1, ls: "60000" });
    // The model-less tool event counts as a call but sits in no latency bucket and adds no latency.
    const tool = s.minute.find((m) => m.model === "")!;
    expect(tool).toMatchObject({ calls: 1, cm: "0", ls: "0" });
    expect([tool.lat_b0, tool.lat_b1, tool.lat_b11].every((n) => n === 0)).toBe(true);
    expect(s.hourly.map((h) => [h.model, h.calls, h.cm]).sort()).toEqual(s.minute.map((m) => [m.model, m.calls, m.cm]).sort());
    expect(s.usage).toEqual([{ events: "4", requests: "1", cm: "4400" }]);

    // Budgets: project/day and project/month hold the total; the per-run budget holds one row per trace.
    const day = t0.toISOString().slice(0, 10);
    const month = t0.toISOString().slice(0, 7);
    const bykey = Object.fromEntries(s.budget.map((b) => [`${b.budget_id}|${b.period_key}`, b.spent]));
    expect(bykey).toEqual({
      [`${a.budgets.day}|${day}`]: "4400",
      [`${a.budgets.month}|${month}`]: "4400",
      [`${a.budgets.run}|trA`]: "4000",
      [`${a.budgets.run}|trB`]: "400",
    });
    // The returned budgets carry config plus cumulative spend, ready for the Guard.
    expect(r.budgets).toHaveLength(4);
    expect(r.budgets).toContainEqual({ budgetId: a.budgets.month, scope: "project", period: "month", limitUsd: "50", action: "block", periodKey: month, spentMicro: 4400 });
  });

  it("a duplicate batch counts once EVERYWHERE (events, minute, hourly, usage cost/events, budgets)", async () => {
    const a = await tenant();
    const store = new PgEventStore({ pickShard: () => 1 });
    const batch = [priced("gpt-4o", 100, 20, 1500, { latencyMs: 80, traceId: "t1" }), priced("claude", 7, 3, 900, { latencyMs: 700, status: "error", traceId: "t2" })];
    const first = await store.persist(a.ctx, batch);
    const before = await snapshot(a);
    const second = await store.persist(a.ctx, batch);
    const after = await snapshot(a);

    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.budgets).toEqual([]);
    expect(second.usage).toMatchObject({ events: 2, costMicro: 2400 }); // unchanged totals returned
    expect(after.events).toEqual(before.events);
    expect(after.minute).toEqual(before.minute);
    expect(after.hourly).toEqual(before.hourly);
    expect(after.budget).toEqual(before.budget);
    // The only thing that moves is the request counter: a duplicate is still a request.
    expect(before.usage).toEqual([{ events: "2", requests: "1", cm: "2400" }]);
    expect(after.usage).toEqual([{ events: "2", requests: "2", cm: "2400" }]);
  });

  it("a partly duplicate batch adds only the new events everywhere", async () => {
    const a = await tenant();
    const store = new PgEventStore({ pickShard: () => 0 });
    const old = priced("gpt-4o", 10, 10, 1000, { traceId: "t" });
    await store.persist(a.ctx, [old]);
    const fresh = priced("gpt-4o", 20, 20, 2000, { traceId: "t" });
    const r = await store.persist(a.ctx, [old, fresh]);
    expect(r.inserted).toBe(1);
    const s = await snapshot(a);
    expect(s.minute[0]).toMatchObject({ calls: 2, it: "30", cm: "3000" });
    expect(s.usage).toEqual([{ events: "2", requests: "2", cm: "3000" }]);
    expect(r.budgets.find((b) => b.scope === "trace")).toMatchObject({ periodKey: "t", spentMicro: 3000 }); // cumulative
  });

  it("the same event twice inside one batch counts once", async () => {
    const a = await tenant();
    const e = priced("gpt-4o", 10, 10, 1000, { traceId: "t" });
    const r = await new PgEventStore({ pickShard: () => 0 }).persist(a.ctx, [e, { ...e }, e]);
    expect(r.inserted).toBe(1);
    const s = await snapshot(a);
    expect(s.minute[0]).toMatchObject({ calls: 1, cm: "1000" });
    expect(s.usage).toEqual([{ events: "1", requests: "1", cm: "1000" }]);
  });

  it("unknown cost counts as zero: no budget rows, calls still counted", async () => {
    const a = await tenant();
    const r = await new PgEventStore().persist(a.ctx, [ev({ model: "mystery", inputTokens: 5 })]);
    expect(r.inserted).toBe(1);
    expect(r.budgets).toEqual([]);
    const s = await snapshot(a);
    expect(s.budget).toEqual([]);
    expect(s.minute[0]).toMatchObject({ model: "mystery", calls: 1, cm: "0", it: "5" });
  });

  it("events older than 48 h reach the hourly rollup but not the minute rollup", async () => {
    const a = await tenant();
    const old = new Date(Date.now() - 3 * 86_400_000);
    await new PgEventStore({ pickShard: () => 0 }).persist(a.ctx, [priced("gpt-4o", 1, 1, 100, { occurredAt: old })]);
    const s = await snapshot(a);
    expect(s.minute).toHaveLength(0);
    expect(s.hourly).toHaveLength(1);
    expect(s.hourly[0]).toMatchObject({ calls: 1, cm: "100" });
  });

  it("different shards give separate rows for the same bucket and model; their sum is exact", async () => {
    const a = await tenant();
    await new PgEventStore({ pickShard: () => 2 }).persist(a.ctx, [priced("m", 1, 1, 10)]);
    await new PgEventStore({ pickShard: () => 6 }).persist(a.ctx, [priced("m", 1, 1, 20)]);
    const rows = await q(a, "select shard, calls, cost_micro::text as cm from metrics_minute order by shard");
    expect(rows).toEqual([{ shard: 2, calls: 1, cm: "10" }, { shard: 6, calls: 1, cm: "20" }]);
    const [sum] = await q(a, "select sum(calls)::int as calls, sum(cost_micro)::text as cm from metrics_minute");
    expect(sum).toEqual({ calls: 2, cm: "30" });
    expect(await q(a, "select count(*)::int as n from metrics_hourly")).toEqual([{ n: 2 }]); // hourly rows are sharded too
  });

  it("concurrent writers on the same project, minute, model AND shard finish without errors and lose no counts", async () => {
    const a = await tenant();
    // All writers use shard 0 (maximum contention on the same rollup rows) and alternate the order of
    // models inside the batch, which would deadlock without the ORDER BY on the aggregated inserts.
    const writers = Array.from({ length: 8 }, (_, i) => {
      const batch = [priced("m", 1, 1, 100, { traceId: "shared" }), priced("n", 1, 1, 100, { traceId: "shared" })];
      return new PgEventStore({ pickShard: () => 0 }).persist(a.ctx, i % 2 ? batch.reverse() : batch);
    });
    const results = await Promise.all(writers); // rejects on any error, including a deadlock that survived the retry
    expect(results.every((r) => r.inserted === 2)).toBe(true);
    const [m] = await q(a, "select sum(calls)::int as calls, sum(cost_micro)::text as cm from metrics_minute");
    expect(m).toEqual({ calls: 16, cm: "1600" });
    expect(await q(a, "select count(*)::int as n from metrics_minute")).toEqual([{ n: 2 }]); // one row per model, one shard
    const s = await snapshot(a);
    expect(s.usage).toEqual([{ events: "16", requests: "8", cm: "1600" }]);
    expect(s.budget.find((b) => b.budget_id === a.budgets.run && b.period_key === "shared")?.spent).toBe("1600");
  });

  it("IDOR: tenants never touch each other's rollups, usage or budgets", async () => {
    const a = await tenant();
    const b = await tenant();
    const store = new PgEventStore({ pickShard: () => 0 });
    await store.persist(a.ctx, [priced("m", 1, 1, 100, { traceId: "x" })]);
    const aBefore = await snapshot(a);
    await store.persist(b.ctx, [priced("m", 1, 1, 777, { traceId: "x" })]); // same trace id, same model, same minute
    expect(await snapshot(a)).toEqual(aBefore);
    const bs = await snapshot(b);
    expect(bs.minute[0]).toMatchObject({ calls: 1, cm: "777" });
    expect(bs.budget.every((r) => (Object.values(b.budgets) as string[]).includes(r.budget_id as string))).toBe(true); // only B's own budgets
    // Scoped to A, B's rows are invisible in every table.
    for (const table of ["metrics_minute", "metrics_hourly", "usage_daily", "budget_usage", "events"]) {
      expect(await q(a, `select count(*)::int as n from ${table} where project_id = '${b.project}'`), table).toEqual([{ n: 0 }]);
    }
  });

  it("is atomic: a batch with a missing-partition event writes no rollup, usage or budget row", async () => {
    const a = await tenant();
    await expect(
      new PgEventStore().persist(a.ctx, [priced("m", 1, 1, 100, { traceId: "t" }), priced("m", 1, 1, 100, { occurredAt: new Date("2001-01-01T00:00:00Z") })]),
    ).rejects.toBeInstanceOf(MissingPartitionError);
    const s = await snapshot(a);
    expect([s.events, s.minute, s.hourly, s.usage, s.budget]).toEqual([[{ n: 0 }], [], [], [], []]);
  });
});
