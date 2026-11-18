-- MAX_USERS signup cap (P1.6b). app_users is written only through claim_user_slot().
-- RLS is enabled but NOT forced: the SECURITY DEFINER functions run as the owner (migrator) and must
-- see every row to count; app_rw is not the owner and may read only its own row.

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_row ON app_users FOR SELECT USING (user_id = app_owner_id());
--> statement-breakpoint
GRANT SELECT ON app_users TO app_rw;
--> statement-breakpoint

-- Atomically claim a slot: returns 'existing' | 'created' | 'full'.
-- Existing users are never locked out when the cap is reached. New users are serialised by a
-- transaction-level advisory lock, then the count is re-read (each plpgsql statement takes a fresh
-- READ COMMITTED snapshot), so two simultaneous signups cannot both take the last slot.
CREATE FUNCTION claim_user_slot(p_user_id text, p_max int) RETURNS text
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
  SELECT count(*) INTO n FROM public.app_users;
  IF n >= p_max THEN
    RETURN 'full';
  END IF;
  INSERT INTO public.app_users (user_id) VALUES (p_user_id);
  RETURN 'created';
END
$fn$;
--> statement-breakpoint

-- Frees the CALLER's own slot (account deletion). Takes no argument: it acts on app.owner_id only,
-- so one user can never release another's slot.
CREATE FUNCTION release_user_slot() RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn$
DECLARE
  v text := public.app_owner_id();
BEGIN
  IF v IS NULL THEN
    RETURN false;
  END IF;
  DELETE FROM public.app_users WHERE user_id = v;
  RETURN FOUND;
END
$fn$;
--> statement-breakpoint
-- Number of registered users (a single count; no ids are exposed). For the daily job and capacity display.
CREATE FUNCTION app_user_count() RETURNS int
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn$ SELECT count(*)::int FROM public.app_users $fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_count() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_count() TO app_rw;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_user_slot(text, int) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION release_user_slot() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_user_slot(text, int) TO app_rw;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION release_user_slot() TO app_rw;
