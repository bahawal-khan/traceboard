// The getLiveSince statement with numbered placeholders, for scripts/explain-live.mjs.
// COPY of the template in lib/repo/live.ts (`liveStatement`): .mjs cannot import TypeScript. tests/live-repo.test.ts builds the
// real statement with a recording driver and fails when the text or the parameter order drifts. Pure: no environment, no database.

export const LIVE_SCAN_CAP = 1_000; // LIVE_LIMITS.maxEvents (test-checked)
export const LIVE_SETTLE_MS = 1_000; // LIVE_LIMITS.settleMs (test-checked)
export const LIVE_TRACE_LIMIT = 5; // LIVE_LIMITS.recentTraces (test-checked)
export const LIVE_OCCURRED_SLACK_MS = 25 * 3_600_000; // LIVE_LIMITS.occurredSlackMs (test-checked)
export const LIVE_TRACE_LOOKBACK_MS = 14 * 24 * 3_600_000; // LIVE_LIMITS.traceLookbackMs (test-checked)

export const LIVE_SQL = `with fresh as (
select id, received_at, trace_id, status
from events
where $1::timestamptz is not null
and project_id = $2::uuid
and occurred_at >= $3::timestamptz and occurred_at < $4::timestamptz
and received_at <= now() - $5::int * interval '1 millisecond'
and (received_at, id) > ($6::timestamptz, $7::uuid)
order by received_at, id
limit $8::int
), kept as (
select id, received_at, trace_id, status from fresh order by received_at, id limit $9::int
), tot as (
select count(*)::int as ev_count,
count(*) filter (where status = 'error')::int as err_count,
count(distinct trace_id)::int as trace_count,
(select count(*) from fresh) > $10::int as truncated
from kept
), nxt as (
select case when tot.truncated then l.received_at
when $11::timestamptz > h.horizon then $12::timestamptz
else h.horizon end as ts,
case when tot.truncated then l.id
when $13::timestamptz > h.horizon then $14::uuid
else 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid end as id
from tot
cross join (select now() - $15::int * interval '1 millisecond' as horizon) h
left join (select received_at, id from kept order by received_at desc, id desc limit 1) l on true
), recent as (
select trace_id, max(received_at) as last_r from kept where trace_id is not null
group by trace_id order by last_r desc, trace_id desc limit $16::int
), tr as (
select e.trace_id,
min(e.occurred_at) as start_at,
max(e.occurred_at + coalesce(e.latency_ms, 0) * interval '1 millisecond') as end_at,
count(*) as spans,
count(*) filter (where e.status = 'error') as errors,
sum(coalesce(e.input_tokens, 0) + coalesce(e.output_tokens, 0)) as tokens,
sum(e.cost_usd) as cost,
count(*) filter (where e.cost_usd is null and e.model is not null and e.model <> '') as unpriced,
bool_or(e.parent_id is null) as has_root,
(array_agg(e.name order by e.occurred_at) filter (where e.parent_id is null))[1] as root_name
from events e join recent r on r.trace_id = e.trace_id
where e.project_id = $17::uuid
and e.occurred_at >= $18::timestamptz and e.occurred_at < $19::timestamptz
group by e.trace_id
)
select tot.ev_count::text as ev_count, tot.err_count::text as err_count, tot.trace_count::text as trace_count, tot.truncated,
to_char(nxt.ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as next_ts,
nxt.id::text as next_id,
p.trace_id,
floor(extract(epoch from p.start_at) * 1000)::bigint::text as started_at_ms,
floor(extract(epoch from (p.end_at - p.start_at)) * 1000)::bigint::text as duration_ms,
p.spans::text as spans, p.errors::text as errors, p.tokens::text as tokens,
round(p.cost * 1000000)::bigint::text as cost_micro,
p.unpriced::text as unpriced, p.has_root, p.root_name
from tot cross join nxt left join tr p on true
order by p.start_at desc nulls last, p.trace_id desc`;

/**
 * Parameters $1..$19 of LIVE_SQL, in the order of liveStatement. `cursor` null = the baseline / reset path (no table read).
 * @param {{ projectId: string, nowMs: number, cursor?: { receivedAt: string, id: string, ms: number } | null }} a
 */
export function liveParams({ projectId, nowMs, cursor = null }) {
  const lowerMs = (cursor ? cursor.ms : nowMs) - LIVE_OCCURRED_SLACK_MS;
  const upperMs = nowMs + LIVE_OCCURRED_SLACK_MS;
  const ts = cursor?.receivedAt ?? null;
  const id = cursor?.id ?? null;
  return [
    ts, projectId, new Date(lowerMs).toISOString(), new Date(upperMs).toISOString(), LIVE_SETTLE_MS, ts, id, LIVE_SCAN_CAP + 1,
    LIVE_SCAN_CAP, LIVE_SCAN_CAP,
    ts, ts, ts, id, LIVE_SETTLE_MS,
    LIVE_TRACE_LIMIT, projectId, new Date(nowMs - LIVE_TRACE_LOOKBACK_MS).toISOString(), new Date(upperMs).toISOString(),
  ];
}
