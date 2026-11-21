-- P2.11c2: storage-guard wiring (docs/PHASES.md "P2.11", docs/DATA_MODEL.md "Storage guard").
--
-- The daily job (role app_job) measures storage and records a LEVEL in app_state: ok / warn / critical.
--   warn     (>= 70%)  turns the existing `conserve` flag on, so ingest answers a long flush_hint_ms.
--   critical (>= 85%)  makes claim_user_slot refuse NEW users ('paused'); existing users and ingest keep working.
-- Retention is NOT shortened: the 14-day window stays pinned (owner decision).
-- HYSTERESIS: a level is entered at its threshold and left only `margin` (5 points) below it, so a reading that hovers at
-- 70% or 85% does not flip the flags every day. The numbers are constants of storage_level_for(), kept in step with
-- lib/quotas.ts STORAGE_GUARD by tests/storage-guard-sql.test.ts.
-- The measured ratio is the larger of: events size / the 600 MB events budget, and database size / 1 GB.
--
-- WHO MAY WRITE app_state. Only the owner (migrator, through the SECURITY DEFINER functions below). app_job loses its direct
-- table grant from 0011 and can only EXECUTE the functions, which write exactly two keys: `storage_level` and `conserve`.
-- app_rw loses INSERT and UPDATE on app_state (nothing in the runtime writes it; it keeps SELECT for the conserve read).

REVOKE INSERT, UPDATE ON app_state FROM app_rw;
--> statement-breakpoint
REVOKE ALL ON app_state FROM app_job;
--> statement-breakpoint

-- Pure: the level for a reading, given the previous level (hysteresis). No table access.
CREATE FUNCTION storage_level_for(p_previous text, p_ratio numeric) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, public
  AS $$
    SELECT CASE
      WHEN p_ratio >= 0.85 THEN 'critical'
      WHEN p_previous = 'critical' AND p_ratio >= 0.85 - 0.05 THEN 'critical'
      WHEN p_ratio >= 0.70 THEN 'warn'
      WHEN p_previous IN ('critical', 'warn') AND p_ratio >= 0.70 - 0.05 THEN 'warn'
      ELSE 'ok'
    END
  $$;
--> statement-breakpoint

-- Records a level and sets the flags. Idempotent: a repeat with the same level changes no row (updated_at only moves on a real
-- change). `conserve` is switched ON at warn/critical, and OFF only when the level returns to ok from warn/critical, so a flag
-- an operator set by hand while the level is ok is left alone. Overlapping runs are serialised by an advisory lock.
CREATE FUNCTION apply_storage_level(p_level text)
  RETURNS TABLE (level text, previous_level text, conserve boolean, signups_paused boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn$
DECLARE
  prev text;
  cons boolean;
BEGIN
  IF p_level IS NULL OR p_level NOT IN ('ok', 'warn', 'critical') THEN
    RAISE EXCEPTION 'apply_storage_level: invalid level';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('traceboard.storage_guard', 0));
  SELECT s.value #>> '{}' INTO prev FROM public.app_state s WHERE s.key = 'storage_level';
  IF prev IS NULL OR prev NOT IN ('ok', 'warn', 'critical') THEN
    prev := 'ok';
  END IF;

  INSERT INTO public.app_state (key, value, updated_at) VALUES ('storage_level', to_jsonb(p_level), now())
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
    WHERE public.app_state.value IS DISTINCT FROM excluded.value;

  IF p_level <> 'ok' THEN
    INSERT INTO public.app_state (key, value, updated_at) VALUES ('conserve', 'true'::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
      WHERE public.app_state.value IS DISTINCT FROM excluded.value;
  ELSIF prev <> 'ok' THEN
    INSERT INTO public.app_state (key, value, updated_at) VALUES ('conserve', 'false'::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
      WHERE public.app_state.value IS DISTINCT FROM excluded.value;
  END IF;

  SELECT COALESCE((SELECT s.value = 'true'::jsonb FROM public.app_state s WHERE s.key = 'conserve'), false) INTO cons;
  RETURN QUERY SELECT p_level, prev, cons, p_level = 'critical';
END
$fn$;
--> statement-breakpoint

-- What the job calls: measure, compute the level from the previous one, record it. Takes no argument, so the caller cannot
-- choose the level through this path.
CREATE FUNCTION apply_storage_guard()
  RETURNS TABLE (level text, previous_level text, ratio numeric, conserve boolean, signups_paused boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn$
DECLARE
  r numeric;
  prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('traceboard.storage_guard', 0));
  SELECT GREATEST(sr.events_ratio, sr.database_bytes::numeric / 1000000000) INTO r FROM public.storage_report() sr;
  SELECT s.value #>> '{}' INTO prev FROM public.app_state s WHERE s.key = 'storage_level';
  RETURN QUERY
    SELECT a.level, a.previous_level, round(r, 4), a.conserve, a.signups_paused
      FROM public.apply_storage_level(public.storage_level_for(prev, r)) a;
END
$fn$;
--> statement-breakpoint

-- New users are refused while the level is critical. Same checks and order as 0007; the only addition is the 'paused' answer
-- AFTER the existing-user checks, so an existing user is never affected and nothing changes for them.
CREATE OR REPLACE FUNCTION claim_user_slot(p_user_id text, p_max int) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn$
DECLARE
  n int;
BEGIN
  IF p_user_id IS NULL OR length(p_user_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'claim_user_slot: invalid user id';
  END IF;
  IF p_max IS NULL OR p_max < 1 OR p_max > 100000 THEN
    RAISE EXCEPTION 'claim_user_slot: invalid max';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_users WHERE user_id = p_user_id) THEN
    RETURN 'existing';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('traceboard.app_users', 0));
  IF EXISTS (SELECT 1 FROM public.app_users WHERE user_id = p_user_id) THEN
    RETURN 'existing';
  END IF;
  IF (SELECT s.value #>> '{}' FROM public.app_state s WHERE s.key = 'storage_level') = 'critical' THEN
    RETURN 'paused';
  END IF;
  SELECT count(*) INTO n FROM public.app_users;
  IF n >= p_max THEN
    RETURN 'full';
  END IF;
  INSERT INTO public.app_users (user_id) VALUES (p_user_id);
  RETURN 'created';
END
$fn$;
--> statement-breakpoint

-- Permissions: explicit REVOKE FROM PUBLIC, then app_job only. app_rw gets none of the new functions (claim_user_slot keeps its
-- existing grant to app_rw from 0007; CREATE OR REPLACE preserves it).
REVOKE ALL ON FUNCTION storage_level_for(text, numeric) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION apply_storage_level(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION apply_storage_guard() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION storage_level_for(text, numeric) TO app_job;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION apply_storage_level(text) TO app_job;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION apply_storage_guard() TO app_job;
