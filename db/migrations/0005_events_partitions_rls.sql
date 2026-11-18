-- events (monthly range partitions by occurred_at), partition management, RLS and grants
-- for the events-side tables (docs/DATA_MODEL.md sections 2, 3, 5, 6).

CREATE TABLE events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trace_id text, span_id text, parent_id text, thread_id text,
  kind text, name text, model text, provider text,
  input_tokens int, output_tokens int, cached_tokens int,
  latency_ms int, ttft_ms int, cost_usd numeric(12,6),
  status text, error text, prompt_hash text, args_hash text, user_id_hash text, tags text[],
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at),
  UNIQUE (project_id, event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint
CREATE INDEX events_project_time_idx ON events (project_id, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX events_project_trace_idx ON events (project_id, trace_id);
--> statement-breakpoint
CREATE INDEX events_project_thread_idx ON events (project_id, thread_id) WHERE thread_id IS NOT NULL;
--> statement-breakpoint

-- Create monthly partitions (UTC month boundaries). Idempotent. Returns how many were created.
-- SECURITY DEFINER: runs as the owner (migrator) because app_rw has no DDL rights. Inputs are
-- a date and an int only; partition names are generated, never taken from the caller.
CREATE FUNCTION ensure_event_partitions(p_start date, p_months int) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn$
DECLARE
  i int;
  m_start timestamp;
  m_end timestamp;
  pname text;
  created int := 0;
BEGIN
  IF p_start < DATE '2000-01-01' OR p_start > DATE '2100-01-01' THEN
    RAISE EXCEPTION 'ensure_event_partitions: start out of range';
  END IF;
  IF p_months < 1 OR p_months > 24 THEN
    RAISE EXCEPTION 'ensure_event_partitions: months must be 1..24';
  END IF;
  FOR i IN 0 .. p_months - 1 LOOP
    m_start := date_trunc('month', p_start::timestamp) + make_interval(months => i);
    m_end := m_start + INTERVAL '1 month';
    pname := 'events_y' || to_char(m_start, 'YYYY') || 'm' || to_char(m_start, 'MM');
    IF to_regclass(format('public.%I', pname)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.events FOR VALUES FROM (%L) TO (%L)',
        pname,
        (m_start AT TIME ZONE 'UTC')::text,
        (m_end AT TIME ZONE 'UTC')::text);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$fn$;
--> statement-breakpoint

-- Retention = detach + drop whole partitions that ended before now() - 14 days.
-- Deliberately takes NO argument: the policy (RETENTION.eventsDays in lib/quotas.ts) is a constant
-- inside the function, so a caller cannot choose a shorter window. Changing it needs a new migration.
-- Returns the number of partitions dropped.
CREATE FUNCTION drop_old_event_partitions() RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn$
DECLARE
  r record;
  retention CONSTANT interval := INTERVAL '14 days';
  cutoff timestamptz := now() - retention;
  dropped int := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS name,
           substring(pg_get_expr(c.relpartbound, c.oid) FROM 'TO \(''([^'']+)''\)')::timestamptz AS upper_bound
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.oid = 'public.events'::regclass
  LOOP
    IF r.upper_bound <= cutoff THEN
      EXECUTE format('ALTER TABLE public.events DETACH PARTITION public.%I', r.name);
      EXECUTE format('DROP TABLE public.%I', r.name);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ensure_event_partitions(date, int) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION drop_old_event_partitions() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ensure_event_partitions(date, int) TO app_rw;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION drop_old_event_partitions() TO app_rw;
--> statement-breakpoint

-- Previous, current and next month: occurred_at is clamped to now() +/- 24h, so these cover it.
SELECT ensure_event_partitions((date_trunc('month', now()) - INTERVAL '1 month')::date, 3);
--> statement-breakpoint

-- RLS: same tenant isolation policy, forced, on every events-side table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['events','event_content','metrics_minute','metrics_hourly','usage_daily','budget_usage']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (project_id = ANY (app_project_ids())) WITH CHECK (project_id = ANY (app_project_ids()))', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Grants. Only the parent table is granted; partitions get no app_rw privilege, so they can
-- only be reached through the RLS-protected parent. events: no UPDATE/DELETE (retention drops partitions).
GRANT SELECT, INSERT ON events TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON event_content TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON metrics_minute TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON metrics_hourly TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON usage_daily TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON budget_usage TO app_rw;
