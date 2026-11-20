import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminSql, ensureEventPartitions, jobSql } from "./helpers/job-role";

/**
 * The daily-job SQL (migration 0011): expiry, batching, idempotence, cross-tenant cleanup, and the role split.
 * Fixture rows are created as app_rw under RLS (like the product does); the functions run as app_job; reads go back through app_rw.
 * Skipped without DATABASE_URL; needs JOB_DATABASE_URL (app_job) and, for two partition tests, MIGRATION_DATABASE_URL.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

const DESTRUCTIVE = [
  "event_partition_is_droppable(timestamptz, timestamptz)",
  "drop_old_event_partitions()",
  "ensure_event_partitions(date, integer)",
  "job_ensure_partitions()",
  "events_partition_health()",
  "purge_expired_events(integer, timestamptz)",
  "purge_expired_content(integer)",
  "purge_orphaned_content(integer)",
  "purge_rollups(integer)",
  "storage_report()",
];
const TENANT_TABLES = ["events", "event_content", "metrics_minute", "metrics_hourly", "usage_daily", "budget_usage"] as const;

run("daily job functions (database)", () => {
  const sql = neon(url!); // app_rw
  const job = jobSql(); // app_job
  const mk = () => ({ owner: `test_${randomUUID()}`, project: randomUUID() as string, day: randomUUID() as string, month: randomUUID() as string, run: randomUUID() as string });
  const A = mk();
  const B = mk();
  const C = mk();
  const scoped = (x: { owner: string; project: string }, build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${x.owner}, true), set_config('app.project_ids', ${x.project}, true)`,
      ...build(t),
    ]);
  /** One scoped query as app_rw (what the tenant itself can see). */
  const q = async (x: { owner: string; project: string }, text: string, params: unknown[] = []) =>
    (await scoped(x, (t) => [t.query(text, params)]))[1] as Record<string, unknown>[];
  const n = async (x: { owner: string; project: string }, table: string, where = "true") => Number((await q(x, `select count(*)::int as n from ${table} where ${where}`))[0]!.n);

  /** Inserts events `interval` ago (an SQL interval text, so the database clock is the only clock involved). */
  const addEvents = (x: typeof A, ...ages: string[]) =>
    scoped(x, (t) => ages.map((age) => t.query("insert into events (event_id, project_id, trace_id, occurred_at) values ($1, $2, $3, now() - $4::interval)", [randomUUID(), x.project, `age:${age}`, age])));
  const addContent = (x: typeof A, eventId: string, expires: string) =>
    scoped(x, (t) => [t.query("insert into event_content (event_id, project_id, input_text, expires_at) values ($1, $2, 'x', now() + $3::interval)", [eventId, x.project, expires])]);
  const loop = async (fn: () => Promise<number>) => {
    for (let i = 0; i < 50; i++) if ((await fn()) === 0) return;
    throw new Error("cleanup did not converge");
  };
  const drainEvents = () => loop(async () => Number((await job`select purge_expired_events(50000) as n`)[0]!.n));
  const drainContent = () => loop(async () => Number((await job`select purge_expired_content(50000) as n`)[0]!.n));
  const drainOrphans = () => loop(async () => Number((await job`select purge_orphaned_content(50000) as n`)[0]!.n));
  const rollups = async (batch: number) => {
    const [r] = await job`select * from purge_rollups(${batch})`;
    return { minute: Number(r!.minute_rows), hourly: Number(r!.hourly_rows), budget: Number(r!.budget_rows), usage: Number(r!.usage_rows) };
  };
  const drainRollups = () => loop(async () => Object.values(await rollups(50000)).reduce((a, b) => a + b, 0));

  beforeAll(async () => {
    await ensureEventPartitions();
    for (const x of [A, B, C]) {
      await scoped(x, (t) => [
        t`insert into projects (id, owner_id, name) values (${x.project}, ${x.owner}, 'daily-job-test')`,
        t`insert into budgets (id, project_id, scope, period, limit_usd, action) values (${x.day}, ${x.project}, 'project', 'day', 1, 'alert')`,
        t`insert into budgets (id, project_id, scope, period, limit_usd, action) values (${x.month}, ${x.project}, 'project', 'month', 1, 'alert')`,
        t`insert into budgets (id, project_id, scope, period, limit_usd, action) values (${x.run}, ${x.project}, 'trace', 'run', 1, 'alert')`,
      ]);
    }
  });
  afterAll(async () => {
    for (const x of [A, B, C]) await scoped(x, (t) => [t`delete from projects where id = ${x.project}`]);
  });

  // ---- events -------------------------------------------------------------------------------------------------------
  describe("purge_expired_events", () => {
    it("deletes expired rows of every tenant, keeps fresh rows (even just inside the window), and touches nothing else", async () => {
      await drainEvents();
      await addEvents(A, "20 days", "16 days", "13 days 23 hours", "1 hour");
      await addEvents(B, "20 days", "15 days", "13 days 23 hours", "1 minute");
      await addEvents(C, "1 hour", "2 days");
      const [r] = await job`select purge_expired_events(1000) as n`;
      expect(Number(r!.n)).toBe(4); // two per tenant, and nothing else in the database was expired
      expect(await n(A, "events")).toBe(2);
      expect(await n(B, "events")).toBe(2);
      expect(await n(C, "events")).toBe(2);
      for (const x of [A, B, C]) expect(await n(x, "events", "occurred_at < now() - interval '14 days'")).toBe(0);
      expect(await n(A, "events", "trace_id in ('age:13 days 23 hours', 'age:1 hour')")).toBe(2);
    });

    it("is idempotent: a second run (and a third) changes nothing", async () => {
      expect(Number((await job`select purge_expired_events(1000) as n`)[0]!.n)).toBe(0);
      expect(Number((await job`select purge_expired_events(1000) as n`)[0]!.n)).toBe(0);
      expect(await n(A, "events")).toBe(2);
    });

    it("never deletes more than the batch, and finishes the job across calls", async () => {
      await addEvents(A, "20 days", "21 days", "22 days", "23 days", "24 days", "25 days", "26 days");
      const sizes = [] as number[];
      for (let i = 0; i < 4; i++) sizes.push(Number((await job`select purge_expired_events(3) as n`)[0]!.n));
      expect(sizes).toEqual([3, 3, 1, 0]);
      expect(await n(A, "events")).toBe(2); // the two fresh rows from the first test
    });

    it("the boundary is exactly 14 days: five minutes older goes, five minutes newer stays", async () => {
      await addEvents(A, "14 days 5 minutes", "13 days 23 hours 55 minutes");
      expect(Number((await job`select purge_expired_events(100) as n`)[0]!.n)).toBe(1);
      expect(await n(A, "events", "trace_id = 'age:13 days 23 hours 55 minutes'")).toBe(1);
    });

    it("rejects bad batch sizes", async () => {
      for (const b of [0, -1, 50001]) await expect(job`select purge_expired_events(${b})`, String(b)).rejects.toThrow(/batch must be between/i);
      await expect(job`select purge_expired_events(null)`).rejects.toThrow(/batch must be between/i);
    });

    it("a caller may only ask for an OLDER cutoff: anything inside the retention window raises, nothing is deleted", async () => {
      await addEvents(A, "16 days", "18 days");
      await expect(job`select purge_expired_events(100, now() - interval '13 days')`).rejects.toThrow(/inside the retention window/i);
      await expect(job`select purge_expired_events(100, now() + interval '1 day')`).rejects.toThrow(/inside the retention window/i);
      await expect(job`select purge_expired_events(100, now() - interval '14 days' + interval '1 minute')`).rejects.toThrow(/inside the retention window/i);
      expect(await n(A, "events", "trace_id in ('age:16 days', 'age:18 days')")).toBe(2);
      // an older cutoff deletes only what is older than it
      expect(Number((await job`select purge_expired_events(100, now() - interval '17 days') as n`)[0]!.n)).toBe(1);
      expect(await n(A, "events", "trace_id = 'age:16 days'")).toBe(1);
      expect(await n(A, "events", "trace_id = 'age:18 days'")).toBe(0);
      await drainEvents();
    });

    it("a run that is cut off halfway changes nothing, and the next run does the work", async () => {
      await addEvents(B, "20 days", "21 days");
      await expect(job.transaction((t) => [t`select purge_expired_events(100)`, t`select 1 / 0`])).rejects.toThrow(/division by zero/i);
      expect(await n(B, "events", "occurred_at < now() - interval '14 days'")).toBe(2); // rolled back as a whole
      expect(Number((await job`select purge_expired_events(100) as n`)[0]!.n)).toBe(2);
      expect(await n(B, "events", "occurred_at < now() - interval '14 days'")).toBe(0);
    });

    it("a tenant sees only its own rows, and the job role cannot read tenant tables at all", async () => {
      expect(await n(A, "events")).toBe(3); // 2 fresh + the 13h55m row
      await expect(job`select count(*) from events`).rejects.toThrow(/permission denied/i);
      await expect(job`select count(*) from event_content`).rejects.toThrow(/permission denied/i);
      await expect(job`delete from events`).rejects.toThrow(/permission denied/i);
      const [anon] = await sql`select count(*)::int as n from events`; // app_rw with no project context
      expect(anon!.n).toBe(0);
    });
  });

  // ---- partitions ---------------------------------------------------------------------------------------------------
  describe("partitions", () => {
    it("event_partition_is_droppable: 14 days AND never the current or next month, checked with synthetic clocks", async () => {
      const d = async (upper: string, now: string) => (await job`select event_partition_is_droppable(${upper}::timestamptz, ${now}::timestamptz) as ok`)[0]!.ok;
      expect(await d("2026-11-01 00:00+00", "2026-11-15 00:00:00+00")).toBe(true); // exactly 14 days after the month ended
      expect(await d("2026-11-01 00:00+00", "2026-11-14 23:59:59+00")).toBe(false); // one second short
      expect(await d("2026-12-01 00:00+00", "2026-11-21 00:00+00")).toBe(false); // the CURRENT month
      expect(await d("2027-01-01 00:00+00", "2026-11-21 00:00+00")).toBe(false); // the NEXT month
      expect(await d("2026-12-01 00:00+00", "2027-01-20 00:00+00")).toBe(true); // December, long over
      expect(await d("2027-02-01 00:00+00", "2027-01-20 00:00+00")).toBe(false); // January while it is January
      // The month guard on its own: a partition ending mid-month passes the 14-day test but must not be dropped.
      expect(await d("2026-11-05 00:00+00", "2026-11-20 00:00+00")).toBe(false);
    });

    it("drop_old_event_partitions drops an expired partition and never the current or next month", async () => {
      await job`select ensure_event_partitions('2001-01-01', 1)`;
      expect(Number((await job`select drop_old_event_partitions() as n`)[0]!.n)).toBeGreaterThanOrEqual(1);
      expect((await sql`select to_regclass('public.events_y2001m01') as r`)[0]!.r).toBeNull();
      const [h] = await job`select * from events_partition_health()`;
      expect([h!.current_exists, h!.next_exists]).toEqual([true, true]);
      expect(Number((await job`select drop_old_event_partitions() as n`)[0]!.n)).toBe(0); // idempotent
      await ensureEventPartitions(); // the previous month may have just aged out: restore it for later tests
    });

    it("the health check reports a missing next month, and job_ensure_partitions repairs it (current + next only)", async (ctx) => {
      const admin = adminSql();
      const [name] = await admin`select to_char(date_trunc('month', now() at time zone 'UTC') + interval '1 month', '"events_y"YYYY"m"MM') as p`;
      const part = String(name!.p);
      const [rows] = await admin.query(`select count(*)::int as n from public.${part}`);
      if (rows!.n > 0) return ctx.skip(); // never drop a partition that holds rows
      await admin.query(`alter table public.events detach partition public.${part}`);
      await admin.query(`drop table public.${part}`);
      try {
        const [broken] = await job`select * from events_partition_health()`;
        expect([broken!.current_exists, broken!.next_exists, broken!.next_partition]).toEqual([true, false, part]);
        expect(Number((await job`select job_ensure_partitions() as n`)[0]!.n)).toBe(1);
        const [fixed] = await job`select * from events_partition_health()`;
        expect([fixed!.current_exists, fixed!.next_exists]).toEqual([true, true]);
        expect(Number((await job`select job_ensure_partitions() as n`)[0]!.n)).toBe(0); // idempotent
      } finally {
        await ensureEventPartitions();
      }
    });
  });

  // ---- content ------------------------------------------------------------------------------------------------------
  describe("content", () => {
    it("purge_expired_content deletes expired rows of every tenant in bounded batches and nothing fresh", async () => {
      await drainContent();
      for (const e of [randomUUID(), randomUUID()]) await addContent(A, e, "-1 hour");
      await addContent(A, randomUUID(), "1 day");
      await addContent(B, randomUUID(), "-1 day");
      await addContent(B, randomUUID(), "1 day");
      expect(Number((await job`select purge_expired_content(2) as n`)[0]!.n)).toBe(2);
      expect(Number((await job`select purge_expired_content(2) as n`)[0]!.n)).toBe(1);
      expect(Number((await job`select purge_expired_content(2) as n`)[0]!.n)).toBe(0);
      expect(await n(A, "event_content")).toBe(1);
      expect(await n(B, "event_content")).toBe(1);
      await expect(job`select purge_expired_content(0)`).rejects.toThrow(/batch must be between/i);
    });

    it("purge_orphaned_content removes content whose event is gone, keeps content of a live event, and keys on the PROJECT too", async () => {
      await drainContent();
      await drainOrphans();
      const eventA = randomUUID();
      const eventB = randomUUID();
      await scoped(A, (t) => [t.query("insert into events (event_id, project_id, occurred_at) values ($1, $2, now())", [eventA, A.project])]);
      await scoped(B, (t) => [t.query("insert into events (event_id, project_id, occurred_at) values ($1, $2, now())", [eventB, B.project])]);
      await addContent(A, eventA, "1 day"); // live event: must stay (it would not if the events lookup were blind to RLS)
      await addContent(B, eventB, "1 day"); // live event of another tenant: stays
      await addContent(A, randomUUID(), "1 day"); // no event at all
      await addContent(A, eventB, "1 day"); // the id of ANOTHER tenant's event: not A's event
      expect(await n(A, "event_content")).toBe(3);
      expect(Number((await job`select purge_orphaned_content(1) as n`)[0]!.n)).toBe(1); // batch limit
      expect(Number((await job`select purge_orphaned_content(100) as n`)[0]!.n)).toBe(1);
      expect(Number((await job`select purge_orphaned_content(100) as n`)[0]!.n)).toBe(0);
      expect(await n(A, "event_content")).toBe(1);
      expect(await n(B, "event_content")).toBe(1);
      expect((await q(A, "select event_id from event_content"))[0]!.event_id).toBe(eventA);
    });

    it("content_slots_left: per project and UTC day, never below zero, and a tenant cannot read another's counter", async () => {
      const today = "(now() at time zone 'UTC')::date";
      await scoped(A, (t) => [t.query(`insert into usage_daily (project_id, day, content_rows) values ($1, ${today}, 150)`, [A.project])]);
      await scoped(B, (t) => [t.query(`insert into usage_daily (project_id, day, content_rows) values ($1, ${today}, 190)`, [B.project])]);
      const slots = async (x: typeof A, project: string, cap: number) => Number((await q(x, "select content_slots_left($1::uuid, $2::int) as s", [project, cap]))[0]!.s);
      expect(await slots(A, A.project, 200)).toBe(50);
      expect(await slots(A, A.project, 100)).toBe(0); // over the cap: zero, not negative
      expect(await slots(A, A.project, -5)).toBe(0);
      expect(await slots(C, C.project, 200)).toBe(200); // no row today
      expect(await slots(A, B.project, 200)).toBe(200); // A cannot see B's 190: RLS hides the row, the answer is the full cap
      await scoped(A, (t) => [t.query("update usage_daily set day = day - 1 where project_id = $1", [A.project])]); // yesterday does not count
      expect(await slots(A, A.project, 200)).toBe(200);
    });
  });

  // ---- rollups ------------------------------------------------------------------------------------------------------
  describe("purge_rollups", () => {
    const today = "(now() at time zone 'UTC')::date";
    const seedRollups = async (x: typeof A) => {
      const mon = (age: string, model: string) => `insert into metrics_minute (project_id, bucket, model, calls) values ($1, date_trunc('minute', now() - interval '${age}'), '${model}', 1)`;
      const hr = (age: string, model: string) => `insert into metrics_hourly (project_id, bucket, model, calls) values ($1, date_trunc('hour', now() - interval '${age}'), '${model}', 1)`;
      const bu = (budget: string, key: string) => `insert into budget_usage (project_id, budget_id, period_key, spent_micro) values ($1, '${budget}', ${key}, 5)`;
      const month = (ago: number) => `to_char(date_trunc('month', now() at time zone 'UTC') - interval '${ago} months', 'YYYY-MM')`;
      const dayKey = (ago: number) => `to_char(${today} - ${ago}, 'YYYY-MM-DD')`;
      const stmts = [
        mon("49 hours", "old"), mon("47 hours", "new"),
        hr("91 days", "old"), hr("89 days", "new"),
        bu(x.day, `'2020-01-01'`), bu(x.day, dayKey(8)), bu(x.day, dayKey(6)), bu(x.day, dayKey(0)),
        bu(x.month, `'2020-01'`), bu(x.month, month(3)), bu(x.month, month(2)), bu(x.month, month(0)),
        bu(x.run, `'2020-01-01'`), bu(x.run, `'trace-abc'`), // run-scoped keys carry no date: kept
      ];
      await scoped(x, (t) => [
        ...stmts.map((s) => t.query(s, [x.project])),
        t.query(`insert into usage_daily (project_id, day, events) values ($1, ${today} - 401, 1), ($1, ${today} - 399, 1), ($1, ${today} - 5, 1)`, [x.project]),
      ]);
    };

    it("ages out minute (48 h), hourly (90 d), budget keys (7 d / 2 months) and usage rows (400 d), for every tenant at once", async () => {
      await drainRollups();
      for (const x of [A, B, C]) await seedRollups(x);
      const r = await rollups(1000);
      expect(r).toEqual({ minute: 3, hourly: 3, budget: 12, usage: 3 }); // per tenant: 1, 1, (2 day + 2 month), 1
      for (const x of [A, B, C]) {
        expect(await n(x, "metrics_minute"), "minute").toBe(1);
        expect(await n(x, "metrics_hourly"), "hourly").toBe(1);
        expect(await n(x, "usage_daily", "day < (now() at time zone 'UTC')::date - 400"), "usage older than 400 days").toBe(0);
        expect(await n(x, "usage_daily", "day in ((now() at time zone 'UTC')::date - 399, (now() at time zone 'UTC')::date - 5)"), "usage inside the window").toBe(2);
        const keys = (await q(x, "select b.period, bu.period_key from budget_usage bu join budgets b on b.id = bu.budget_id order by 1, 2")).map((k) => `${k.period}:${k.period_key}`);
        expect(keys.filter((k) => k.startsWith("run:")).sort()).toEqual(["run:2020-01-01", "run:trace-abc"]); // untouched
        expect(keys.filter((k) => k.startsWith("day:"))).toHaveLength(2); // today and 6 days ago
        expect(keys.filter((k) => k.startsWith("month:"))).toHaveLength(2); // this month and two months ago
        expect(keys.some((k) => k.includes("2020-01-01") && k.startsWith("day:"))).toBe(false);
        expect(keys.some((k) => k === "month:2020-01")).toBe(false);
      }
    });

    it("is idempotent, and respects the batch limit per table", async () => {
      expect(await rollups(1000)).toEqual({ minute: 0, hourly: 0, budget: 0, usage: 0 });
      await scoped(A, (t) => Array.from({ length: 5 }, (_, i) => t.query(`insert into metrics_minute (project_id, bucket, model, calls) values ($1, now() - interval '50 hours', 'm${i}', 1)`, [A.project])));
      const sizes = [] as number[];
      for (let i = 0; i < 4; i++) sizes.push((await rollups(2)).minute);
      expect(sizes).toEqual([2, 2, 1, 0]);
      await expect(job`select * from purge_rollups(0)`).rejects.toThrow(/batch must be between/i);
    });
  });

  // ---- storage guard ------------------------------------------------------------------------------------------------
  describe("storage_report", () => {
    it("reports database and event sizes against the 600 MB events budget", async () => {
      const [r] = await job`select * from storage_report()`;
      expect(Number(r!.events_budget_bytes)).toBe(600_000_000);
      expect(Number(r!.database_bytes)).toBeGreaterThan(1_000_000);
      expect(Number(r!.events_bytes)).toBeGreaterThan(0);
      expect(Number(r!.content_bytes)).toBeGreaterThan(0);
      expect(Number(r!.rollup_bytes)).toBeGreaterThan(0);
      expect(Number(r!.events_ratio)).toBeCloseTo(Number(r!.events_bytes) / 600_000_000, 3);
      const [cur] = await sql`select pg_total_relation_size(to_regclass(to_char(now() at time zone 'UTC', '"public.events_y"YYYY"m"MM'))) as s`;
      expect(Number(r!.events_bytes)).toBeGreaterThanOrEqual(Number(cur!.s)); // the sum covers every partition, not one
    });
  });

  // ---- who may call what --------------------------------------------------------------------------------------------
  describe("permissions", () => {
    it("every job function: EXECUTE for app_job only (not app_rw, not PUBLIC), definer functions run as the owner with a pinned search_path", async () => {
      for (const sig of DESTRUCTIVE) {
        const [p] = await sql`
          select has_function_privilege('app_rw', ${"public." + sig}, 'EXECUTE') as rw,
                 has_function_privilege('app_job', ${"public." + sig}, 'EXECUTE') as job,
                 coalesce(proacl::text, '') as acl, prosecdef, coalesce(proconfig::text, '') as config, pg_get_userbyid(proowner) as owner
            from pg_proc where oid = ${"public." + sig}::regprocedure`;
        expect([sig, p!.rw, p!.job], sig).toEqual([sig, false, true]);
        expect(p!.acl, `${sig} must not be granted to PUBLIC`).not.toMatch(/(^\{|,)=X\//);
        expect(p!.owner).toBe("migrator");
        expect(p!.config, `${sig}: search_path must be pinned`).toContain("search_path=pg_catalog, public");
        if (!sig.startsWith("event_partition_is_droppable")) expect(p!.prosecdef, `${sig} must be SECURITY DEFINER`).toBe(true);
      }
    });

    it("app_rw is refused when it calls any of them", async () => {
      await expect(sql`select purge_expired_events(10)`).rejects.toThrow(/permission denied/i);
      await expect(sql`select purge_expired_events(10, now() - interval '30 days')`).rejects.toThrow(/permission denied/i);
      await expect(sql`select purge_expired_content(10)`).rejects.toThrow(/permission denied/i);
      await expect(sql`select purge_orphaned_content(10)`).rejects.toThrow(/permission denied/i);
      await expect(sql`select * from purge_rollups(10)`).rejects.toThrow(/permission denied/i);
      await expect(sql`select drop_old_event_partitions()`).rejects.toThrow(/permission denied/i);
      await expect(sql`select ensure_event_partitions(current_date, 1)`).rejects.toThrow(/permission denied/i);
      await expect(sql`select job_ensure_partitions()`).rejects.toThrow(/permission denied/i);
      await expect(sql`select * from events_partition_health()`).rejects.toThrow(/permission denied/i);
      await expect(sql`select * from storage_report()`).rejects.toThrow(/permission denied/i);
    });

    it("content_slots_left is the one tenant-path helper: app_rw yes (invoker rights), app_job no, PUBLIC no", async () => {
      const [p] = await sql`
        select has_function_privilege('app_rw', 'public.content_slots_left(uuid, integer)', 'EXECUTE') as rw,
               has_function_privilege('app_job', 'public.content_slots_left(uuid, integer)', 'EXECUTE') as job,
               prosecdef, coalesce(proacl::text, '') as acl
          from pg_proc where oid = 'public.content_slots_left(uuid, integer)'::regprocedure`;
      expect([p!.rw, p!.job, p!.prosecdef]).toEqual([true, false, false]);
      expect(p!.acl).not.toMatch(/(^\{|,)=X\//);
    });

    it("app_job is a plain role that owns nothing and has no table privileges except on app_state", async () => {
      const [r] = await sql`select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin from pg_roles where rolname = 'app_job'`;
      expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolcanlogin: true });
      const [owned] = await sql`select count(*)::int as n from pg_class where relowner = 'app_job'::regrole`;
      expect(owned!.n).toBe(0);
      const grid = await sql`
        select c.relname as name, p.priv, has_table_privilege('app_job', c.oid, p.priv) as ok
          from pg_class c cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
         where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition`;
      expect(new Set(grid.map((g) => g.name)).size).toBeGreaterThanOrEqual(15);
      for (const g of grid) {
        const allowed = g.name === "app_state" && ["SELECT", "INSERT", "UPDATE"].includes(g.priv);
        expect(g.ok, `app_job ${g.priv} on ${g.name}`).toBe(allowed);
      }
      await expect(job`create table nope (id int)`).rejects.toThrow(/permission denied/i);
      await expect(job`select 1 from app_users limit 1`).rejects.toThrow(/permission denied/i);
    });

    it("the maintenance policies exist for the migrator role only, never for app_rw or PUBLIC", async () => {
      const rows = await sql`select tablename, policyname, cmd, roles::text as roles from pg_policies where policyname like 'maintenance_%' order by 1, 2`;
      expect(rows.filter((r) => r.cmd === "SELECT").map((r) => r.tablename).sort()).toEqual(["budget_usage", "budgets", "event_content", "events", "metrics_hourly", "metrics_minute", "usage_daily"]);
      expect(rows.filter((r) => r.cmd === "DELETE").map((r) => r.tablename).sort()).toEqual(["budget_usage", "event_content", "metrics_hourly", "metrics_minute", "usage_daily"]);
      for (const r of rows) expect(r.roles, `${r.tablename}.${r.policyname}`).toBe("{migrator}");
    });

    it("RLS is still forced on every events-side table and app_rw still has no DELETE on events or the rollups", async () => {
      for (const t of TENANT_TABLES) {
        const [r] = await sql`select relrowsecurity as rls, relforcerowsecurity as forced from pg_class where oid = ${"public." + t}::regclass`;
        expect([t, r!.rls, r!.forced]).toEqual([t, true, true]);
      }
      for (const t of ["events", "metrics_minute", "metrics_hourly", "usage_daily", "budget_usage"]) {
        const [h] = await sql`select has_table_privilege('app_rw', ${"public." + t}, 'DELETE') as d`;
        expect(h!.d, `app_rw DELETE on ${t}`).toBe(false);
      }
    });
  });
});
