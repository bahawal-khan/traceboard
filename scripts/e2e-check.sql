-- Read-only queries for the manual end-to-end check of the ingest API, the Python SDK demo and the OTLP endpoint.
-- Run as the migrator role (it has read-only maintenance policies on these tables; the runtime role would need a tenant context):
--
--   psql "$MIGRATION_DATABASE_URL" -v project="'<project uuid from the dashboard URL>'" -f scripts/e2e-check.sql
--
-- Nothing here changes data and nothing here prints a secret (api_keys is not queried). Prompt text is never stored by default,
-- so only hashes, counts and metadata appear.
\set ON_ERROR_STOP on
\pset pager off

\echo '== 1. events by kind (the SDK demo with its default seed sends 77: agent 14, llm 31, retrieval 18, tool 14)'
select kind, count(*) as events from events where project_id = :project::uuid group by kind order by kind;

\echo '== 2. newest LLM events: provider, model, total input tokens, output, cached subset, time to first token, server-computed cost'
select occurred_at, provider, model, input_tokens, output_tokens, cached_tokens, ttft_ms, cost_usd
  from events where project_id = :project::uuid and kind = 'llm' order by occurred_at desc limit 6;

\echo '== 3. the demo run with a failing tool: status error and a redacted message (no email address)'
select occurred_at, kind, name, status, error from events where project_id = :project::uuid and status = 'error' order by occurred_at desc limit 5;

\echo '== 4. the looping demo run: one search_docs call repeated with the SAME args_hash (this is what Guard will stop in Phase 4)'
select args_hash, count(*) as repeats from events
 where project_id = :project::uuid and name = 'search_docs' and args_hash is not null group by args_hash order by repeats desc limit 3;

\echo '== 5. OTLP spans (run sdk/python/examples/otlp_demo.py): expect 4 rows per run; the plain HTTP span is dropped by the GenAI-only filter'
select occurred_at, kind, name, model, provider, input_tokens, output_tokens, cached_tokens, ttft_ms, status, thread_id, span_id, parent_id
  from events where project_id = :project::uuid and name in ('invoke_agent support', 'workflow.step', 'chat gpt-4o', 'execute_tool search')
 order by occurred_at desc limit 12;
select count(*) as http_span_rows_should_be_0 from events where project_id = :project::uuid and name = 'GET /health';

\echo '== 6. privacy: no content stored by default, and prompts only as hashes'
select count(*) as content_rows_should_be_0 from event_content where project_id = :project::uuid;
select count(*) filter (where prompt_hash is not null) as events_with_prompt_hash, count(*) filter (where user_id_hash is not null) as events_with_user_hash
  from events where project_id = :project::uuid;

\echo '== 7. counters written by the same statement as the events: usage per day, then per-minute rollups'
select day, events, requests, cost_micro, content_rows from usage_daily where project_id = :project::uuid order by day desc limit 3;
select bucket, model, calls, input_tokens, output_tokens, cost_micro, errors from metrics_minute
 where project_id = :project::uuid order by bucket desc, model limit 10;

\echo '== 8. storage guard state (global): level ok/warn/critical and the conserve flag'
select key, value, updated_at from app_state where key in ('storage_level', 'conserve') order by key;
