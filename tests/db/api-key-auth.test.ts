import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { ApiKeyAuthenticator } from "@/lib/api-key-auth";
import { authenticateApiKeyRequest } from "@/lib/http/api-key-request";
import { createApiKey, resetTouchThrottleForTests, revokeApiKey, touchApiKey } from "@/lib/repo/api-keys";
import { ctxFromApiKey, ctxFromSession } from "@/lib/repo/ctx";
import { createProject } from "@/lib/repo/projects";
import { withTenant } from "@/lib/repo/tenant";
import { TokenBucketLimiter } from "@/lib/ratelimit";

/** API-key auth, last_used_at and revocation against the real database as app_rw. Skipped without DATABASE_URL. */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

run("api key auth (database)", () => {
  const sql = neon(url!);
  const users: string[] = [];
  const raw = (owner: string, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${ids.join(",")}, true)`,
      ...build(t),
    ]);
  const sessionCtx = async (u: string) => {
    mockAuth.mockResolvedValue({ userId: u });
    return (await ctxFromSession())!;
  };
  /** A user with one project and one ingest key. */
  const setup = async () => {
    const owner = `test_${randomUUID()}`;
    users.push(owner);
    await sql`select claim_user_slot(${owner}, 100000)`;
    const project = await createProject(await sessionCtx(owner), { name: "auth-test" });
    const ctx = await sessionCtx(owner);
    const { key, secret } = await createApiKey(ctx, project.id, { scopes: ["ingest"] });
    return { owner, ctx, project: project.id, keyId: key.id, secret };
  };
  const lastUsed = async (owner: string, project: string, keyId: string) => {
    const [, rows] = await raw(owner, [project], (t) => [t`select last_used_at from api_keys where id = ${keyId}`]);
    return rows[0].last_used_at as Date | string | null;
  };

  beforeEach(() => {
    resetTouchThrottleForTests();
  });
  afterAll(async () => {
    for (const u of users) await raw(u, [], (t) => [t`delete from projects where owner_id = ${u}`, t`select release_user_slot()`]);
  });

  it("touchApiKey stamps last_used_at, and only once per minute even across instances", async () => {
    const a = await setup();
    expect(await lastUsed(a.owner, a.project, a.keyId)).toBeNull();
    const ctx = (await ctxFromApiKey(a.secret))!;
    await touchApiKey(ctx);
    const first = await lastUsed(a.owner, a.project, a.keyId);
    expect(first).not.toBeNull();
    resetTouchThrottleForTests(); // simulate a second instance with an empty in-memory throttle
    await touchApiKey(ctx);
    expect(new Date(String(await lastUsed(a.owner, a.project, a.keyId))).getTime()).toBe(new Date(String(first)).getTime());
  });

  it("a revoked key is never stamped and stops resolving", async () => {
    const a = await setup();
    const ctx = (await ctxFromApiKey(a.secret))!;
    await revokeApiKey(a.ctx, a.project, a.keyId);
    await touchApiKey(ctx);
    expect(await lastUsed(a.owner, a.project, a.keyId)).toBeNull();
    expect(await ctxFromApiKey(a.secret)).toBeNull();
    expect(await new ApiKeyAuthenticator(ctxFromApiKey).authenticate(a.secret)).toBeNull();
  });

  it("IDOR: a key context of project A cannot stamp or read a key of project B", async () => {
    const a = await setup();
    const b = await setup();
    const ctxA = (await ctxFromApiKey(a.secret))!;
    const [upd, sel] = await withTenant(ctxA, (t) => [
      t`update api_keys set last_used_at = now() where id = ${b.keyId} returning id`,
      t`select id from api_keys where id = ${b.keyId}`,
    ]);
    expect(upd).toHaveLength(0);
    expect(sel).toHaveLength(0);
    expect(await lastUsed(b.owner, b.project, b.keyId)).toBeNull();
  });

  it("end to end: Bearer key -> authenticated context for its own project only; wrong scope is 403", async () => {
    const a = await setup();
    const deps = {
      ipLimiter: new TokenBucketLimiter({ burst: 100, refillPerSec: 100 }),
      keyLimiter: new TokenBucketLimiter({ burst: 100, refillPerSec: 100 }),
      failureBudget: new TokenBucketLimiter({ burst: 100, refillPerSec: 100 }),
      authenticator: new ApiKeyAuthenticator(ctxFromApiKey),
    };
    const req = (key: string) => new Request("http://localhost/api/ingest", { method: "POST", headers: { authorization: `Bearer ${key}` } });
    const ok = await authenticateApiKeyRequest(req(a.secret), "ingest", deps);
    expect(ok.ok && ok.ctx.projectIds).toEqual([a.project]);
    expect(await authenticateApiKeyRequest(req(a.secret), "eval", deps)).toMatchObject({ ok: false, status: 403 });
    expect(await authenticateApiKeyRequest(req(`lm_${"A".repeat(43)}`), "ingest", deps)).toMatchObject({ ok: false, status: 401 });
  });
});
