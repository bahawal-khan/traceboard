// Seeds ONE project with realistic trace data to measure listTraces, or removes exactly what it seeded.
//
//   node --env-file=.env.local scripts/seed-perf.mjs --project <uuid> [--rows 30000] [--dry-run]
//   node --env-file=.env.local scripts/seed-perf.mjs --project <uuid> --analyze      # refresh planner statistics (migrator)
//   node --env-file=.env.local scripts/seed-perf.mjs --project <uuid> --cleanup
//
// Roles (nothing is granted or changed): the seed runs as app_rw (DATABASE_URL) through the tenant policy, exactly like
// ingest, with app.project_ids set to the one project. app_rw has no DELETE on events, so --cleanup and --analyze run as the
// migrator (MIGRATION_DATABASE_URL); its DELETE on events is allowed only by the tenant_isolation policy, which the script scopes to
// the same single project, and the statement also names the project and the seed tag.
// Credentials come from the environment (node --env-file); the script never reads a file, never prints a connection string.
import { neon } from "@neondatabase/serverless";
import { configureLocalNeon } from "../db/neon-local.mjs";
import {
  SEED_TAG, HOUR_WEIGHTS, UsageError, cleanupWindows, deleteSeed, existingPartitions, insertSeed, mb, neededPartitions, parseArgs,
  planDays, projectCheck, scope, storageReport,
} from "./seed-perf-lib.mjs";

const QUOTA_EVENTS_PER_DAY = 1_900; // lib/quotas.ts QUOTAS.eventsPerDayPerProject
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const need = (name) => {
  if (!process.env[name]) fail(`Missing environment variable: ${name} (run with node --env-file=.env.local)`);
  return process.env[name];
};
const connect = (name) => {
  const url = need(name);
  configureLocalNeon(url);
  return neon(url);
};
const brief = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 300); // first line of the database message; never the connection

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) fail(`${e.message}\nusage: node --env-file=.env.local scripts/seed-perf.mjs --project <uuid> [--rows N] [--dry-run | --analyze | --cleanup]`);
  throw e;
}
const pid = args.project;
const nowMs = Date.now();

const asProject = (sql, build) => sql.transaction((t) => [scope(t, pid), ...build(t)]);
const one = async (sql, build) => (await asProject(sql, (t) => [build(t)]))[1][0];

async function report(sql, label) {
  const r = await one(sql, (t) => storageReport(t, pid));
  console.log(`${label}: project rows ${r.project_rows} (seeded ${r.seed_rows}); events tables ${mb(r.events_bytes)} incl. indexes (all projects); database ${mb(r.db_bytes)}`);
  return r;
}

async function requireProject(sql) {
  const p = await one(sql, (t) => projectCheck(t, pid));
  if (!p) fail("Project not found (or not visible to this role). Create it in the UI first and pass its id.");
  if (p.is_demo) fail("Refusing: that is the demo project.");
  console.log(`Project: "${p.name}"`);
}

// ---- cleanup ----
if (args.cleanup) {
  const sql = connect("MIGRATION_DATABASE_URL");
  await requireProject(sql);
  await report(sql, "before");
  let deleted = 0;
  try {
    for (const w of cleanupWindows(nowMs)) {
      const r = await one(sql, (t) => deleteSeed(t, { pid, fromIso: new Date(w.fromMs).toISOString(), toIso: new Date(w.toMs).toISOString() }));
      deleted += r.n;
    }
  } catch (e) {
    fail(`Cleanup failed (nothing else was touched): ${brief(e)}`);
  }
  const after = await report(sql, "after ");
  console.log(`Deleted ${deleted} seeded events (tag ${SEED_TAG}) of this project. Other rows of the project untouched: ${after.project_rows}.`);
  if (after.seed_rows !== 0) fail(`${after.seed_rows} seeded rows are still there (older than the cleanup window?).`);
  console.log("Note: deleted rows free space inside the partition files but do not shrink them; the size above stays until the partition is dropped by retention.");
  process.exit(0);
}

// ---- analyze ----
if (args.analyze) {
  const sql = connect("MIGRATION_DATABASE_URL");
  await requireProject(sql);
  await sql.query("analyze events");
  console.log("ANALYZE events done (planner statistics refreshed).");
  process.exit(0);
}

// ---- seed ----
const days = planDays(args.rows, nowMs);
const perDay = Math.round(args.rows / days.length);
console.log(`Plan: ${args.rows} events over ${days.length} slices ending now (busiest ${Math.max(...days.map((d) => d.budget))}, quietest ${Math.min(...days.map((d) => d.budget))} per slice; average ${perDay}/day).`);
if (perDay > QUOTA_EVENTS_PER_DAY) console.log(`Note: ${perDay}/day is ABOVE the free-tier quota of ${QUOTA_EVENTS_PER_DAY}/day: a margin run, not a real project.`);
if (args.dryRun) {
  console.log("Dry run: nothing written.");
  process.exit(0);
}

const sql = connect("DATABASE_URL");
await requireProject(sql);

const have = new Set();
{
  const rows = (await asProject(sql, (t) => [existingPartitions(t)]))[1];
  for (const r of rows) have.add(r.relname);
  const missing = neededPartitions(days[0].fromMs, days[days.length - 1].toMs).filter((n) => !have.has(n));
  if (missing.length) fail(`Missing event partitions: ${missing.join(", ")}. app_rw cannot create them; run the daily job (or ensure_event_partitions as the migrator) first.`);
}

const before = await report(sql, "before");
if (before.seed_rows > 0) fail("This project already has seeded rows. Run --cleanup first (a second seed would double the data).");
if (before.project_rows > 0) console.log(`Warning: ${before.project_rows} real (untagged) events are in this project; they will be mixed into the measurement.`);

let written = 0;
const t0 = Date.now();
for (const d of days) {
  try {
    const r = await one(sql, (t) =>
      insertSeed(t, { pid, fromIso: new Date(d.fromMs).toISOString(), toIso: new Date(d.toMs).toISOString(), budget: d.budget, hourWeights: HOUR_WEIGHTS.join(",") }),
    );
    written += r.n;
  } catch (e) {
    fail(`Seed failed after ${written} events (each slice is atomic; run --cleanup to remove what was written): ${brief(e)}`);
  }
}
console.log(`Inserted ${written} events in ${((Date.now() - t0) / 1000).toFixed(1)} s (${days.length} statements).`);
const after = await report(sql, "after ");
console.log(`Added ${after.seed_rows} rows, ${mb(after.events_bytes - before.events_bytes)} (${Math.round((after.events_bytes - before.events_bytes) / Math.max(after.seed_rows, 1))} B per row incl. indexes).`);
console.log("Next: --analyze (planner statistics), then scripts/explain-traces.mjs. Remove everything with --cleanup when done.");
