import { neon } from "@neondatabase/serverless";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashApiKey } from "@/lib/api-key";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { ctxDemo, ctxFromApiKey, ctxFromSession } from "@/lib/repo/ctx";
import { TenantError, withTenant } from "@/lib/repo/tenant";

/** withTenant + the three ctx constructors against the real database, as app_rw. Skipped without DATABASE_URL. */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("tenant context (ctx* + withTenant)", () => {
  const sql = neon(url!);
  const newKey = () => `lm_${randomBytes(32).toString("base64url")}`;
  const mk = () => ({ owner: `test_${randomUUID()}`, project: randomUUID() as string, key: newKey() });
  const A = mk();
  const B = mk();

  const seed = (x: ReturnType<typeof mk>) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${x.owner}, true), set_config('app.project_ids', ${x.project}, true)`,
      t`insert into projects (id, owner_id, name) values (${x.project}, ${x.owner}, 'tenant-test')`,
      t`insert into api_keys (project_id, key_hash, prefix) values (${x.project}, ${hashApiKey(x.key)}, 'lm_test')`,
      t`insert into budgets (project_id, scope, period, limit_usd, action) values (${x.project}, 'project', 'day', 1, 'alert')`,
    ]);

  beforeAll(async () => {
    await seed(A);
    await seed(B);
  });

  afterAll(async () => {
    for (const x of [A, B]) {
      await sql.transaction((t) => [
        t`select set_config('app.owner_id', ${x.owner}, true)`,
        t`delete from projects where id = ${x.project}`,
      ]);
    }
  });

  describe("ctxFromApiKey", () => {
    it("resolves a valid key to exactly its project", async () => {
      const ctx = await ctxFromApiKey(A.key);
      expect(ctx).toMatchObject({ kind: "apiKey", ownerId: null, projectIds: [A.project], scopes: ["ingest"], readOnly: false });
    });

    it("returns null for malformed, unknown, empty and null keys without querying the db", async () => {
      expect(await ctxFromApiKey(newKey())).toBeNull();
      expect(await ctxFromApiKey("lm_short")).toBeNull();
      expect(await ctxFromApiKey("")).toBeNull();
      expect(await ctxFromApiKey(null)).toBeNull();
    });

    it("returns null once the key is revoked", async () => {
      const x = mk();
      await seed(x);
      expect(await ctxFromApiKey(x.key)).not.toBeNull();
      await sql.transaction((t) => [
        t`select set_config('app.project_ids', ${x.project}, true)`,
        t`update api_keys set revoked_at = now() where key_hash = ${hashApiKey(x.key)}`,
      ]);
      expect(await ctxFromApiKey(x.key)).toBeNull();
      await sql.transaction((t) => [
        t`select set_config('app.owner_id', ${x.owner}, true)`,
        t`delete from projects where id = ${x.project}`,
      ]);
    });

    it("a context for A never reads or writes B's data through withTenant", async () => {
      const ctx = (await ctxFromApiKey(A.key))!;
      const [mine, theirs] = await withTenant(ctx, (t) => [
        t`select project_id from budgets`,
        t`select id from budgets where project_id = ${B.project}`,
      ]);
      expect(mine.map((r) => r.project_id)).toEqual([A.project]);
      expect(theirs).toHaveLength(0);
      await expect(
        withTenant(ctx, (t) => [
          t`insert into budgets (project_id, scope, period, limit_usd, action) values (${B.project}, 'project', 'day', 1, 'alert')`,
        ]),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe("ctxFromSession", () => {
    it("returns null when signed out", async () => {
      mockAuth.mockResolvedValue({ userId: null });
      expect(await ctxFromSession()).toBeNull();
    });

    it("scopes to exactly the projects the signed-in user owns", async () => {
      mockAuth.mockResolvedValue({ userId: A.owner });
      const ctx = await ctxFromSession();
      expect(ctx).toMatchObject({ kind: "session", ownerId: A.owner, projectIds: [A.project], readOnly: false });
    });

    it("a user with no projects gets an empty scope that fails closed", async () => {
      mockAuth.mockResolvedValue({ userId: `test_${randomUUID()}` });
      const ctx = (await ctxFromSession())!;
      expect(ctx.projectIds).toEqual([]);
      const [p, b] = await withTenant(ctx, (t) => [t`select id from projects`, t`select id from budgets`]);
      expect([p.length, b.length]).toEqual([0, 0]);
    });

    it("never shows user A the projects of user B", async () => {
      mockAuth.mockResolvedValue({ userId: A.owner });
      const ctx = (await ctxFromSession())!;
      const [rows] = await withTenant(ctx, (t) => [t`select id from projects`]);
      expect(rows.map((r) => r.id)).toEqual([A.project]);
    });
  });

  describe("ctxDemo and withTenant guards", () => {
    it("is read-only and cannot write even to tables app_rw may normally write", async () => {
      const ctx = await ctxDemo();
      expect(ctx).toMatchObject({ kind: "demo", ownerId: null, readOnly: true });
      await expect(
        withTenant(ctx, (t) => [t`insert into app_state (key, value) values (${`ro-${randomUUID()}`}, '{}'::jsonb)`]),
      ).rejects.toThrow(/read-only transaction/i);
    });

    it("cannot see a regular user's project", async () => {
      const ctx = await ctxDemo();
      const [rows] = await withTenant(ctx, (t) => [t`select id from projects where id = ${A.project}`]);
      expect(rows).toHaveLength(0);
    });

    it("returns query results in order without the set_config row", async () => {
      const ctx = (await ctxFromApiKey(A.key))!;
      const results = await withTenant(ctx, (t) => [t`select 1 as one`, t`select 2 as two`]);
      expect(results).toEqual([[{ one: 1 }], [{ two: 2 }]]);
    });

    it("rejects a build() that does not return an array", async () => {
      const ctx = (await ctxFromApiKey(A.key))!;
      await expect(withTenant(ctx, (() => undefined) as never)).rejects.toThrow(TenantError);
    });
  });
});
