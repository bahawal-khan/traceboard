-- P2.11a: SQL for the daily job (docs/PHASES.md "P2.11", docs/DATA_MODEL.md "Daily job functions").
--
-- WHO RUNS IT. The job is a Next.js route on Vercel, and the only database credentials in the Vercel runtime are
-- app_rw (DATABASE_URL, never the migrator) and the new `app_job` role (JOB_DATABASE_URL). app_job owns nothing, has NO
-- table privileges (except app_state, a global key/value table) and can only EXECUTE the functions below. app_rw can NOT
-- call any destructive or partition function after this migration, so a bug or injection in a tenant request path cannot
-- trigger deletes or DDL. Every function is SECURITY DEFINER (runs as migrator, the table owner), pins search_path, and
-- takes no argument that could widen what it deletes: retention windows are constants inside the functions (kept in step
-- with lib/quotas.ts RETENTION by tests/daily-job-sql.test.ts); a caller can only ask for LESS (older cutoff, smaller batch).
--
-- RLS. The events-side tables are FORCE ROW LEVEL SECURITY, which applies to their owner too, so a definer function
-- owned by migrator would see zero rows. Targeted policies for the migrator ROLE ONLY (never app_rw, never PUBLIC) let the
-- cleanup functions see and delete rows across tenants. Event rows are deleted through the PARTITIONS directly (partitions
-- carry no RLS of their own), so `events` itself gets a SELECT policy only (needed by the orphan check).
--
-- Re-running is safe: every function is idempotent, deletes in bounded batches with one statement per table, and a run cut
-- off halfway rolls back its own batch (a function is one transaction) and the next run simply continues.
-- Requires the app_job role: `npm run db:setup-roles` (with APP_JOB_PASSWORD) creates it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_job') THEN
    RAISE EXCEPTION 'role app_job does not exist: run "npm run db:setup-roles" with APP_JOB_PASSWORD set, then migrate again';
  END IF;
END
$$;
--> statement-breakpoint

-- Content rows stored per project per UTC day (the ingest statement increments it in P2.11c; cap = QUOTAS.contentRowsPerDayPerProject).
ALTER TABLE usage_daily ADD COLUMN content_rows bigint NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Expired-event lookups filter on occurred_at only (no project_id), which the (project_id, occurred_at) index cannot serve.
-- A BRIN index is tiny (kilobytes) and effective because events are appended in time order.
CREATE INDEX events_occurred_brin ON events USING brin (occurred_at);
--> statement-breakpoint

