import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * RLS + grants for the control plane, as the runtime role `app_rw`.
 * Skipped without DATABASE_URL. Test rows use random owner ids; the only
 * leftovers are append-only audit_log rows (app_rw cannot delete them).
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

type T = NeonQueryFunctionInTransaction<false, false>;

run("control-plane RLS (app_rw)", () => {
  const sql = neon(url!);

  /** What withTenant() will do in P1.5: set_config first, in the same transaction. */
  const scoped = (owner: string | null, projectIds: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner ?? ""}, true), set_config('app.project_ids', ${projectIds.join(",")}, true)`,
      ...build(t),
    ]);
  const unscoped = (build: (t: T) => NeonQueryInTransaction[]) => sql.transaction(build);

  const A = { owner: `test_${randomUUID()}`, project: randomUUID() as string, keyHash: "", key: randomUUID() as string };
  const B = { owner: `test_${randomUUID()}`, project: randomUUID() as string, keyHash: "", key: randomUUID() as string };
  A.keyHash = createHash("sha256").update(`lm_test_${A.key}`).digest("hex");
  B.keyHash = createHash("sha256").update(`lm_test_${B.key}`).digest("hex");

  const seed = (x: typeof A) =>
    scoped(x.owner, [x.project], (t) => [
      t`insert into projects (id, owner_id, name) values (${x.project}, ${x.owner}, 'rls-test')`,
      t`insert into project_members (project_id, user_id, role) values (${x.project}, ${x.owner}, 'owner')`,
      t`insert into api_keys (project_id, key_hash, prefix) values (${x.project}, ${x.keyHash}, 'lm_test')`,
      t`insert into budgets (project_id, scope, period, limit_usd, action) values (${x.project}, 'project', 'day', 1, 'alert')`,
      t`insert into alerts (project_id, type, severity, message) values (${x.project}, 'test', 'info', 'm')`,
      t`insert into jobs (project_id, type, payload) values (${x.project}, 'test', '{}'::jsonb)`,
      t`insert into audit_log (owner_id, action) values (${x.owner}, 'test')`,
    ]);

  const PROJECT_TABLES = ["project_members", "api_keys", "provider_keys", "budgets", "alerts", "jobs"] as const;

  beforeAll(async () => {
    await seed(A);
    await seed(B);
  });

  afterAll(async () => {
    // Cascades to every child row (referential integrity bypasses RLS).
    await scoped(A.owner, [A.project], (t) => [t`delete from projects where id = ${A.project}`]);
    await scoped(B.owner, [B.project], (t) => [t`delete from projects where id = ${B.project}`]);
  });

  it("has RLS enabled on every tenant table, and FORCE on all but api_keys", async () => {
    const rows = await sql`
      select relname, relrowsecurity as rls, relforcerowsecurity as forced
      from pg_class where relname in ('projects','project_members','api_keys','provider_keys','budgets','alerts','jobs','audit_log')
        and relkind = 'r' and relnamespace = 'public'::regnamespace`;
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.rls, `${r.relname} rls`).toBe(true);
      expect(r.forced, `${r.relname} force`).toBe(r.relname !== "api_keys");
    }
  });

  it("fails closed: with no settings every tenant table returns zero rows", async () => {
    const results = await unscoped((t) => [
      t`select count(*)::int as n from projects`,
      ...PROJECT_TABLES.map((n) => t.query(`select count(*)::int as n from ${n}`)),
      t`select count(*)::int as n from audit_log`,
    ]);
    for (const [i, r] of results.entries()) expect(r[0].n, `query ${i}`).toBe(0);
  });

  it("fails closed with empty-string settings", async () => {
    const [, ...rows] = await scoped(null, [], (t) => [t`select count(*)::int as n from projects`, t`select count(*)::int as n from jobs`]);
    expect(rows[0][0].n).toBe(0);
    expect(rows[1][0].n).toBe(0);
  });

  it("scoped to A sees only A's rows in every table", async () => {
    const [, p, ...rest] = await scoped(A.owner, [A.project], (t) => [
      t`select id, owner_id from projects`,
      ...PROJECT_TABLES.filter((n) => n !== "provider_keys").map((n) => t.query(`select project_id from ${n}`)),
      t`select owner_id from audit_log`,
    ]);
    expect(p).toEqual([{ id: A.project, owner_id: A.owner }]);
    for (const rows of rest.slice(0, -1)) expect(new Set(rows.map((r) => r.project_id))).toEqual(new Set([A.project]));
    expect(new Set(rest.at(-1)!.map((r) => r.owner_id))).toEqual(new Set([A.owner]));
  });

  it("A cannot read B by id even when naming B's ids explicitly", async () => {
    const [, p, k, j] = await scoped(A.owner, [A.project], (t) => [
      t`select id from projects where id = ${B.project}`,
      t`select id from api_keys where project_id = ${B.project}`,
      t`select id from jobs where project_id = ${B.project}`,
    ]);
    expect([p.length, k.length, j.length]).toEqual([0, 0, 0]);
  });

  it("rejects inserting a row for B's project while scoped to A", async () => {
    for (const q of [
      (t: T) => t`insert into budgets (project_id, scope, period, limit_usd, action) values (${B.project}, 'project', 'day', 1, 'alert')`,
      (t: T) => t`insert into api_keys (project_id, key_hash, prefix) values (${B.project}, ${randomUUID()}, 'x')`,
      (t: T) => t`insert into jobs (project_id, type, payload) values (${B.project}, 'x', '{}'::jsonb)`,
      (t: T) => t`insert into alerts (project_id, type, severity, message) values (${B.project}, 'x', 'info', 'm')`,
    ]) {
      await expect(scoped(A.owner, [A.project], (t) => [q(t)])).rejects.toThrow(/row-level security/i);
    }
  });

  it("rejects creating a project owned by someone else, a demo project, or via an API-key context", async () => {
    await expect(
      scoped(A.owner, [A.project], (t) => [t`insert into projects (owner_id, name) values (${B.owner}, 'steal')`]),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      scoped(A.owner, [A.project], (t) => [t`insert into projects (owner_id, name, is_demo) values (${A.owner}, 'demo', true)`]),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      scoped(null, [A.project], (t) => [t`insert into projects (owner_id, name) values (${A.owner}, 'x')`]),
    ).rejects.toThrow(/row-level security/i);
  });

  it("silently affects zero rows when updating or deleting B's data while scoped to A", async () => {
    const [, upd, del] = await scoped(A.owner, [A.project], (t) => [
      t`update projects set name = 'hacked' where id = ${B.project} returning id`,
      t`delete from projects where id = ${B.project} returning id`,
    ]);
    expect(upd).toHaveLength(0);
    expect(del).toHaveLength(0);
    const [, still] = await scoped(B.owner, [B.project], (t) => [t`select name from projects where id = ${B.project}`]);
    expect(still[0].name).toBe("rls-test");
  });

  it("cannot reassign project ownership or touch is_demo (column privileges)", async () => {
    await expect(
      scoped(A.owner, [A.project], (t) => [t`update projects set owner_id = ${B.owner} where id = ${A.project}`]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      scoped(A.owner, [A.project], (t) => [t`update projects set is_demo = true where id = ${A.project}`]),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an API-key context can read its project but not delete it", async () => {
    const [, read, del] = await scoped(null, [A.project], (t) => [
      t`select id from projects`,
      t`delete from projects where id = ${A.project} returning id`,
    ]);
    expect(read).toEqual([{ id: A.project }]);
    expect(del).toHaveLength(0);
  });

  it("audit_log is append-only and model_prices is read-only for app_rw", async () => {
    const privs = await sql`
      select has_table_privilege('app_rw','audit_log','UPDATE') as au, has_table_privilege('app_rw','audit_log','DELETE') as ad,
             has_table_privilege('app_rw','model_prices','INSERT') as pi, has_table_privilege('app_rw','model_prices','UPDATE') as pu,
             has_table_privilege('app_rw','model_prices','DELETE') as pd, has_table_privilege('app_rw','model_prices','SELECT') as ps`;
    expect(privs[0]).toEqual({ au: false, ad: false, pi: false, pu: false, pd: false, ps: true });
  });

  it("malformed app.project_ids errors instead of leaking rows", async () => {
    await expect(scoped(null, ["not-a-uuid"], (t) => [t`select * from jobs`])).rejects.toThrow();
  });

  describe("lookup_key()", () => {
    it("resolves a valid key hash to its project without any tenant setting", async () => {
      const [rows] = await unscoped((t) => [t`select project_id, scopes from lookup_key(${A.keyHash})`]);
      expect(rows).toEqual([{ project_id: A.project, scopes: ["ingest"] }]);
    });

    it("returns nothing for an unknown hash", async () => {
      const [rows] = await unscoped((t) => [t`select * from lookup_key(${"0".repeat(64)})`]);
      expect(rows).toHaveLength(0);
    });

    it("returns nothing for a revoked key", async () => {
      await scoped(A.owner, [A.project], (t) => [t`update api_keys set revoked_at = now() where key_hash = ${A.keyHash}`]);
      const [rows] = await unscoped((t) => [t`select * from lookup_key(${A.keyHash})`]);
      expect(rows).toHaveLength(0);
    });

    it("does not let app_rw read api_keys directly without a scope", async () => {
      const [rows] = await unscoped((t) => [t`select * from api_keys where key_hash = ${B.keyHash}`]);
      expect(rows).toHaveLength(0);
    });
  });

  it("hard-deleting a project cascades to its children", async () => {
    const x = { owner: `test_${randomUUID()}`, project: randomUUID() as string, keyHash: randomUUID() as string, key: "" };
    await seed(x);
    await scoped(x.owner, [x.project], (t) => [t`delete from projects where id = ${x.project}`]);
    const [, ...counts] = await scoped(x.owner, [x.project], (t) => [
      t`select count(*)::int as n from projects`,
      ...PROJECT_TABLES.map((n) => t.query(`select count(*)::int as n from ${n}`)),
    ]);
    for (const c of counts) expect(c[0].n).toBe(0);
  });
});
