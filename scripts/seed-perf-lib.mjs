// Pure helpers for scripts/seed-perf.mjs: argument parsing, the per-day volume plan and the SQL statements.
// No environment access, no database access: tests/seed-perf.test.ts covers all of it.

/** Every seeded row carries this tag; cleanup deletes by (project, tag) and nothing else. */
export const SEED_TAG = "perf-seed-v1";
export const DEFAULT_ROWS = 30_000;
/** 200k rows is about 200 MB of the 1 GB free database; refuse anything larger than a margin run needs. */
export const MAX_ROWS = 200_000;
export const DAYS = 14;
const HOUR = 3_600_000;
/** The seed ends 2 h before the 14-day edge so listTraces' hour-aligned window always contains every row. */
const SPAN_MS = DAYS * 24 * HOUR - 2 * HOUR;
const SLICE_MS = SPAN_MS / DAYS;
const NEWEST_GAP_MS = 2 * 60_000; // the newest event is 2 minutes old: nothing in the future, whatever the clock skew

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Relative traffic per UTC hour of day (a working-day curve, never flat) and the weekend factor. */
export const HOUR_WEIGHTS = [0.3, 0.2, 0.2, 0.2, 0.3, 0.5, 0.8, 1.2, 1.8, 2.2, 2.5, 2.6, 2.4, 2.5, 2.6, 2.4, 2.1, 1.7, 1.2, 0.9, 0.7, 0.5, 0.4, 0.3];
export const WEEKEND_FACTOR = 0.4;

export class UsageError extends Error {}

/** `--project <uuid>` (required), `--rows N`, `--cleanup`, `--analyze`, `--dry-run`. Anything else is an error. */
export function parseArgs(argv) {
  const out = { project: null, rows: DEFAULT_ROWS, cleanup: false, analyze: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith("--") && argv[i].includes("=") ? [argv[i].slice(0, argv[i].indexOf("=")), argv[i].slice(argv[i].indexOf("=") + 1)] : [argv[i], undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
      return next;
    };
    if (flag === "--project") out.project = value();
    else if (flag === "--rows") {
      const v = value();
      if (!/^\d+$/.test(v)) throw new UsageError("--rows must be a whole number");
      out.rows = Number(v);
    } else if (flag === "--cleanup") out.cleanup = true;
    else if (flag === "--analyze") out.analyze = true;
    else if (flag === "--dry-run") out.dryRun = true;
    else throw new UsageError(`unknown argument ${flag}`);
  }
  if (!out.project) throw new UsageError("--project <uuid> is required (create the project in the UI first)");
  if (!UUID.test(out.project)) throw new UsageError("--project must be a UUID");
  out.project = out.project.toLowerCase();
  if (!Number.isInteger(out.rows) || out.rows < 1 || out.rows > MAX_ROWS) throw new UsageError(`--rows must be between 1 and ${MAX_ROWS}`);
  if (out.cleanup && (out.analyze || out.dryRun)) throw new UsageError("--cleanup cannot be combined with --analyze or --dry-run");
  return out;
}

/**
 * Splits `rows` over 14 equal slices of time ending now, shaped like real traffic: weekend slices carry WEEKEND_FACTOR of a
 * weekday, with +-20 % jitter. The budgets add up to EXACTLY `rows` (largest remainder). `rand` is injectable for tests.
 */
export function planDays(rows, nowMs, rand = Math.random) {
  const slices = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const toMs = i === 0 ? nowMs - NEWEST_GAP_MS : nowMs - i * SLICE_MS;
    const fromMs = nowMs - (i + 1) * SLICE_MS;
    const dow = new Date((fromMs + toMs) / 2).getUTCDay();
    const weight = (dow === 0 || dow === 6 ? WEEKEND_FACTOR : 1) * (0.8 + 0.4 * rand());
    slices.push({ fromMs, toMs, weight });
  }
  const total = slices.reduce((a, s) => a + s.weight, 0);
  const exact = slices.map((s) => (rows * s.weight) / total);
  const budgets = exact.map(Math.floor);
  let left = rows - budgets.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    budgets[i] += 1;
    left -= 1;
  }
  return slices.map((s, i) => ({ fromMs: s.fromMs, toMs: s.toMs, budget: budgets[i] }));
}