-- Maintenance policies, for the migrator role only (see the header).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['events', 'event_content', 'metrics_minute', 'metrics_hourly', 'usage_daily', 'budget_usage', 'budgets']
  LOOP
    EXECUTE format('CREATE POLICY maintenance_select ON %I FOR SELECT TO migrator USING (true)', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['event_content', 'metrics_minute', 'metrics_hourly', 'usage_daily', 'budget_usage']
  LOOP
    EXECUTE format('CREATE POLICY maintenance_delete ON %I FOR DELETE TO migrator USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ---- partitions -------------------------------------------------------------------------------------------------------

-- Pure policy: a monthly partition may be dropped only when it ENDS before now() - 14 days AND before the start of the
-- current UTC month, so the current and next month can never qualify. Separate from the dropping loop so it can be tested
-- with synthetic clocks. 14 days = RETENTION.eventsDays (lib/quotas.ts).
CREATE FUNCTION event_partition_is_droppable(p_upper timestamptz, p_now timestamptz) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, public
  AS $$
    SELECT p_upper <= p_now - INTERVAL '14 days'
       AND p_upper <= (date_trunc('month', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  $$;
--> statement-breakpoint

-- Replaces the 0005 version: same name, no argument, same 14-day retention, plus the never-current-or-next guard and a lock timeout
-- (DETACH/DROP need a brief exclusive lock on events; if ingest holds it the call fails fast and the next run retries).
CREATE OR REPLACE FUNCTION drop_old_event_partitions() RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  SET lock_timeout = '3s'
  AS $fn$
DECLARE
  r record;
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
    IF public.event_partition_is_droppable(r.upper_bound, now()) THEN
      EXECUTE format('ALTER TABLE public.events DETACH PARTITION public.%I', r.name);
      EXECUTE format('DROP TABLE public.%I', r.name);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END
$fn$;
--> statement-breakpoint

-- The job creates the CURRENT and NEXT UTC month only (never the previous one: drop_old_event_partitions would drop it again).
CREATE FUNCTION job_ensure_partitions() RETURNS int
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT public.ensure_event_partitions((date_trunc('month', now() AT TIME ZONE 'UTC'))::date, 2) $$;
--> statement-breakpoint

-- Health check: does the partition ingest needs next month exist? The job fails (and so alerts) when it does not.
CREATE FUNCTION events_partition_health()
  RETURNS TABLE (current_partition text, current_exists boolean, next_partition text, next_exists boolean, partition_count int)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH m AS (
      SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), '"events_y"YYYY"m"MM') AS cur,
             to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + INTERVAL '1 month', '"events_y"YYYY"m"MM') AS nxt
    ), parts AS (
      SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'public.events'::regclass
    )
    SELECT m.cur, EXISTS (SELECT 1 FROM parts WHERE parts.relname = m.cur),
           m.nxt, EXISTS (SELECT 1 FROM parts WHERE parts.relname = m.nxt),
           (SELECT count(*)::int FROM parts)
      FROM m
  $$;
--> statement-breakpoint

-- ---- events -----------------------------------------------------------------------------------------------------------

-- Deletes at most p_batch events older than the cutoff, inside live monthly partitions, oldest partition first. Returns the
-- number deleted. The default cutoff is now() - 14 days (RETENTION.eventsDays); a caller may pass an OLDER cutoff (never a
-- newer one: that raises), so nothing inside the retention window can be deleted through this function.
-- Rows are picked by ctid in one statement per partition, so a batch is bounded and a failed or cut-off call changes nothing.
CREATE FUNCTION purge_expired_events(p_batch int, p_cutoff timestamptz DEFAULT NULL) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn$
DECLARE
  retention CONSTANT interval := INTERVAL '14 days';
  v_newest timestamptz := now() - retention;
  v_cutoff timestamptz;
  r record;
  v_left int;
  v_done int := 0;
  n int;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 50000 THEN
    RAISE EXCEPTION 'purge_expired_events: batch must be between 1 and 50000';
  END IF;
  v_cutoff := COALESCE(p_cutoff, v_newest);
  IF v_cutoff > v_newest THEN
    RAISE EXCEPTION 'purge_expired_events: cutoff is inside the retention window';
  END IF;
  v_left := p_batch;
  FOR r IN
    SELECT c.relname AS name,
           substring(pg_get_expr(c.relpartbound, c.oid) FROM 'FROM \(''([^'']+)''\)')::timestamptz AS lower_bound
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'public.events'::regclass
     ORDER BY 2
  LOOP
    EXIT WHEN v_left <= 0;
    CONTINUE WHEN r.lower_bound >= v_cutoff; -- nothing in this partition can be older than the cutoff
    EXECUTE format(
      'DELETE FROM public.%I WHERE ctid = ANY (ARRAY(SELECT ctid FROM public.%I WHERE occurred_at < $1 ORDER BY ctid LIMIT $2))',
      r.name, r.name) USING v_cutoff, v_left;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_done := v_done + n;
    v_left := v_left - n;
  END LOOP;
  RETURN v_done;
END
$fn$;
--> statement-breakpoint

-- ---- content ----------------------------------------------------------------------------------------------------------

-- Content past its expires_at (the project's content_retention_days, enforced at insert).
CREATE FUNCTION purge_expired_content(p_batch int) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn$
DECLARE n int;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 50000 THEN
    RAISE EXCEPTION 'purge_expired_content: batch must be between 1 and 50000';
  END IF;
  DELETE FROM public.event_content
   WHERE ctid = ANY (ARRAY(SELECT ctid FROM public.event_content WHERE expires_at < now() ORDER BY ctid LIMIT p_batch));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;
--> statement-breakpoint

-- Content whose event no longer exists (the event was purged before the content expired). The ingest statement inserts an
-- event and its content in one statement, so a live event always exists when its content does. The events lookup relies on
-- the maintenance_select policy: WITHOUT it every content row would look orphaned (tests/db/daily-job.test.ts guards this).
CREATE FUNCTION purge_orphaned_content(p_batch int) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn$
DECLARE n int;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 50000 THEN
    RAISE EXCEPTION 'purge_orphaned_content: batch must be between 1 and 50000';
  END IF;
  DELETE FROM public.event_content
   WHERE ctid = ANY (ARRAY(
     SELECT c.ctid FROM public.event_content c
      WHERE NOT EXISTS (SELECT 1 FROM public.events e WHERE e.project_id = c.project_id AND e.event_id = c.event_id)
      ORDER BY c.ctid LIMIT p_batch));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;
--> statement-breakpoint

-- How many content rows may this project still store today (UTC)? SECURITY INVOKER on purpose: it reads usage_daily under the
-- caller's RLS, so a tenant sees only its own counter, and the ingest path (app_rw) can use it. p_cap is passed by the caller
-- (QUOTAS.contentRowsPerDayPerProject); there is no default so the number lives in one place.
CREATE FUNCTION content_slots_left(p_project_id uuid, p_cap int) RETURNS int
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  AS $$
    SELECT GREATEST(p_cap - COALESCE(
      (SELECT u.content_rows FROM public.usage_daily u WHERE u.project_id = p_project_id AND u.day = (now() AT TIME ZONE 'UTC')::date), 0), 0)::int
  $$;
--> statement-breakpoint

-- ---- rollups ----------------------------------------------------------------------------------------------------------

-- One bounded batch per table (so a call deletes at most 4 x p_batch rows):
--   metrics_minute  older than 48 hours       (RETENTION.minuteRollupsHours)
--   metrics_hourly  older than 90 days        (RETENTION.hourlyRollupsDays)
--   budget_usage    day keys older than 7 days, month keys older than 2 months (run-scoped keys carry no date and are kept)
--   usage_daily     older than 400 days       (RETENTION.usageDailyDays)
CREATE FUNCTION purge_rollups(p_batch int)
  RETURNS TABLE (minute_rows int, hourly_rows int, budget_rows int, usage_rows int)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn$
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 50000 THEN
    RAISE EXCEPTION 'purge_rollups: batch must be between 1 and 50000';
  END IF;

  DELETE FROM public.metrics_minute
   WHERE ctid = ANY (ARRAY(SELECT ctid FROM public.metrics_minute WHERE bucket < now() - INTERVAL '48 hours' ORDER BY ctid LIMIT p_batch));
  GET DIAGNOSTICS minute_rows = ROW_COUNT;

  DELETE FROM public.metrics_hourly
   WHERE ctid = ANY (ARRAY(SELECT ctid FROM public.metrics_hourly WHERE bucket < now() - INTERVAL '90 days' ORDER BY ctid LIMIT p_batch));
  GET DIAGNOSTICS hourly_rows = ROW_COUNT;

  DELETE FROM public.budget_usage
   WHERE ctid = ANY (ARRAY(
     SELECT bu.ctid FROM public.budget_usage bu JOIN public.budgets b ON b.id = bu.budget_id
      WHERE (b.period = 'day' AND bu.period_key < to_char((now() AT TIME ZONE 'UTC')::date - 7, 'YYYY-MM-DD'))
         OR (b.period = 'month' AND bu.period_key < to_char(date_trunc('month', now() AT TIME ZONE 'UTC') - INTERVAL '2 months', 'YYYY-MM'))
      ORDER BY bu.ctid LIMIT p_batch));
  GET DIAGNOSTICS budget_rows = ROW_COUNT;

  DELETE FROM public.usage_daily
   WHERE ctid = ANY (ARRAY(SELECT ctid FROM public.usage_daily WHERE day < (now() AT TIME ZONE 'UTC')::date - 400 ORDER BY ctid LIMIT p_batch));
  GET DIAGNOSTICS usage_rows = ROW_COUNT;

  RETURN NEXT;
  RETURN;
END
$fn$;
--> statement-breakpoint

-- ---- storage guard ----------------------------------------------------------------------------------------------------

-- Sizes in bytes, including indexes. events_budget_bytes = SIZING.databaseBytes x SIZING.eventsShare = 1 GB x 0.6 (lib/quotas.ts).
-- The job compares database_bytes with the 70% / 85% thresholds and events_ratio with 1.0.
CREATE FUNCTION storage_report()
  RETURNS TABLE (database_bytes bigint, events_bytes bigint, content_bytes bigint, rollup_bytes bigint, events_budget_bytes bigint, events_ratio numeric)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH s AS (
      SELECT pg_database_size(current_database())::bigint AS db,
             COALESCE((SELECT sum(pg_total_relation_size(c.oid)) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                        WHERE i.inhparent = 'public.events'::regclass), 0)::bigint AS ev,
             pg_total_relation_size('public.event_content'::regclass)::bigint AS ct,
             (pg_total_relation_size('public.metrics_minute'::regclass) + pg_total_relation_size('public.metrics_hourly'::regclass)
              + pg_total_relation_size('public.usage_daily'::regclass) + pg_total_relation_size('public.budget_usage'::regclass))::bigint AS ro
    )
    SELECT s.db, s.ev, s.ct, s.ro, 600000000::bigint, round(s.ev / 600000000.0, 4) FROM s
  $$;
--> statement-breakpoint

-- ---- permissions ------------------------------------------------------------------------------------------------------
-- Explicit REVOKE FROM PUBLIC for every function (Postgres grants EXECUTE to PUBLIC by default), then grant only what is needed.
REVOKE ALL ON FUNCTION event_partition_is_droppable(timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION drop_old_event_partitions() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ensure_event_partitions(date, int) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION job_ensure_partitions() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION events_partition_health() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_expired_events(int, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_expired_content(int) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_orphaned_content(int) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_rollups(int) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION storage_report() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION content_slots_left(uuid, int) FROM PUBLIC;
--> statement-breakpoint

-- app_rw loses the 0005 grants: the tenant request path no longer has any partition or purge function.
REVOKE ALL ON FUNCTION ensure_event_partitions(date, int) FROM app_rw;
--> statement-breakpoint
REVOKE ALL ON FUNCTION drop_old_event_partitions() FROM app_rw;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION event_partition_is_droppable(timestamptz, timestamptz) TO app_job;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION drop_old_event_partitions() TO app_job;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ensure_event_partitions(date, int) TO app_job;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION job_ensure_partitions() TO app_job;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION events_partition_health() TO app_job;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_events(int, timestamptz) TO app_job;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_content(int) TO app_job;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_orphaned_content(int) TO app_job;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_rollups(int) TO app_job;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION storage_report() TO app_job;
--> statement-breakpoint

-- The one tenant-path helper: invoker rights, RLS applies, no cross-tenant read.
GRANT EXECUTE ON FUNCTION content_slots_left(uuid, int) TO app_rw;
--> statement-breakpoint

-- app_state is global (conserve flags, storage readings): the job writes its findings there. No DELETE.
GRANT SELECT, INSERT, UPDATE ON app_state TO app_job;
