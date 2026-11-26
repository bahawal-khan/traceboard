// EXPLAIN (ANALYZE, BUFFERS) of the getLiveSince statement for one project, in four situations:
//   BASELINE   no cursor (first call of a page): must not touch the table at all
//   EMPTY      a cursor at the current horizon, nothing newer: the path every idle poll takes, must be the cheapest
//   TAIL       a cursor on the project's newest row (nothing newer, but its occurred_at window holds the recent rows): the
//              realistic idle poll of an ACTIVE project; cheap only with an index that starts (project_id, received_at)
//   BUSY       a cursor with --new rows (default 200) waiting
//   TRUNCATED  a cursor with more rows than the cap (needs enough rows in the project)
//
//   node --env-file=.env.local scripts/explain-live.mjs --project <uuid> [--new 200]
//
// Runs as app_rw (DATABASE_URL) in a transaction scoped to that one project, like the app. The statement text is the one in
// lib/repo/live.ts (scripts/live-explain-sql.mjs; a test fails when they differ), with the same bound parameters. EXPLAIN
// ANALYZE really executes the statement; it only reads. Never prints the connection string, trace ids or any event content: only
// row counts, timings and the plan.
import { neon } from "@neondatabase/serverless";
import { configureLocalNeon } from "../db/neon-local.mjs";
import { LIVE_SCAN_CAP, LIVE_SQL, liveParams } from "./live-explain-sql.mjs";

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
for (const k of flags.keys()) if (!["--project", "--new"].includes(k)) fail(`unknown argument ${k}`);
const pid = (flags.get("--project") ?? "").toLowerCase();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pid)) fail("--project <uuid> is required");
const busyNew = Math.min(Math.max(Math.floor(Number(flags.get("--new") ?? 200)) || 200, 1), LIVE_SCAN_CAP);
if (!process.env.DATABASE_URL) fail("Missing environment variable: DATABASE_URL (run with node --env-file=.env.local)");
configureLocalNeon(process.env.DATABASE_URL);
const sql = neon(process.env.DATABASE_URL);

const scoped = (build) => sql.transaction((t) => [t`select set_config('app.owner_id', '', true), set_config('app.project_ids', ${pid}, true)`, ...build(t)]);
const brief = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 300);
const TS_FMT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const MAX_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

// Cursors to aim at, found with plain read-only queries (the same ones a client would be holding):
//   horizon  = the database clock now, minus the settle lag (what an idle client holds)
//   nthNewest = the cursor that leaves exactly N rows newer (the Nth newest row by received_at, minus one)
let nowMs, horizonText, total;
const nth = new Map();
try {
  const [, c] = await scoped((t) => [
    t.query(`select floor(extract(epoch from now()) * 1000)::bigint::text as now_ms,
                    to_char((now() - interval '2 seconds') at time zone 'UTC', ${TS_FMT}) as horizon,
                    (select count(*) from events where project_id = $1::uuid)::int as total`, [pid]),
  ]);
  nowMs = Number(c[0].now_ms);
  horizonText = c[0].horizon;
  total = c[0].total;
  // TAIL: the cursor sits ON the project's newest row (n = 0 gives the newest by received_at), so nothing is newer, and the
  // occurred_at window (cursor - 25 h .. now + 25 h) contains the project's most recent rows. On an active project this is the
  // realistic idle poll; on seed data the plain EMPTY case is trivial because the seed rows are older than its window.
  for (const n of [0, busyNew, LIVE_SCAN_CAP + 50]) {
    const [, r] = await scoped((t) => [
      t.query(`select to_char(received_at at time zone 'UTC', ${TS_FMT}) as ts, id::text as id,
                      floor(extract(epoch from received_at) * 1000)::bigint::text as ms
                 from events where project_id = $1::uuid
                order by received_at desc, id desc offset $2::int limit 1`, [pid, n]),
    ]);
    // The cursor sits ON the (n+1)th newest row, so exactly n rows are newer.
    nth.set(n, r[0] ? { receivedAt: r[0].ts, id: r[0].id, ms: Number(r[0].ms) } : null);
  }
} catch (e) {
  fail(`Could not find test data: ${brief(e)}`);
}
if (total === 0) fail("This project has no events. Seed it first (scripts/seed-perf.mjs), or the project id is wrong.");
console.log(`Project has ${total} events (any age). Busy cursor leaves ${busyNew} newer rows; truncated cursor leaves ${LIVE_SCAN_CAP + 50} (cap is ${LIVE_SCAN_CAP}).`);
console.log("NOTE: seeded rows have received_at = occurred_at + 1 s, spread over 14 days, so a busy cursor here is OLDER than the 15 minute lookback the app enforces; the statement itself does not care, which is what is measured.");

const cases = [
  { label: "BASELINE (no cursor)", params: liveParams({ projectId: pid, nowMs, cursor: null }) },
  { label: "EMPTY (cursor at the horizon)", params: liveParams({ projectId: pid, nowMs, cursor: { receivedAt: horizonText, id: MAX_ID, ms: nowMs - 2000 } }) },
  { label: "TAIL (cursor at the project's newest received_at: empty answer, window full of the project's recent rows)", params: nth.get(0) ? liveParams({ projectId: pid, nowMs, cursor: nth.get(0) }) : null },
  { label: `BUSY (${busyNew} new rows)`, params: nth.get(busyNew) ? liveParams({ projectId: pid, nowMs, cursor: nth.get(busyNew) }) : null },
  { label: `TRUNCATED (${LIVE_SCAN_CAP + 50} new rows, cap ${LIVE_SCAN_CAP})`, params: nth.get(LIVE_SCAN_CAP + 50) ? liveParams({ projectId: pid, nowMs, cursor: nth.get(LIVE_SCAN_CAP + 50) }) : null },
];
for (const c of cases) {
  if (!c.params) {
    console.log(`\n===== ${c.label}: skipped (the project has too few events for this case) =====`);
    continue;
  }
  for (let run = 1; run <= 2; run++) {
    const t0 = performance.now();
    let plain;
    try {
      [, plain] = await scoped((t) => [t.query(LIVE_SQL, c.params)]);
    } catch (e) {
      fail(`${c.label}: statement failed: ${brief(e)}`);
    }
    const roundTripMs = performance.now() - t0;
    let plan;
    try {
      [, plan] = await scoped((t) => [t.query(`explain (analyze, buffers) ${LIVE_SQL}`, c.params)]);
    } catch (e) {
      fail(`${c.label}: explain failed: ${brief(e)}`);
    }
    const h = plain[0];
    console.log(`\n===== ${c.label}, run ${run}${run === 1 ? " (cold-ish)" : " (warm)"}: new_events=${h?.ev_count} new_errors=${h?.err_count} new_traces=${h?.trace_count} truncated=${h?.truncated} trace_rows=${plain.filter((r) => r.trace_id).length}; plain round trip ${roundTripMs.toFixed(0)} ms =====`);
    if (run === 2) for (const line of plan) console.log(line["QUERY PLAN"]);
  }
}
console.log("\nRead: 'Execution Time' (server), 'Buffers: shared hit/read', and the scan node on `fresh`. BASELINE must show a One-Time Filter: false and no scan. EMPTY: ideally an Index Scan on events_*_project_received_idx returning 0 rows (TAIL too, with a Limit and no Sort); WITHOUT such an index the plan is an Index Scan on events_*_project_time_idx over the whole occurred_at range with 'Rows Removed by Filter' (every project row in about 48 h is fetched from the heap just to be thrown away), plus a Sort.");
