// EXPLAIN (ANALYZE, BUFFERS) of the listTraces statement for one project: the first page and a deep page.
//
//   node --env-file=.env.local scripts/explain-traces.mjs --project <uuid> [--limit 50] [--deep-percent 80] [--status error]
//
// Runs as app_rw (DATABASE_URL) in a transaction scoped to that one project, like the app. The statement text is the one in
// lib/repo/traces.ts (scripts/traces-explain-sql.mjs; a test fails when they differ), with the same bound parameters, so the
// planner sees what it sees in production. EXPLAIN ANALYZE really executes the statement; it only reads. The script also
// times the plain statement (round trip included) so the numbers can be compared. Never prints the connection string.
import { neon } from "@neondatabase/serverless";
import { configureLocalNeon } from "../db/neon-local.mjs";
import { LIST_SQL, listParams, listWindow } from "./traces-explain-sql.mjs";

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
for (const k of flags.keys()) if (!["--project", "--limit", "--deep-percent", "--status"].includes(k)) fail(`unknown argument ${k}`);
const pid = (flags.get("--project") ?? "").toLowerCase();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pid)) fail("--project <uuid> is required");
const limit = Math.min(Math.max(Number(flags.get("--limit") ?? 50) || 50, 1), 100);
const deepPercent = Math.min(Math.max(Number(flags.get("--deep-percent") ?? 80) || 80, 1), 99);
const status = flags.get("--status") ?? null;
if (status !== null && status !== "ok" && status !== "error") fail("--status must be ok or error");
if (!process.env.DATABASE_URL) fail("Missing environment variable: DATABASE_URL (run with node --env-file=.env.local)");
configureLocalNeon(process.env.DATABASE_URL);
const sql = neon(process.env.DATABASE_URL);

const { fromMs, toMs } = listWindow(Date.now());
const scoped = (build) => sql.transaction((t) => [t`select set_config('app.owner_id', '', true), set_config('app.project_ids', ${pid}, true)`, ...build(t)]);
const brief = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 300);

// The deep cursor: the start of the trace at `deepPercent` of the list (by position), found with one plain query.
let deep;
try {
  const [, r] = await scoped((t) => [
    t`with a as (
        select trace_id, min(occurred_at) as start_at from events
         where project_id = ${pid}::uuid and occurred_at >= ${new Date(fromMs).toISOString()}::timestamptz and occurred_at < ${new Date(toMs).toISOString()}::timestamptz and trace_id is not null
         group by trace_id
      ), n as (select count(*)::int as c from a)
      select (select c from n) as traces,
             to_char(x.start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as start_text, x.trace_id
        from (select * from a order by start_at desc, trace_id desc offset (select (c * ${deepPercent})::int / 100 from n) limit 1) x`,
  ]);
  deep = r[0] ?? null;
} catch (e) {
  fail(`Could not find a deep cursor: ${brief(e)}`);
}
if (!deep) fail("No traces in the last 14 days for this project (seed it first, or the project id is wrong).");
console.log(`Project has ${deep.traces} traces in the window; the deep page starts at ${deepPercent}% (${deep.start_text}).`);

const cases = [
  { label: "FIRST PAGE", cursor: null, repeat: 2 }, // the second run is the warm one
  { label: `DEEP PAGE (${deepPercent}%)`, cursor: { start: deep.start_text, traceId: deep.trace_id }, repeat: 2 },
];
for (const c of cases) {
  const params = listParams({ projectId: pid, fromMs, toMs, cursor: c.cursor, status, limit });
  for (let run = 1; run <= c.repeat; run++) {
    const t0 = performance.now();
    let plain;
    try {
      [, plain] = await scoped((t) => [t.query(LIST_SQL, params)]);
    } catch (e) {
      fail(`${c.label}: statement failed: ${brief(e)}`);
    }
    const roundTripMs = performance.now() - t0;
    let plan;
    try {
      [, plan] = await scoped((t) => [t.query(`explain (analyze, buffers) ${LIST_SQL}`, params)]);
    } catch (e) {
      fail(`${c.label}: explain failed: ${brief(e)}`);
    }
    console.log(`\n===== ${c.label}, run ${run}${run === 1 ? " (cold-ish)" : " (warm)"}: ${plain.length} row(s) returned (truncated=${plain[0]?.truncated}, scanned=${plain[0]?.scanned}); round trip of the plain statement ${roundTripMs.toFixed(0)} ms =====`);
    if (run === c.repeat) for (const line of plan) console.log(line["QUERY PLAN"]);
  }
}
console.log("\nRead: 'Execution Time' (server), 'Buffers: shared hit/read' (pages), the scan node (want Index Scan on events_*_project_time_idx under an Append with 'Subplans Removed'), and 'rows=' of the scan against the cap 30,600.");
