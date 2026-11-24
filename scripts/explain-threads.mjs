// EXPLAIN (ANALYZE, BUFFERS) of the listThreads statement (first page and a deep page) and of the getThread statement
// (the busiest thread and a small one) for one project.
//
//   node --env-file=.env.local scripts/explain-threads.mjs --project <uuid> [--limit 50] [--deep-percent 80]
//
// Runs as app_rw (DATABASE_URL) in a transaction scoped to that one project, like the app. The statement texts are the ones in
// lib/repo/threads.ts and lib/repo/thread-detail.ts (scripts/threads-explain-sql.mjs; a test fails when they differ), with the
// same bound parameters. EXPLAIN ANALYZE really executes the statement; it only reads. Never prints the connection string,
// and only prints thread ids as sent by the owner's own SDK (they are the owner's data, shown to the owner).
import { neon } from "@neondatabase/serverless";
import { configureLocalNeon } from "../db/neon-local.mjs";
import { DETAIL_SQL, LIST_SQL, detailParams, detailWindow, listParams, listWindow } from "./threads-explain-sql.mjs";

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const flags = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) fail(`unexpected argument ${argv[i]}`);
  const [k, inline] = argv[i].split(/=(.*)/s);
  flags.set(k, inline ?? argv[++i]);
}
for (const k of flags.keys()) if (!["--project", "--limit", "--deep-percent"].includes(k)) fail(`unknown argument ${k}`);
const pid = (flags.get("--project") ?? "").toLowerCase();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pid)) fail("--project <uuid> is required");
const limit = Math.min(Math.max(Number(flags.get("--limit") ?? 50) || 50, 1), 100);
const deepPercent = Math.min(Math.max(Number(flags.get("--deep-percent") ?? 80) || 80, 1), 99);
if (!process.env.DATABASE_URL) fail("Missing environment variable: DATABASE_URL (run with node --env-file=.env.local)");
configureLocalNeon(process.env.DATABASE_URL);
const sql = neon(process.env.DATABASE_URL);

const lw = listWindow(Date.now());
const dw = detailWindow(Date.now());
const scoped = (build) => sql.transaction((t) => [t`select set_config('app.owner_id', '', true), set_config('app.project_ids', ${pid}, true)`, ...build(t)]);
const brief = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 300);

// Test data to aim at, found with plain queries: the deep cursor of the list, the busiest and the smallest thread.
let deep, busiest, smallest;
try {
  const [, r] = await scoped((t) => [
    t`with a as (
        select thread_id, max(occurred_at) as last_at, count(*)::int as n from events
         where project_id = ${pid}::uuid and occurred_at >= ${new Date(lw.fromMs).toISOString()}::timestamptz and occurred_at < ${new Date(lw.toMs).toISOString()}::timestamptz and thread_id is not null
         group by thread_id
      ), c as (select count(*)::int as c from a)
      select (select c from c) as threads,
             to_char(x.last_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_text, x.thread_id
        from (select * from a order by last_at desc, thread_id desc offset (select (c * ${deepPercent})::int / 100 from c) limit 1) x`,
  ]);
  deep = r[0] ?? null;
  const [, b] = await scoped((t) => [
    t`select thread_id, count(*)::int as n from events
       where project_id = ${pid}::uuid and occurred_at >= ${new Date(lw.fromMs).toISOString()}::timestamptz and occurred_at < ${new Date(lw.toMs).toISOString()}::timestamptz and thread_id is not null
       group by thread_id order by n desc, thread_id desc limit 1`,
  ]);
  busiest = b[0] ?? null;
  const [, s] = await scoped((t) => [
    t`select thread_id, count(*)::int as n from events
       where project_id = ${pid}::uuid and occurred_at >= ${new Date(lw.fromMs).toISOString()}::timestamptz and occurred_at < ${new Date(lw.toMs).toISOString()}::timestamptz and thread_id is not null
       group by thread_id order by n asc, thread_id asc limit 1`,
  ]);
  smallest = s[0] ?? null;
} catch (e) {
  fail(`Could not find test data: ${brief(e)}`);
}
if (!deep || !busiest || !smallest) {
  fail("No events with a thread id in the last 14 days for this project. Seed it first (scripts/seed-perf.mjs gives about 40% of events a thread id), or the project id is wrong.");
}
console.log(`Project has ${deep.threads} threads in the window; deep page at ${deepPercent}%; busiest thread has ${busiest.n} events, smallest ${smallest.n}.`);

const cases = [
  { label: "LIST, FIRST PAGE", text: LIST_SQL, params: listParams({ projectId: pid, fromMs: lw.fromMs, toMs: lw.toMs, limit }) },
  { label: `LIST, DEEP PAGE (${deepPercent}%)`, text: LIST_SQL, params: listParams({ projectId: pid, fromMs: lw.fromMs, toMs: lw.toMs, limit, cursor: { lastActive: deep.last_text, threadId: deep.thread_id } }) },
  { label: `DETAIL, BUSIEST THREAD (${busiest.n} events)`, text: DETAIL_SQL, params: detailParams({ projectId: pid, threadId: busiest.thread_id, fromMs: dw.fromMs, toMs: dw.toMs }) },
  { label: `DETAIL, SMALLEST THREAD (${smallest.n} events)`, text: DETAIL_SQL, params: detailParams({ projectId: pid, threadId: smallest.thread_id, fromMs: dw.fromMs, toMs: dw.toMs }) },
];
for (const c of cases) {
  for (let run = 1; run <= 2; run++) {
    const t0 = performance.now();
    let plain;
    try {
      [, plain] = await scoped((t) => [t.query(c.text, c.params)]);
    } catch (e) {
      fail(`${c.label}: statement failed: ${brief(e)}`);
    }
    const roundTripMs = performance.now() - t0;
    let plan;
    try {
      [, plan] = await scoped((t) => [t.query(`explain (analyze, buffers) ${c.text}`, c.params)]);
    } catch (e) {
      fail(`${c.label}: explain failed: ${brief(e)}`);
    }
    console.log(`\n===== ${c.label}, run ${run}${run === 1 ? " (cold-ish)" : " (warm)"}: ${plain.length} row(s) (truncated=${plain[0]?.truncated}, scanned=${plain[0]?.scanned}); plain round trip ${roundTripMs.toFixed(0)} ms =====`);
    if (run === 2) for (const line of plan) console.log(line["QUERY PLAN"]);
  }
}
console.log("\nRead: 'Execution Time' (server), 'Buffers: shared hit/read', and the scan node. LIST: Index Scan on events_*_project_time_idx under an Append with 'Subplans Removed'. DETAIL: the (project_id, thread_id) partial index (events_*_project_thread_idx) or a bitmap on it, then a sort of that thread's rows only.");