/** Months (UTC, as `events_yYYYYmMM`) the seed window touches: those partitions must exist. */
export function neededPartitions(fromMs, toMs) {
  const names = new Set();
  for (let t = fromMs; t <= toMs; t += 24 * HOUR) names.add(partitionName(t));
  names.add(partitionName(toMs));
  return [...names].sort();
}
function partitionName(ms) {
  const d = new Date(ms);
  return `events_y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---- statements (tagged-template builders: `t` is the driver's transaction template tag) ----

/** The project, as the app_rw role sees it with only this project in scope (RLS: `id in app.project_ids`). */
export const projectCheck = (t, pid) => t`select name, is_demo from projects where id = ${pid}::uuid`;

/** Rows of this project, seeded rows of this project, bytes of ALL events partitions (heap + indexes), whole database. */
export const storageReport = (t, pid) =>
  t`select (select count(*)::int from events where project_id = ${pid}::uuid) as project_rows,
           (select count(*)::int from events where project_id = ${pid}::uuid and tags @> array[${SEED_TAG}]::text[]) as seed_rows,
           (select coalesce(sum(pg_total_relation_size(relid)), 0)::bigint from pg_partition_tree('events') where isleaf) as events_bytes,
           pg_database_size(current_database())::bigint as db_bytes`;

export const existingPartitions = (t) =>
  t`select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'events'::regclass`;

/**
 * Inserts exactly `budget` events (whole traces of 1 to 12 spans, the last one cut to fit) with start times inside
 * [from, to) shaped by the hour-of-day curve. Roughly: 5 % orphan traces (no span without a parent), 7 % traces with a failed
 * span, 8 % of LLM spans on an unpriced model (no cost), about 62 % of non-root spans are LLM calls. Every row is tagged.
 * Runs as app_rw through the tenant policy (the same door as ingest); returns one row `{ n }`.
 */
export const insertSeed = (t, a) =>
  t`with w as (
      select ${a.pid}::uuid as pid, ${a.fromIso}::timestamptz as wf, ${a.toIso}::timestamptz as wt, ${a.budget}::int as budget,
             string_to_array(${a.hourWeights}::text, ',')::float8[] as hw, ${SEED_TAG}::text as tag
    ), slots as (
      select greatest(w.wf, date_trunc('hour', w.wf) + k * interval '1 hour') as a,
             least(w.wt, date_trunc('hour', w.wf) + (k + 1) * interval '1 hour') as b, w.hw
        from w cross join generate_series(0, 24) k
    ), slots2 as (
      select a, b, hw[1 + extract(hour from a at time zone 'UTC')::int] * extract(epoch from (b - a)) / 3600.0 as wgt
        from slots where b > a
    ), cum as (
      select a, b, sum(wgt) over (order by a) / sum(wgt) over () as hi from slots2
    ), t0 as (
      select n, gen_random_uuid() as tid, random() as r_slot, random() as r_in,
             1 + floor(least(11.99, -ln(1 - random()) * 3))::int as spans,
             random() as r_orphan, random() as r_fail, random() as r_failk, random() as r_rootfail,
             random() as r_thread, random() as r_user
        from w, generate_series(1, w.budget) n
    ), t1 as (
      select t0.*, sum(spans) over (order by n) - spans as prior from t0
    ), t2 as (
      select t1.*, least(t1.spans, w.budget - t1.prior) as keep from t1 cross join w where t1.prior < w.budget
    ), t3 as (
      select t2.*, c.a + (c.b - c.a) * t2.r_in as start_at
        from t2 cross join lateral (select a, b from cum where hi >= least(t2.r_slot, 0.999999) order by hi limit 1) c
    ), s1 as (
      select t3.*, k, random() as kr, random() as mr, random() as r_off, random() as r_lat, random() as r_prev,
             random() as r_tin, random() as r_tout, random() as r_cache, random() as r_err, random() as r_tool
        from t3 cross join lateral generate_series(1, t3.keep) k
    ), s2 as (
      select s1.*,
             replace(tid::text, '-', '') as trace_text,
             case when k = 1 then (case when spans > 1 then 'agent' else 'llm' end)
                  when kr < 0.62 then 'llm' when kr < 0.87 then 'tool' else 'retrieval' end as kind
        from s1
    ), s3 as (
      select s2.*,
             case when kind = 'llm' then (case when mr < 0.08 then 'acme-internal-7b' when mr < 0.38 then 'gpt-4o' else 'gpt-4o-mini' end) end as model_
        from s2
    ), s4 as (
      select s3.*,
             case when kind = 'llm' then 200 + floor(power(r_tin, 2) * 6000)::int end as in_tok,
             case when kind = 'llm' then 20 + floor(power(r_tout, 2) * 1200)::int end as out_tok,
             case kind when 'agent' then 400 * spans + floor(r_lat * 3000)::int
                       when 'llm' then 300 + floor(r_lat * 3500)::int
                       when 'tool' then 20 + floor(r_lat * 800)::int
                       else 40 + floor(r_lat * 300)::int end as lat,
             (r_fail < 0.07 and (k = 1 + floor(r_failk * spans)::int or (k = 1 and r_rootfail < 0.4))) as failed
        from s3
    ), ins as (
      insert into events (event_id, project_id, trace_id, span_id, parent_id, thread_id, kind, name, model, provider,
                          input_tokens, output_tokens, cached_tokens, latency_ms, ttft_ms, cost_usd, status, error,
                          prompt_hash, args_hash, user_id_hash, tags, occurred_at, received_at)
      select gen_random_uuid(), w.pid, trace_text, 'sp-' || substr(trace_text, 1, 12) || '-' || k,
             case when k = 1 then (case when r_orphan < 0.05 then 'lost-' || substr(trace_text, 1, 8) end)
                  when k > 2 and r_prev < 0.3 then 'sp-' || substr(trace_text, 1, 12) || '-' || (k - 1)
                  else 'sp-' || substr(trace_text, 1, 12) || '-1' end,
             case when r_thread < 0.4 then 'th-' || floor(r_thread / 0.4 * 400)::int end,
             kind,
             case kind when 'agent' then 'agent.run' when 'llm' then 'chat ' || model_
                       when 'retrieval' then 'vector.search'
                       else (array['search', 'lookup', 'calculator', 'http_get'])[1 + floor(r_tool * 4)::int] end,
             model_, case when model_ = 'acme-internal-7b' then 'acme' when model_ is not null then 'openai' end,
             in_tok, out_tok, case when kind = 'llm' then (case when r_cache < 0.3 then in_tok / 2 else 0 end) end,
             lat, case when kind = 'llm' then (lat * 0.3)::int end,
             case when kind = 'llm' and model_ <> 'acme-internal-7b'
                  then round(((in_tok * (case model_ when 'gpt-4o' then 2.5 else 0.15 end)
                             + out_tok * (case model_ when 'gpt-4o' then 10.0 else 0.6 end)) / 1000000.0)::numeric, 6) end,
             case when failed then 'error' else 'ok' end,
             case when failed then (array['upstream timeout', 'rate limited', 'tool exception: connection reset', 'invalid response'])[1 + floor(r_err * 4)::int] end,
             case when kind = 'llm' then md5(random()::text || n::text) || md5(k::text || random()::text) end,
             case when kind in ('tool', 'retrieval') then md5(random()::text || k::text) || md5(n::text || random()::text) end,
             md5('user' || floor(r_user * 200)::int) || md5('salt' || floor(r_user * 200)::int),
             array[w.tag],
             start_at + ((k - 1) * (50 + floor(r_off * 350)::int)) * interval '1 millisecond',
             start_at + ((k - 1) * (50 + floor(r_off * 350)::int)) * interval '1 millisecond' + interval '1 second'
        from s4 cross join w
      returning 1
    )
    select count(*)::int as n from ins`;

/**
 * Deletes seeded events of ONE project inside a time window, in a single statement. Three independent fences: the explicit
 * project predicate, the tag predicate, and (as the migrator role, which has no DELETE policy of its own on events) the
 * tenant_isolation policy scoped to this one project by the caller's set_config. Returns one row `{ n }`.
 */
export const deleteSeed = (t, a) =>
  t`with d as (
      delete from events
       where project_id = ${a.pid}::uuid and tags @> array[${SEED_TAG}]::text[]
         and occurred_at >= ${a.fromIso}::timestamptz and occurred_at < ${a.toIso}::timestamptz
      returning 1
    ) select count(*)::int as n from d`;

export const scope = (t, pid) => t`select set_config('app.owner_id', '', true), set_config('app.project_ids', ${pid}, true)`;

/** Windows used by cleanup: one statement per slice so a delete never runs long; covers everything the seed can have written. */
export function cleanupWindows(nowMs) {
  const out = [];
  const start = nowMs - (DAYS + 2) * 24 * HOUR;
  for (let i = 0; i < DAYS + 3; i++) out.push({ fromMs: start + i * 24 * HOUR, toMs: start + (i + 1) * 24 * HOUR });
  return out;
}

export const mb = (bytes) => `${(Number(bytes) / 1_048_576).toFixed(1)} MB`;
