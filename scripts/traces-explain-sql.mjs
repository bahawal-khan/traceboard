// The listTraces statement with numbered placeholders, for scripts/explain-traces.mjs.
// A COPY of the template in lib/repo/traces.ts (`traceListStatement`): .mjs cannot import TypeScript. tests/seed-perf.test.ts
// builds the real statement with a recording driver and fails when this text or the parameter order drifts.
// Pure: no environment, no database.

export const SCAN_CAP = 30_600; // TRACE_LIMITS.maxScanRows (test-checked)
const HOUR = 3_600_000;

export const LIST_SQL = `with scan as (
select trace_id, parent_id, name, status, model, input_tokens, output_tokens, latency_ms, cost_usd, occurred_at
from events
where project_id = $1::uuid and occurred_at >= $2::timestamptz and occurred_at < $3::timestamptz
and trace_id is not null
order by occurred_at desc
limit $4::int
), bounds as (
select count(*)::int as scanned, min(occurred_at) as oldest from scan
), kept as (
select s.* from scan s cross join bounds b where b.scanned <= $5::int or s.occurred_at > b.oldest
), agg as (
select trace_id,
min(occurred_at) as start_at,
max(occurred_at + coalesce(latency_ms, 0) * interval '1 millisecond') as end_at,
count(*) as spans,
count(*) filter (where status = 'error') as errors,
sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) as tokens,
sum(cost_usd) as cost,
count(*) filter (where cost_usd is null and model is not null and model <> '') as unpriced,
bool_or(parent_id is null) as has_root,
(array_agg(name order by occurred_at) filter (where parent_id is null))[1] as root_name
from kept
group by trace_id
), page as (
select * from agg
where ($6::timestamptz is null or (start_at, trace_id) < ($7::timestamptz, $8::text))
and ($9::text is null or ($10::text = 'error') = (errors > 0))
order by start_at desc, trace_id desc
limit $11::int
)
select b.scanned, b.scanned > $12::int as truncated,
p.trace_id,
floor(extract(epoch from p.start_at) * 1000)::bigint::text as started_at_ms,
to_char(p.start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as start_text,
floor(extract(epoch from (p.end_at - p.start_at)) * 1000)::bigint::text as duration_ms,
p.spans::text as spans, p.errors::text as errors, p.tokens::text as tokens,
round(p.cost * 1000000)::bigint::text as cost_micro,
p.unpriced::text as unpriced, p.has_root, p.root_name
from bounds b left join page p on true
order by p.start_at desc nulls last, p.trace_id desc`;

/** The window listTraces uses for "the last 14 days": whole hours, ends with the current hour, 14 days long. */
export function listWindow(nowMs) {
  const toMs = (Math.floor(nowMs / HOUR) + 1) * HOUR;
  return { fromMs: toMs - 14 * 24 * HOUR, toMs };
}

/**
 * Parameter array in the order of the placeholders $1..$12 (same order as traceListStatement).
 * @param {{ projectId: string, fromMs: number, toMs: number, cursor?: { start: string, traceId: string } | null, status?: string | null, limit?: number }} a
 */
export function listParams({ projectId, fromMs, toMs, cursor = null, status = null, limit = 50 }) {
  return [
    projectId, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), SCAN_CAP + 1, SCAN_CAP,
    cursor?.start ?? null, cursor?.start ?? null, cursor?.traceId ?? null,
    status, status, limit + 1, SCAN_CAP,
  ];
}
