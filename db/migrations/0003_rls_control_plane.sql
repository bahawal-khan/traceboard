-- Row Level Security, grants and lookup_key for the control plane (docs/DATA_MODEL.md section 5).
-- Fail closed: with no app.project_ids / app.owner_id every tenant query sees zero rows.
-- Statements are separated by statement-breakpoint markers for the migration runner.

CREATE FUNCTION app_project_ids() RETURNS uuid[]
  LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(string_to_array(NULLIF(current_setting('app.project_ids', true), ''), ',')::uuid[], '{}'::uuid[]) $$;
--> statement-breakpoint
CREATE FUNCTION app_owner_id() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.owner_id', true), '') $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_project_ids() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_owner_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_project_ids() TO app_rw;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_owner_id() TO app_rw;
--> statement-breakpoint

-- Tables keyed by project_id: one isolation policy for all commands.
-- (Static list of table names; privileges below limit which commands exist at all.)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_members','api_keys','provider_keys','budgets','alerts','jobs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (project_id = ANY (app_project_ids())) WITH CHECK (project_id = ANY (app_project_ids()))', t);
    -- api_keys is deliberately NOT forced: its owner (migrator) must bypass RLS so the
    -- SECURITY DEFINER lookup_key() can resolve a key before any project is known.
    -- app_rw is not the owner, so it stays fully subject to the policy.
    IF t <> 'api_keys' THEN
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint

-- projects: owner-scoped. An API-key context (project ids only) may read its project, never create or delete.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY projects_select ON projects FOR SELECT
  USING (owner_id = app_owner_id() OR id = ANY (app_project_ids()));
--> statement-breakpoint
CREATE POLICY projects_insert ON projects FOR INSERT
  WITH CHECK (owner_id = app_owner_id() AND NOT is_demo);
--> statement-breakpoint
CREATE POLICY projects_update ON projects FOR UPDATE
  USING (owner_id = app_owner_id() OR id = ANY (app_project_ids()))
  WITH CHECK (owner_id = app_owner_id() OR id = ANY (app_project_ids()));
--> statement-breakpoint
CREATE POLICY projects_delete ON projects FOR DELETE
  USING (owner_id = app_owner_id());
--> statement-breakpoint

-- audit_log: owner-scoped, append-only.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_isolation ON audit_log
  USING (owner_id = app_owner_id()) WITH CHECK (owner_id = app_owner_id());
--> statement-breakpoint

-- Least-privilege grants (explicit per table, no default privileges).
GRANT SELECT, INSERT, DELETE ON projects TO app_rw;
--> statement-breakpoint
GRANT UPDATE (name, capture_content, content_retention_days, last_viewed_at) ON projects TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON project_members TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON api_keys TO app_rw;
--> statement-breakpoint
GRANT UPDATE (last_used_at, revoked_at) ON api_keys TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON provider_keys TO app_rw;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON provider_keys TO app_rw;
--> statement-breakpoint
GRANT SELECT ON model_prices TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON budgets TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON alerts TO app_rw;
--> statement-breakpoint
GRANT UPDATE (resolved_at) ON alerts TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_log TO app_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO app_rw;
--> statement-breakpoint

-- The only cross-tenant read: resolve an API key hash to its project. Returns nothing for
-- unknown or revoked keys. SECURITY DEFINER runs as the owner (migrator), who bypasses RLS on api_keys.
CREATE FUNCTION lookup_key(p_hash text)
  RETURNS TABLE (project_id uuid, key_id uuid, scopes text[])
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT k.project_id, k.id, k.scopes FROM public.api_keys k WHERE k.key_hash = p_hash AND k.revoked_at IS NULL LIMIT 1 $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lookup_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lookup_key(text) TO app_rw;
