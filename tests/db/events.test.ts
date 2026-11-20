import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** events (partitioned), rollups, content: RLS, grants, partitions, idempotency. As app_rw; skipped without DATABASE_URL. */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

run("events schema (app_rw)", () => {
  const sql = neon(url!);
  const scoped = (owner: string | null, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner ?? ""}, true), set_config('app.project_ids', ${ids.join(",")}, true)`,
      ...build(t),
    ]);
  const mk = () => ({ owner: `test_${randomUUID()}`, project: randomUUID() as string, budget: randomUUID() as string });
  const A = mk();
  const B = mk();
  const TABLES = ["events", "event_content", "metrics_minute", "metrics_hourly", "usage_daily", "budget_usage"] as const;
  const now = new Date().toISOString();

  const seed = (x: typeof A) =>
    scoped(x.owner, [x.project], (t) => [
      t`insert into projects (id, owner_id, name) values (${x.project}, ${x.owner}, 'events-test')`,
      t`insert into budgets (id, project_id, scope, period, limit_usd, action) values (${x.budget}, ${x.project}, 'project', 'day', 1, 'alert')`,
      t`insert into events (event_id, project_id, trace_id, model, occurred_at) values (${randomUUID()}, ${x.project}, 'tr1', 'm', ${now})`,
      t`insert into event_content (event_id, project_id, input_text, expires_at) values (${randomUUID()}, ${x.project}, 'hi', now() + interval '1 day')`,
      t`insert into metrics_minute (project_id, bucket, model, calls) values (${x.project}, date_trunc('minute', now()), 'm', 1)`,
      t`insert into metrics_hourly (project_id, bucket, model, calls) values (${x.project}, date_trunc('hour', now()), 'm', 1)`,
      t`insert into usage_daily (project_id, day, events, requests) values (${x.project}, current_date, 1, 1)`,
      t`insert into budget_usage (project_id, budget_id, period_key, spent_micro) values (${x.project}, ${x.budget}, '2026-11-17', 5)`,
    ]);

  beforeAll(async () => {
    // Earlier runs may have dropped now-expired partitions (e.g. last month after day 14), and a long gap
    // since the last migration leaves the future ones missing. Restore previous, current and next three.
    await sql`select ensure_event_partitions((date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date, 5)`;
    await seed(A);
    await seed(B);
  });
  afterAll(async () => {
    for (const x of [A, B]) await scoped(x.owner, [x.project], (t) => [t`delete from projects where id = ${x.project}`]);
  });

  it("has RLS enabled and forced on every events-side table", async () => {
    const rows = await sql`select relname, relrowsecurity as rls, relforcerowsecurity as forced from pg_class
      where relnamespace = 'public'::regnamespace and relname in ('events','event_content','metrics_minute','metrics_hourly','usage_daily','budget_usage')`;
    expect(rows).toHaveLength(6);
    for (const r of rows) expect([r.relname, r.rls, r.forced]).toEqual([r.relname, true, true]);
  });

  it("has partitions for the previous, current and next UTC month", async () => {
    const rows = await sql`select to_char(date_trunc('month', now() at time zone 'UTC') + make_interval(months => m), '"events_y"YYYY"m"MM') as name
      from generate_series(-1, 1) m`;
    for (const { name } of rows) {
      const [r] = await sql`select count(*)::int as n from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.events'::regclass and c.relname = ${name}`;
      expect(r.n, name).toBe(1);
    }
  });

  it("has partitions for the current UTC month and the next three (ingest never meets a missing one)", async () => {
    const rows = await sql`select to_char(date_trunc('month', now() at time zone 'UTC') + make_interval(months => m), '"events_y"YYYY"m"MM') as name
      from generate_series(0, 3) m`;
    expect(rows).toHaveLength(4);
    for (const { name } of rows) {
      const [r] = await sql`select count(*)::int as n from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.events'::regclass and c.relname = ${name}`;
      expect(r.n, name).toBe(1);
    }
  });

  it("accepts events at both edges of the +/- 24h window and in the last of the next three months", async () => {
    const edges = [new Date(Date.now() - 24 * 3600_000 + 60_000), new Date(Date.now() + 24 * 3600_000 - 60_000)];
    const now = new Date();
    const far = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 15)); // inside month +3
    for (const ts of [...edges, far]) {
      const [, rows] = await scoped(A.owner, [A.project], (t) => [
        t`insert into events (event_id, project_id, occurred_at) values (${randomUUID()}, ${A.project}, ${ts.toISOString()}) returning id`,
      ]);
      expect(rows, ts.toISOString()).toHaveLength(1);
    }
  });

  it("gives app_rw exactly the privileges the ingest statement needs", async () => {
    const priv = async (table: string, p: string) => (await sql`select has_table_privilege('app_rw', ${"public." + table}, ${p}) as ok`)[0].ok as boolean;
    for (const t of ["events", "event_content"]) for (const p of ["SELECT", "INSERT"]) expect(await priv(t, p), `${t} ${p}`).toBe(true);
    for (const t of ["metrics_minute", "metrics_hourly", "usage_daily", "budget_usage"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE"]) expect(await priv(t, p), `${t} ${p}`).toBe(true);
      expect(await priv(t, "DELETE"), `${t} DELETE`).toBe(false); // cleanup is a SECURITY DEFINER function (P2.11)
    }
    for (const t of ["budgets", "model_prices", "projects"]) expect(await priv(t, "SELECT"), t).toBe(true);
    const [col] = await sql`select has_column_privilege('app_rw', 'public.api_keys', 'last_used_at', 'UPDATE') as k,
      has_column_privilege('app_rw', 'public.projects', 'last_viewed_at', 'UPDATE') as v,
      has_column_privilege('app_rw', 'public.api_keys', 'key_hash', 'UPDATE') as h`;
    expect(col).toEqual({ k: true, v: true, h: false });
    const cols = await sql`select column_name from information_schema.columns where table_schema = 'public' and
      ((table_name = 'usage_daily' and column_name = 'requests') or (table_name = 'projects' and column_name = 'last_viewed_at'))`;
    expect(cols).toHaveLength(2);
  });

  it("fails closed: no scope means zero rows in every table", async () => {
    const res = await sql.transaction((t) => TABLES.map((n) => t.query(`select count(*)::int as n from ${n}`)));
    for (const r of res) expect(r[0].n).toBe(0);
  });

  it("scoped to A sees only A's rows in every table", async () => {
    const [, ...res] = await scoped(A.owner, [A.project], (t) => TABLES.map((n) => t.query(`select distinct project_id from ${n}`)));
    for (const [i, rows] of res.entries()) expect(rows.map((r) => r.project_id), TABLES[i]).toEqual([A.project]);
  });

  it("rejects writes for B's project while scoped to A", async () => {
    const attempts: Array<(t: T) => NeonQueryInTransaction> = [
      (t) => t`insert into events (event_id, project_id, occurred_at) values (${randomUUID()}, ${B.project}, ${now})`,
      (t) => t`insert into event_content (event_id, project_id, expires_at) values (${randomUUID()}, ${B.project}, now())`,
      (t) => t`insert into metrics_minute (project_id, bucket, model) values (${B.project}, now(), 'x')`,
      (t) => t`insert into usage_daily (project_id, day) values (${B.project}, current_date - 1)`,
      (t) => t`insert into budget_usage (project_id, budget_id, period_key) values (${B.project}, ${B.budget}, 'k')`,
    ];
    for (const a of attempts) await expect(scoped(A.owner, [A.project], (t) => [a(t)])).rejects.toThrow(/row-level security/i);
  });

  it("is idempotent: the same (project, event_id, occurred_at) inserts once", async () => {
    const eid = randomUUID();
    const ts = new Date().toISOString();
    const ins = (t: T) => t`insert into events (event_id, project_id, occurred_at) values (${eid}, ${A.project}, ${ts}) on conflict (project_id, event_id, occurred_at) do nothing returning id`;
    const [, first] = await scoped(A.owner, [A.project], (t) => [ins(t)]);
    const [, second] = await scoped(A.owner, [A.project], (t) => [ins(t)]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const [, rows] = await scoped(A.owner, [A.project], (t) => [t`select id from events where event_id = ${eid}`]);
    expect(rows).toHaveLength(1);
  });

  it("upserts rollups with ON CONFLICT DO UPDATE", async () => {
    const bucket = new Date(Math.floor(Date.now() / 60000) * 60000 + 60000 * 5).toISOString();
    const up = (t: T) => t`insert into metrics_minute (project_id, bucket, model, calls, cost_micro) values (${A.project}, ${bucket}, 'm', 1, 10)
      on conflict (project_id, bucket, model, shard) do update set calls = metrics_minute.calls + 1, cost_micro = metrics_minute.cost_micro + 10`;
    await scoped(A.owner, [A.project], (t) => [up(t)]);
    await scoped(A.owner, [A.project], (t) => [up(t)]);
    const [, rows] = await scoped(A.owner, [A.project], (t) => [t`select calls, cost_micro from metrics_minute where bucket = ${bucket}`]);
    // int4 comes back as a number, but bigint (int8) comes back as a string from the Neon driver.
    expect(rows).toEqual([{ calls: 2, cost_micro: "20" }]);
  });

  it("rejects an event outside every partition", async () => {
    await expect(
      scoped(A.owner, [A.project], (t) => [t`insert into events (event_id, project_id, occurred_at) values (${randomUUID()}, ${A.project}, '2001-01-01T00:00:00Z')`]),
    ).rejects.toThrow(/no partition/i);
  });

  it("gives app_rw no UPDATE/DELETE on events and no privilege on any partition", async () => {
    const [p] = await sql`select has_table_privilege('app_rw','events','UPDATE') as u, has_table_privilege('app_rw','events','DELETE') as d,
      has_table_privilege('app_rw','events','SELECT') as s, has_table_privilege('app_rw','events','INSERT') as i`;
    expect(p).toEqual({ u: false, d: false, s: true, i: true });
    const parts = await sql`select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.events'::regclass`;
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const { relname } of parts) {
      const [r] = await sql`select has_table_privilege('app_rw', ${"public." + relname}, 'SELECT') as s, has_table_privilege('app_rw', ${"public." + relname}, 'INSERT') as i`;
      expect(r, relname).toEqual({ s: false, i: false });
    }
  });

  describe("partition management functions", () => {
    it("ensure_event_partitions is idempotent and validates input", async () => {
      const [r1] = await sql`select ensure_event_partitions((date_trunc('month', now()) - interval '1 month')::date, 3) as n`;
      expect(r1.n).toBe(0);
      await expect(sql`select ensure_event_partitions('1999-01-01', 1)`).rejects.toThrow(/out of range/i);
      await expect(sql`select ensure_event_partitions(current_date, 0)`).rejects.toThrow(/months must be/i);
      await expect(sql`select ensure_event_partitions(current_date, 25)`).rejects.toThrow(/months must be/i);
    });

    it("drop_old_event_partitions takes no argument, so a caller cannot choose the retention", async () => {
      const procs = await sql`select pronargs::int as n from pg_proc where proname = 'drop_old_event_partitions' and pronamespace = 'public'::regnamespace`;
      expect(procs).toEqual([{ n: 0 }]);
      await expect(sql`select drop_old_event_partitions(0)`).rejects.toThrow(/does not exist/i);
      await expect(sql`select drop_old_event_partitions(1)`).rejects.toThrow(/does not exist/i);
    });

    it("drop_old_event_partitions drops partitions past the 14-day cutoff and never a newer one", async () => {
      // Every partition whose upper bound is still inside the retention window must survive.
      const protectedBefore = await sql`
        select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'public.events'::regclass
          and substring(pg_get_expr(c.relpartbound, c.oid) from 'TO \\(''([^'']+)''\\)')::timestamptz > now() - interval '14 days'`;
      expect(protectedBefore.length).toBeGreaterThanOrEqual(2); // current + next month at least

      const [made] = await sql`select ensure_event_partitions('2001-01-01', 1) as n`;
      expect(made.n).toBe(1);
      const [d] = await sql`select drop_old_event_partitions() as n`;
      expect(d.n).toBeGreaterThanOrEqual(1);
      const [old] = await sql`select to_regclass('public.events_y2001m01') as r`;
      expect(old.r).toBeNull();

      for (const { relname } of protectedBefore) {
        const [r] = await sql`select to_regclass(${"public." + relname}) as r`;
        expect(r.r, `${relname} must survive`).not.toBeNull();
      }
      // Calling it again is a no-op for protected partitions.
      await sql`select drop_old_event_partitions()`;
      const [cur] = await sql`select to_regclass(to_char(now() at time zone 'UTC', '"public.events_y"YYYY"m"MM')) as r`;
      expect(cur.r).not.toBeNull();
      // Restore last month if the policy legitimately dropped it, so later tests and runs stay valid.
      await sql`select ensure_event_partitions((date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date, 5)`;
    });
  });

  it("hard-deleting a project removes its events, content, rollups and usage", async () => {
    const x = mk();
    await seed(x);
    await scoped(x.owner, [x.project], (t) => [t`delete from projects where id = ${x.project}`]);
    const [, ...res] = await scoped(x.owner, [x.project], (t) => TABLES.map((n) => t.query(`select count(*)::int as n from ${n}`)));
    for (const r of res) expect(r[0].n).toBe(0);
  });
});
