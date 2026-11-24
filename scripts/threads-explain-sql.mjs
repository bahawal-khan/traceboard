// The listThreads and getThread statements with numbered placeholders, for scripts/explain-threads.mjs.
// COPIES of the templates in lib/repo/threads.ts (`threadListStatement`) and lib/repo/thread-detail.ts (`threadDetailStatement`):
// .mjs cannot import TypeScript. tests/threads-explain.test.ts builds the real statements with a recording driver and fails when
// a text or a parameter order drifts. Pure: no environment, no database.

export const LIST_SCAN_CAP = 30_600; // THREAD_LIMITS.maxScanRows (test-checked)
export const DETAIL_SCAN_CAP = 5_000; // THREAD_DETAIL_LIMITS.maxScanEvents (test-checked)
export const DETAIL_TURN_CAP = 200; // THREAD_DETAIL_LIMITS.maxTurns (test-checked)
const HOUR = 3_600_000;

export const LIST_SQL = `with scan as (
select thread_id, trace_id, status, model, input_tokens, output_tokens, cost_usd, occurred_at
from events
where project_id = $1::uuid and occurred_at >= $2::timestamptz and occurred_at < $3::timestamptz
and thread_id is not null
order by occurred_at desc
limit $4::int
), bounds as (
select count(*)::int as scanned, min(occurred_at) as oldest from scan
), kept as (
select s.* from scan s cross join bounds b where b.scanned <= $5::int or s.occurred_at > b.oldest
), agg as (
select thread_id,
min(occurred_at) as first_at,
max(occurred_at) as last_at,
count(distinct trace_id) as traces,
count(*) as spans,
count(*) filter (where status = 'error') as errors,
sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) as tokens,
sum(cost_usd) as cost,
count(*) filter (where cost_usd is null and model is not null and model <> '') as unpriced
from kept
group by thread_id
), page as (
select * from agg
where ($6::timestamptz is null or (last_at, thread_id) < ($7::timestamptz, $8::text))
order by last_at desc, thread_id desc
limit $9::int
)
select b.scanned, b.scanned > $10::int as truncated,
p.thread_id,
floor(extract(epoch from p.first_at) * 1000)::bigint::text as started_at_ms,
floor(extract(epoch from p.last_at) * 1000)::bigint::text as last_active_ms,
to_char(p.last_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_text,
p.traces::text as traces, p.spans::text as spans, p.errors::text as errors, p.tokens::text as tokens,
round(p.cost * 1000000)::bigint::text as cost_micro,
p.unpriced::text as unpriced
from bounds b left join page p on true
order by p.last_at desc nulls last, p.thread_id desc`;

export const DETAIL_SQL = `with scan as (
select trace_id, parent_id, name, status, model, input_tokens, output_tokens, latency_ms, cost_usd, occurred_at
from events
where project_id = $1::uuid and thread_id = $2::text
and occurred_at >= $3::timestamptz and occurred_at < $4::timestamptz
order by occurred_at asc
limit $5::int
), bounds as (
select count(*)::int as scanned, max(occurred_at) as newest from scan
), kept as (
select s.* from scan s cross join bounds b where b.scanned <= $6::int or s.occurred_at < b.newest
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
where trace_id is not null
group by trace_id
), page as (
select * from agg order by start_at asc, trace_id asc limit $7::int
)
select b.scanned, b.scanned > $8::int as truncated,
(select count(*) from kept where trace_id is null)::text as untraced,
p.trace_id,
floor(extract(epoch from p.start_at) * 1000)::bigint::text as started_at_ms,
floor(extract(epoch from (p.end_at - p.start_at)) * 1000)::bigint::text as duration_ms,
p.spans::text as spans, p.errors::text as errors, p.tokens::text as tokens,
round(p.cost * 1000000)::bigint::text as cost_micro,
p.unpriced::text as unpriced, p.has_root, p.root_name
from bounds b left join page p on true
order by p.start_at asc nulls last, p.trace_id asc`;

/** The 14-day list window (whole hours, ends with the current hour). */
export function listWindow(nowMs) {
  const toMs = (Math.floor(nowMs / HOUR) + 1) * HOUR;
  return { fromMs: toMs - 14 * 24 * HOUR, toMs };
}

/** The detail window: 14 days back from the end of the current hour, 24 h ahead of it (traceDetailWindow). */
export function detailWindow(nowMs) {
  const hourEnd = (Math.floor(nowMs / HOUR) + 1) * HOUR;
  return { fromMs: hourEnd - 14 * 24 * HOUR, toMs: hourEnd + 24 * HOUR };
}

/**
 * Parameters $1..$10 of LIST_SQL, in the order of threadListStatement.
 * @param {{ projectId: string, fromMs: number, toMs: number, cursor?: { lastActive: string, threadId: string } | null, limit?: number }} a
 */
export function listParams({ projectId, fromMs, toMs, cursor = null, limit = 50 }) {
  return [
    projectId, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), LIST_SCAN_CAP + 1, LIST_SCAN_CAP,
    cursor?.lastActive ?? null, cursor?.lastActive ?? null, cursor?.threadId ?? null,
    limit + 1, LIST_SCAN_CAP,
  ];
}

/** Parameters $1..$8 of DETAIL_SQL, in the order of threadDetailStatement. */
export function detailParams({ projectId, threadId, fromMs, toMs }) {
  return [
    projectId, threadId, new Date(fromMs).toISOString(), new Date(toMs).toISOString(),
    DETAIL_SCAN_CAP + 1, DETAIL_SCAN_CAP, DETAIL_TURN_CAP + 1, DETAIL_SCAN_CAP,
  ];
}
