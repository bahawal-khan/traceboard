// Measures the real on-disk cost of an event row (heap, toast, every index) and of the other write-time tables.
//   npm run measure:rows -- --i-am-on-the-dev-branch [--rows=10000] [--only=events|all]
// Runs as app_rw (DATABASE_URL) against the DEV branch only. It creates a throwaway project, inserts
// synthetic but realistically shaped rows, measures sizes with Postgres' own functions, deletes the
// project (cascade), and writes db/measurements/event-row-size.json for the quota recomputation (P2.6).
//
// Method (events): FOUR runs in the order lean, heavy, heavy, lean, each on its OWN fresh future monthly
// partition (no real traffic can land there: ingest only accepts now +/- 24h). Clean partitions are picked
// automatically (a partition that already has pages from an earlier run is skipped) and created on demand
// with ensure_event_partitions(), the same SECURITY DEFINER function the daily job uses. Per run the report
// splits the size into heap, free-space/visibility forks, toast and EACH index, divides by the number of rows
// actually in THAT partition (counted by tableoid and checked against the number inserted), and compares the
// two runs of each profile (spread). It warns, and exits with code 2, when the results are not plausible
// (heavy smaller than lean, or two runs of one profile differing by more than 10 percent).
// Rows are inserted in time order (as real traffic is) with random uuids/hashes (as real traffic has).
// After the run the rows are deleted (cascade) but their pages stay allocated: each run burns four partitions.
// The other tables (--only=all) are measured as deltas on shared tables and can under-report on a rerun.
import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { configureLocalNeon } from "../db/neon-local.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may come from the shell */
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
if (!args["i-am-on-the-dev-branch"]) {
  console.error("Refusing to run: this writes tens of thousands of rows. Pass --i-am-on-the-dev-branch once you checked DATABASE_URL is the DEV branch.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("Missing environment variable: DATABASE_URL");
  process.exit(1);
}
const ROWS = Math.min(Math.max(Number(args.rows ?? 10000), 2000), 30000);
const ONLY = String(args.only ?? "events");
if (!["events", "all"].includes(ONLY)) {
  console.error("--only must be 'events' (default) or 'all'.");
  process.exit(1);
}
const RUN_ORDER = ["lean", "heavy", "heavy", "lean"];
const CLEAN_PARTITION_BYTES = 100_000; // an empty partition with its indexes is about 50 KB
const SPREAD_WARN_PCT = 10;
const CHUNK = 5000;

configureLocalNeon(process.env.DATABASE_URL);
const sql = neon(process.env.DATABASE_URL);
console.log(`Database host: ${new URL(process.env.DATABASE_URL).hostname}  rows per run: ${ROWS}  runs: ${RUN_ORDER.join(", ")}  also measuring: ${ONLY === "all" ? "rollups, usage_daily, event_content" : "events only"}`);

const owner = `measure_${randomUUID()}`;
const pid = randomUUID();
/** One transaction with the RLS scope set first, exactly like withTenant(). `build` gets the in-transaction query function. */
const run = (build) =>
  sql.transaction((t) => [t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${pid}, true)`, ...build(t)]);

const sizeOf = async (rel) => {
  const [r] = await sql`select pg_total_relation_size(${rel}::regclass)::bigint::text as total, pg_table_size(${rel}::regclass)::bigint::text as tbl, pg_indexes_size(${rel}::regclass)::bigint::text as idx`;
  return { total: Number(r.total), table: Number(r.tbl), indexes: Number(r.idx) };
};
const indexSizes = async (rel) =>
  (await sql`select c.relname as name, pg_relation_size(c.oid)::bigint::text as bytes from pg_index i join pg_class c on c.oid = i.indexrelid where i.indrelid = ${rel}::regclass order by c.relname`).map((r) => ({ name: r.name, bytes: Number(r.bytes) }));
const delta = (a, b) => ({ total: b.total - a.total, table: b.table - a.table, indexes: b.indexes - a.indexes });

// ---------- event profiles ----------
const lean = (t, from, to, total, start, salt) => t`
  insert into events (event_id, project_id, trace_id, span_id, parent_id, kind, name, model, provider,
                      input_tokens, output_tokens, cached_tokens, latency_ms, ttft_ms, cost_usd, status, prompt_hash, occurred_at)
  select gen_random_uuid(), ${pid}::uuid,
         md5('t' || (g / 4)::text || ${salt}),
         substr(md5('s' || g::text || ${salt}), 1, 16),
         case when g % 4 = 0 then null else substr(md5('s' || (g - 1)::text || ${salt}), 1, 16) end,
         'llm', 'chat.completions',
         (array['gpt-4o-mini','gpt-4o','claude-sonnet-5-5','claude-haiku-5-5','gemini-3.1-pro-preview','gpt-5.6-sol'])[1 + g % 6],
         (array['openai','openai','anthropic','anthropic','google','openai'])[1 + g % 6],
         200 + (g * 37) % 3000, 50 + (g * 13) % 800, case when g % 3 = 0 then (g * 7) % 1500 end,
         300 + (g * 91) % 8000, 80 + (g * 17) % 900,
         round((((g * 37) % 3000) * 2 + ((g * 13) % 800) * 10)::numeric / 1000000, 6),
         case when g % 25 = 0 then 'error' else 'ok' end,
         md5('p' || g::text || ${salt}) || md5('q' || g::text || ${salt}),
         ${start}::timestamptz + (g::double precision / ${total}::double precision) * interval '27 days'
    from generate_series(${from}::int, ${to}::int) g order by g`;

const heavy = (t, from, to, total, start, salt) => t`
  insert into events (event_id, project_id, trace_id, span_id, parent_id, thread_id, kind, name, model, provider,
                      input_tokens, output_tokens, cached_tokens, latency_ms, ttft_ms, cost_usd, status, error,
                      prompt_hash, args_hash, user_id_hash, tags, occurred_at)
  select gen_random_uuid(), ${pid}::uuid,
         md5('t' || (g / 6)::text || ${salt}),
         substr(md5('s' || g::text || ${salt}), 1, 16),
         case when g % 6 = 0 then null else substr(md5('s' || (g - 1)::text || ${salt}), 1, 16) end,
         md5('th' || (g / 30)::text || ${salt})::uuid::text,
         (array['llm','llm','llm','tool','agent','retrieval'])[1 + g % 6],
         'agent.step.' || (g % 50)::text || '.' || repeat('x', 20),
         (array['gpt-4o-mini','gpt-4o','claude-sonnet-5-5','claude-haiku-5-5','gemini-3.1-pro-preview','gpt-5.6-sol'])[1 + g % 6],
         (array['openai','openai','anthropic','anthropic','google','openai'])[1 + g % 6],
         200 + (g * 37) % 3000, 50 + (g * 13) % 800, (g * 7) % 1500,
         300 + (g * 91) % 8000, 80 + (g * 17) % 900,
         round((((g * 37) % 3000) * 2 + ((g * 13) % 800) * 10)::numeric / 1000000, 6),
         case when g % 25 = 0 then 'error' else 'ok' end,
         case when g % 25 = 0 then 'RateLimitError: 429 Too Many Requests ' || repeat('e', 80) end,
         md5('p' || g::text || ${salt}) || md5('q' || g::text || ${salt}),
         md5('a' || g::text || ${salt}) || md5('b' || g::text || ${salt}),
         md5('u' || (g % 500)::text || ${salt}) || md5('v' || (g % 500)::text || ${salt}),
         array['env:prod', 'team:' || (g % 7)::text, 'v' || (g % 3)::text],
         ${start}::timestamptz + (g::double precision / ${total}::double precision) * interval '27 days'
    from generate_series(${from}::int, ${to}::int) g order by g`;

const INDEX_ROLES = [
  [/_pkey$/, "pkey (id, occurred_at)"],
  [/_event_id_occurred_at_key$/, "unique (project_id, event_id, occurred_at)"],
  [/_project_id_occurred_at_idx$/, "project_time (project_id, occurred_at desc)"],
  [/_thread_id_idx$/, "thread (partial)"],
  [/_trace_id_idx$/, "trace (project_id, trace_id)"],
];
const roleOf = (name) => INDEX_ROLES.find(([re]) => re.test(name))?.[1] ?? name;
const round1 = (x) => Math.round(x * 10) / 10;

/** The first `count` future partitions that are still empty, creating them if they do not exist yet. */
async function pickCleanPartitions(count) {
  const picked = [];
  for (let m = 2; m <= 14 && picked.length < count; m++) {
    await sql`select ensure_event_partitions((date_trunc('month', now() at time zone 'UTC') + make_interval(months => ${m}::int))::date, 1)`;
    const [{ part, start }] = await sql`select to_char(date_trunc('month', now() at time zone 'UTC') + make_interval(months => ${m}::int), '"events_y"YYYY"m"MM') as part,
      to_char(date_trunc('month', now() at time zone 'UTC') + make_interval(months => ${m}::int), 'YYYY-MM-DD"T"00:00:00"Z"') as start`;
    const size = await sizeOf(`public.${part}`);
    if (size.total < CLEAN_PARTITION_BYTES) picked.push({ part, start });
    else console.log(`  skipping ${part} (${size.total} bytes already: used by an earlier run)`);
  }
  if (picked.length < count) throw new Error(`found only ${picked.length} clean future partitions (needed ${count})`);
  return picked;
}

/** Heap, free-space map, visibility map, toast (with its index) and every index of one partition. */
async function componentSizes(rel) {
  const [r] = await sql`select pg_relation_size(c.oid, 'main')::bigint::text as heap, pg_relation_size(c.oid, 'fsm')::bigint::text as fsm,
      pg_relation_size(c.oid, 'vm')::bigint::text as vm,
      (case when c.reltoastrelid <> 0 then pg_total_relation_size(c.reltoastrelid) else 0 end)::bigint::text as toast,
      pg_total_relation_size(c.oid)::bigint::text as total
    from pg_class c where c.oid = ${rel}::regclass`;
  const indexes = Object.fromEntries((await indexSizes(rel)).map((i) => [roleOf(i.name), i.bytes]));
  return { heap: Number(r.heap), fsm: Number(r.fsm), vm: Number(r.vm), toast: Number(r.toast), indexes, reportedTotal: Number(r.total) };
}

async function measureEventRun(order, profile, { part, start }) {
  const rel = `public.${part}`;
  const before = await componentSizes(rel);
  const salt = randomUUID();
  const insertFor = profile === "lean" ? lean : heavy;
  for (let from = 1; from <= ROWS; from += CHUNK) {
    await run((t) => [insertFor(t, from, Math.min(from + CHUNK - 1, ROWS), ROWS, start, salt)]);
  }
  const after = await componentSizes(rel);
  // Rows in THIS partition only (tableoid), never the whole project: an earlier run's rows must not be counted.
  const [, stats] = await run((t) => [t`select count(*)::int as n, avg(pg_column_size(e.*))::int as payload from events e where e.project_id = ${pid}::uuid and e.tableoid = ${rel}::regclass`]);
  const rows = stats[0].n;
  if (rows !== ROWS) throw new Error(`run ${order} (${profile}, ${part}): expected ${ROWS} rows in the partition, found ${rows}`);
  const d = {
    heap: after.heap - before.heap,
    fsmVm: after.fsm + after.vm - before.fsm - before.vm,
    toast: after.toast - before.toast,
    indexes: Object.fromEntries(Object.entries(after.indexes).map(([k, v]) => [k, v - (before.indexes[k] ?? 0)])),
  };
  const indexTotal = Object.values(d.indexes).reduce((a, b) => a + b, 0);
  const total = d.heap + d.fsmVm + d.toast + indexTotal;
  const per = (x) => round1(x / rows);
  const run_ = {
    order,
    profile,
    partition: part,
    rows,
    avgRowPayloadBytes: stats[0].payload,
    bytes: { heap: d.heap, freeSpaceAndVisibility: d.fsmVm, toast: d.toast, indexes: d.indexes, indexTotal, total, reportedTotalDelta: after.reportedTotal - before.reportedTotal },
    perRow: { heap: per(d.heap), freeSpaceAndVisibility: per(d.fsmVm), toast: per(d.toast), table: per(d.heap + d.fsmVm + d.toast), indexTotal: per(indexTotal), total: per(total), byIndex: Object.fromEntries(Object.entries(d.indexes).map(([k, v]) => [k, per(v)])) },
  };
  console.log(`run ${order} ${profile.padEnd(5)} ${part}: ${run_.perRow.total} B/row = table ${run_.perRow.table} (heap ${run_.perRow.heap}, toast ${run_.perRow.toast}) + indexes ${run_.perRow.indexTotal}   [row payload ${run_.avgRowPayloadBytes}]`);
  for (const [k, v] of Object.entries(run_.perRow.byIndex)) console.log(`        index ${k}: ${v} B/row`);
  return run_;
}

function summarize(runs) {
  const out = {};
  for (const profile of new Set(runs.map((r) => r.profile))) {
    const rs = runs.filter((r) => r.profile === profile);
    const stat = (f) => {
      const v = rs.map(f);
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      return { mean: round1(mean), min: Math.min(...v), max: Math.max(...v), spreadPct: mean ? round1(((Math.max(...v) - Math.min(...v)) / mean) * 100) : 0 };
    };
    out[profile] = { runs: rs.length, total: stat((r) => r.perRow.total), table: stat((r) => r.perRow.table), indexes: stat((r) => r.perRow.indexTotal) };
  }
  return out;
}

function checkPlausible(summary) {
  const warnings = [];
  const { lean: l, heavy: h } = summary;
  for (const [what, key] of [["table", "table"], ["indexes", "indexes"], ["total", "total"]]) {
    if (h[key].mean < l[key].mean) warnings.push(`heavy ${what} (${h[key].mean} B/row) is SMALLER than lean ${what} (${l[key].mean} B/row): the measurement is not plausible, do not use it`);
  }
  for (const [name, sm] of Object.entries(summary)) {
    for (const key of ["total", "table", "indexes"]) {
      if (sm[key].spreadPct > SPREAD_WARN_PCT) warnings.push(`${name} ${key}: the two runs differ by ${sm[key].spreadPct}% (> ${SPREAD_WARN_PCT}%): treat the mean as +/- that much`);
    }
  }
  return warnings;
}

// ---------- other write-time tables (shared tables: measured as a delta, so run on a quiet dev branch) ----------
async function measureRollup(table, bucketExpr, rows) {
  const before = await sizeOf(`public.${table}`);
  await run((t) => [t.query(
    `insert into ${table} (project_id, bucket, model, shard, calls, input_tokens, output_tokens, cost_micro, errors, lat_sum_ms,
        lat_b0, lat_b1, lat_b2, lat_b3, lat_b4, lat_b5, lat_b6, lat_b7, lat_b8, lat_b9, lat_b10, lat_b11)
     select $1::uuid, ${bucketExpr}, (array['gpt-4o-mini','gpt-4o','claude-sonnet-5-5'])[1 + g % 3], g % 8,
            (g % 50) + 1, (g * 977) % 900000, (g * 313) % 90000, (g * 4159) % 5000000, g % 3, (g * 7919) % 900000,
            g % 5, g % 7, g % 11, g % 13, g % 17, g % 19, g % 23, g % 29, g % 31, g % 37, g % 41, g % 43
       from generate_series(1, ${rows}) g`,
    [pid],
  )]);
  const after = await sizeOf(`public.${table}`);
  const [, stats] = await run((t) => [t.query(`select count(*)::int as n, avg(pg_column_size(x.*))::int as payload from ${table} x where project_id = $1::uuid`, [pid])]);
  const d = delta(before, after);
  return { rows: stats[0].n, totalBytes: d.total, bytesPerRow: Math.round((d.total / stats[0].n) * 10) / 10, avgRowPayloadBytes: stats[0].payload };
}

async function measureUsageDaily(rows) {
  const before = await sizeOf("public.usage_daily");
  await run((t) => [t`insert into usage_daily (project_id, day, events, requests, cost_micro)
                select ${pid}::uuid, (date '2020-01-01' + g), g * 10, g, g * 1000 from generate_series(1, ${rows}::int) g`]);
  const after = await sizeOf("public.usage_daily");
  const [, stats] = await run((t) => [t`select count(*)::int as n, avg(pg_column_size(x.*))::int as payload from usage_daily x where project_id = ${pid}::uuid`]);
  const d = delta(before, after);
  return { rows: stats[0].n, totalBytes: d.total, bytesPerRow: Math.round((d.total / stats[0].n) * 10) / 10, avgRowPayloadBytes: stats[0].payload };
}

async function measureContent(rows) {
  const before = await sizeOf("public.event_content");
  // ~2 KB of pseudo-random bytes -> base64url, like a maximum-size encrypted field (incompressible, so TOAST behaves as with ciphertext).
  const field = `'v1.1.' || (select translate(replace(encode(decode(string_agg(md5(g::text || k::text || '${randomUUID()}'), ''), 'hex'), 'base64'), E'\\n', ''), '+/=', '-_') from generate_series(1, 128) k)`;
  await run((t) => [t.query(
    `insert into event_content (event_id, project_id, input_text, output_text, redaction_report, expires_at)
     select gen_random_uuid(), $1::uuid, ${field}, ${field},
            '{"v":1,"enc":"aes-256-gcm","keyVersion":1,"redactions":{"secret":0,"email":1,"card":0,"phone":0},"truncated":false}'::jsonb, now() + interval '3 days'
       from generate_series(1, ${rows}) g`,
    [pid],
  )]);
  const after = await sizeOf("public.event_content");
  const [, stats] = await run((t) => [t`select count(*)::int as n, avg(length(input_text))::int as in_len, avg(pg_column_size(x.*))::int as payload from event_content x where project_id = ${pid}::uuid`]);
  const d = delta(before, after);
  return { rows: stats[0].n, inputChars: stats[0].in_len, totalBytes: d.total, bytesPerRow: Math.round((d.total / stats[0].n) * 10) / 10, avgRowPayloadBytes: stats[0].payload, note: "maximum case: 2 KB input + 2 KB output, both encrypted" };
}

// ---------- run ----------
let report;
let usedPartitions = [];
try {
  await run((t) => [t`insert into projects (id, owner_id, name) values (${pid}::uuid, ${owner}, 'row-size-measurement')`]);
} catch (e) {
  console.error("Could not create the throwaway project:", e.message);
  process.exit(1);
}
try {
  const [{ v }] = await sql`select version() as v`;
  const partitions = await pickCleanPartitions(RUN_ORDER.length);
  usedPartitions = partitions.map((p) => p.part);
  const runs = [];
  for (let i = 0; i < RUN_ORDER.length; i++) runs.push(await measureEventRun(i + 1, RUN_ORDER[i], partitions[i]));
  const summary = summarize(runs);
  const warnings = checkPlausible(summary);

  let previous = {};
  try {
    previous = JSON.parse(readFileSync("db/measurements/event-row-size.json", "utf8"));
  } catch {
    /* first report */
  }
  report = {
    ...previous,
    measuredAt: new Date().toISOString(),
    postgres: v.split(" on ")[0],
    method: "four runs (lean, heavy, heavy, lean), each on its own fresh future monthly partition; size delta split into heap, fsm/vm, toast and every index; rows counted per partition (tableoid)",
    rowsPerRun: ROWS,
    events: { runs, summary },
    warnings,
    consistent: warnings.length === 0,
  };
  delete report.rowsPerProfile;
  if (ONLY === "all") {
    const minute = await measureRollup("metrics_minute", "date_trunc('minute', timestamptz '2020-01-01' + g * interval '1 minute')", 4000);
    const hourly = await measureRollup("metrics_hourly", "date_trunc('hour', timestamptz '2020-01-01' + g * interval '1 hour')", 4000);
    const usage = await measureUsageDaily(2000);
    const content = await measureContent(500);
    console.log(`metrics_minute ${minute.bytesPerRow} B/row, metrics_hourly ${hourly.bytesPerRow}, usage_daily ${usage.bytesPerRow}, event_content ${content.bytesPerRow}`);
    report.rollups = { metrics_minute: minute, metrics_hourly: hourly, note: "deltas on shared tables; a rerun can under-report if autovacuum freed pages in between" };
    report.usage_daily = usage;
    report.event_content = content;
  }
  console.log("\nSummary (B/row, mean of two runs, [min..max], spread):");
  for (const [name, sm] of Object.entries(summary)) {
    console.log(`  ${name.padEnd(5)} total ${sm.total.mean} [${sm.total.min}..${sm.total.max}] ${sm.total.spreadPct}%  table ${sm.table.mean} (${sm.table.spreadPct}%)  indexes ${sm.indexes.mean} (${sm.indexes.spreadPct}%)`);
  }
  for (const w of warnings) console.warn(`WARNING: ${w}`);
  if (warnings.length) process.exitCode = 2;
} finally {
  // Cascade: events (partitions), rollups, usage and content rows of the throwaway project. Dead tuples remain until autovacuum.
  await run((t) => [t`delete from projects where id = ${pid}::uuid`]).catch((e) => console.error("CLEANUP FAILED, delete project", pid, "manually:", e.message));
}
if (report) {
  mkdirSync("db/measurements", { recursive: true });
  writeFileSync("db/measurements/event-row-size.json", JSON.stringify(report, null, 2) + "\n");
  console.log("\nWrote db/measurements/event-row-size.json");
  console.log(`Partitions used (their pages stay allocated; optional cleanup by the migrator role only): ${usedPartitions.join(", ")}`);
}
