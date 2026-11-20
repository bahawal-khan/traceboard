import { neon } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";

/**
 * Guard for future tables: every table in the public schema must have row level security enabled and
 * forced, unless it is on a short, reviewed allowlist. Runs as app_rw. Skipped without DATABASE_URL.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

/** Global tables with no tenant data (and no RLS): reviewed individually. */
const GLOBAL_TABLES = new Set(["app_state", "model_prices"]);
/** RLS enabled but intentionally not forced, because a SECURITY DEFINER function owned by the table owner must read them. */
const NOT_FORCED = new Set(["api_keys", "app_users"]);

run("row level security coverage", () => {
  const sql = neon(url!);

  it("every public table is either allowlisted as global or has RLS enabled and forced", async () => {
    const rows = await sql`
      select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
        from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition`;
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const r of rows) {
      if (GLOBAL_TABLES.has(r.name)) continue;
      expect(r.rls, `${r.name}: row level security must be enabled`).toBe(true);
      if (!NOT_FORCED.has(r.name)) expect(r.forced, `${r.name}: row level security must be forced`).toBe(true);
    }
  });

  it("every table with a project_id column is protected by a policy that mentions it", async () => {
    const rows = await sql`
      select c.relname as name, exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as has_policy
        from pg_class c
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'project_id' and not a.attisdropped
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition`;
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) expect(r.has_policy, `${r.name} has no policy`).toBe(true);
  });

  it("the runtime role is not a superuser, owner or BYPASSRLS role (so RLS always applies)", async () => {
    const [r] = await sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
    const [owned] = await sql`select count(*)::int as n from pg_tables where schemaname = 'public' and tableowner = current_user`;
    expect(owned.n).toBe(0);
  });
});
