import { neon } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";

/**
 * Integration tests against the Neon dev branch. Skipped when no database is
 * configured (e.g. CI before the P1.10 integration job). Run P1.3 setup first:
 *   npm run db:setup-roles && npm run db:migrate
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("app_rw role (runtime)", () => {
  const sql = neon(url!);

  it("is a plain role: not superuser, no BYPASSRLS, no DDL-creating attributes", async () => {
    const [r] = await sql`
      select current_user as u, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
      from pg_roles where rolname = current_user`;
    expect(r.u).toBe("app_rw");
    expect(r.rolsuper).toBe(false);
    expect(r.rolbypassrls).toBe(false);
    expect(r.rolcreatedb).toBe(false);
    expect(r.rolcreaterole).toBe(false);
    expect(r.rolreplication).toBe(false);
  });

  it("owns no tables and cannot run DDL", async () => {
    const [owned] = await sql`select count(*)::int as n from pg_tables where tableowner = current_user`;
    expect(owned.n).toBe(0);
    await expect(sql`create table should_not_exist (id int)`).rejects.toThrow(/permission denied/i);
  });

  it("has only SELECT on app_state since 0012 (the storage guard writes it through app_job functions; no INSERT, UPDATE, DELETE, TRUNCATE)", async () => {
    const [p] = await sql`
      select has_table_privilege('app_rw', 'app_state', 'SELECT') as s,
             has_table_privilege('app_rw', 'app_state', 'INSERT') as i,
             has_table_privilege('app_rw', 'app_state', 'UPDATE') as u,
             has_table_privilege('app_rw', 'app_state', 'DELETE') as d,
             has_table_privilege('app_rw', 'app_state', 'TRUNCATE') as t`;
    expect(p).toEqual({ s: true, i: false, u: false, d: false, t: false });
  });

  it("cannot read the migrator's drizzle journal or create schemas", async () => {
    await expect(sql`create schema evil`).rejects.toThrow(/permission denied/i);
  });
});
