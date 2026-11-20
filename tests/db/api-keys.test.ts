import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { GET as listRoute, POST as createRoute } from "@/app/api/dashboard/projects/[id]/keys/route";
import { DELETE as revokeRoute } from "@/app/api/dashboard/projects/[id]/keys/[keyId]/route";
import { hashApiKey } from "@/lib/api-key";
import { QUOTAS } from "@/lib/quotas";
import { ctxFromApiKey, ctxFromSession } from "@/lib/repo/ctx";
import { LimitReachedError, NotFoundError } from "@/lib/repo/errors";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/repo/api-keys";
import { createProject } from "@/lib/repo/projects";
import { POST as createProjectRoute } from "@/app/api/dashboard/projects/route";

/** API keys against the real database as app_rw, Clerk mocked. Skipped without DATABASE_URL. */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

run("api keys", () => {
  const sql = neon(url!);
  const users: string[] = [];
  const newUser = async () => {
    const u = `test_${randomUUID()}`;
    users.push(u);
    await sql`select claim_user_slot(${u}, 100000)`;
    return u;
  };
  const signIn = (userId: string | null) => mockAuth.mockResolvedValue({ userId });
  const ctxFor = async (u: string) => {
    signIn(u);
    return (await ctxFromSession())!;
  };
  const raw = (owner: string, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${ids.join(",")}, true)`,
      ...build(t),
    ]);
  /**
   * A user with one project, ready to create keys. A context is fixed when it is built, so the context
   * returned here is built AFTER the project exists (the first one only has the owner scope).
   */
  const setup = async () => {
    const owner = await newUser();
    const project = await createProject(await ctxFor(owner), { name: "keys-test" });
    const ctx = await ctxFor(owner); // fresh: its scope now includes the new project
    expect(ctx.projectIds).toContain(project.id);
    return { owner, ctx, project: project.id };
  };
  const ORIGIN = "http://localhost";
  const http = (method: string, path: string, body?: unknown) =>
    new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const params = (id: string, keyId = "") => ({ params: Promise.resolve({ id, keyId }) });

  beforeEach(() => signIn(null));
  afterAll(async () => {
    for (const u of users) await raw(u, [], (t) => [t`delete from projects where owner_id = ${u}`, t`select release_user_slot()`]);
  });

  it("creates a key that authenticates, and stores only its hash and a short prefix", async () => {
    const { owner, ctx, project } = await setup();
    const { key, secret } = await createApiKey(ctx, project, { scopes: ["ingest", "eval"] });
    expect(secret).toMatch(/^lm_[A-Za-z0-9_-]{43}$/);
    expect(key).toMatchObject({ prefix: secret.slice(0, 8), scopes: ["ingest", "eval"], revokedAt: null, lastUsedAt: null });
    // The raw key authenticates and resolves to exactly this project.
    expect(await ctxFromApiKey(secret)).toMatchObject({ kind: "apiKey", projectIds: [project], scopes: ["ingest", "eval"] });
    // Nothing in the stored row contains the secret.
    const [, rows] = await raw(owner, [project], (t) => [t`select * from api_keys where id = ${key.id}`]);
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(hashApiKey(secret));
    expect(JSON.stringify(rows[0])).not.toContain(secret);
    expect(JSON.stringify(rows[0])).not.toContain(secret.slice(8));
  });

  describe("context built before the project exists (the case that failed)", () => {
    it("a stale context fails closed with not found and creates nothing; a fresh one works", async () => {
      const owner = await newUser();
      const stale = await ctxFor(owner); // built while the user has no project
      const project = await createProject(stale, { name: "stale-test" });
      expect(stale.projectIds).not.toContain(project.id);
      await expect(createApiKey(stale, project.id, {})).rejects.toBeInstanceOf(NotFoundError);
      await expect(listApiKeys(stale, project.id)).rejects.toBeInstanceOf(NotFoundError);
      const [, none] = await raw(owner, [project.id], (t) => [t`select count(*)::int as n from api_keys`]);
      expect(none[0].n).toBe(0);
      const fresh = await ctxFor(owner);
      await expect(createApiKey(fresh, project.id, {})).resolves.toMatchObject({ secret: expect.stringMatching(/^lm_/) });
    });

    it("dashboard flow in one session: create a project, then immediately create and list a key", async () => {
      const owner = await newUser();
      signIn(owner);
      const pr = await createProjectRoute(http("POST", "/api/dashboard/projects", { name: "flow" }));
      expect(pr.status).toBe(201);
      const { project } = (await pr.json()) as { project: { id: string } };
      const base = `/api/dashboard/projects/${project.id}/keys`;
      const kr = await createRoute(http("POST", base, { scopes: ["ingest"] }), params(project.id));
      expect(kr.status).toBe(201);
      const { secret } = (await kr.json()) as { secret: string };
      expect(await ctxFromApiKey(secret)).toMatchObject({ projectIds: [project.id] });
      const listed = (await (await listRoute(http("GET", base), params(project.id))).json()) as { keys: unknown[] };
      expect(listed.keys).toHaveLength(1);
    });
  });

  describe("key name", () => {
    it("stores the trimmed name and returns it from create and list; the secret is unchanged", async () => {
      const { owner, ctx, project } = await setup();
      const { key, secret } = await createApiKey(ctx, project, { name: "  CI pipeline  " });
      expect(key.name).toBe("CI pipeline");
      expect(secret).toMatch(/^lm_[A-Za-z0-9_-]{43}$/);
      expect(key.prefix).toBe(secret.slice(0, 8));
      expect((await listApiKeys(ctx, project))[0].name).toBe("CI pipeline");
      const [, rows] = await raw(owner, [project], (t) => [t`select name, key_hash from api_keys where id = ${key.id}`]);
      expect(rows[0]).toEqual({ name: "CI pipeline", key_hash: hashApiKey(secret) });
      expect(await ctxFromApiKey(secret)).not.toBeNull(); // naming does not affect authentication
    });

    it("works with no name and with an empty or blank name (stored as empty)", async () => {
      const { ctx, project } = await setup();
      expect((await createApiKey(ctx, project, {})).key.name).toBe("");
      expect((await createApiKey(ctx, project, { name: "" })).key.name).toBe("");
      expect((await createApiKey(ctx, project, { name: "   " })).key.name).toBe("");
      expect((await listApiKeys(ctx, project)).map((k) => k.name)).toEqual(["", "", ""]);
    });

    it("rejects a name over 60 characters at the repo and the route, and creates nothing", async () => {
      const { owner, ctx, project } = await setup();
      await expect(createApiKey(ctx, project, { name: "x".repeat(61) })).rejects.toThrow();
      signIn(owner);
      const base = `/api/dashboard/projects/${project}/keys`;
      const r = await createRoute(http("POST", base, { name: "x".repeat(61) }), params(project));
      expect(r.status).toBe(422);
      expect(await r.json()).toEqual({ error: "invalid_request" });
      expect(await listApiKeys(await ctxFor(owner), project)).toHaveLength(0);
      const ok = await createRoute(http("POST", base, { name: "x".repeat(60) }), params(project));
      expect(ok.status).toBe(201);
    });

    it("the name never changes the cap, and revoked keys keep their name", async () => {
      const { ctx, project } = await setup();
      const first = await createApiKey(ctx, project, { name: "old" });
      for (let i = 1; i < QUOTAS.keysPerProject; i++) await createApiKey(ctx, project, { name: `k${i}` });
      await expect(createApiKey(ctx, project, { name: "over" })).rejects.toBeInstanceOf(LimitReachedError);
      await revokeApiKey(ctx, project, first.key.id);
      const listed = await listApiKeys(ctx, project);
      expect(listed.find((k) => k.id === first.key.id)).toMatchObject({ name: "old", revokedAt: expect.any(String) });
    });

    it("IDOR holds for named keys: B cannot read A's key names or create on A's project", async () => {
      const a = await setup();
      const { secret } = await createApiKey(a.ctx, a.project, { name: "A-private-label" });
      const b = await ctxFor(await newUser());
      await expect(listApiKeys(b, a.project)).rejects.toBeInstanceOf(NotFoundError);
      await expect(createApiKey(b, a.project, { name: "from-b" })).rejects.toBeInstanceOf(NotFoundError);
      signIn(users[users.length - 1]);
      const res = await listRoute(http("GET", `/api/dashboard/projects/${a.project}/keys`), params(a.project));
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("A-private-label");
      // A still sees only its own named key, and the secret still works.
      expect((await listApiKeys(a.ctx, a.project)).map((k) => k.name)).toEqual(["A-private-label"]);
      expect(await ctxFromApiKey(secret)).not.toBeNull();
    });

    it("a key-like name is not logged by the create path", async () => {
      const { owner, project } = await setup();
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((l) => vi.spyOn(console, l).mockImplementation(() => {}));
      signIn(owner);
      const lookalike = `lm_${"Z".repeat(43)}`;
      const r = await createRoute(http("POST", `/api/dashboard/projects/${project}/keys`, { name: lookalike.slice(0, 60) }), params(project));
      expect(r.status).toBe(201);
      const { secret } = (await r.json()) as { secret: string };
      const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
      spies.forEach((s) => s.mockRestore());
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain(hashApiKey(secret));
    });
  });

  it("defaults to the ingest scope and rejects invalid scopes", async () => {
    const { ctx, project } = await setup();
    expect((await createApiKey(ctx, project, {})).key.scopes).toEqual(["ingest"]);
    await expect(createApiKey(ctx, project, { scopes: ["admin"] })).rejects.toThrow();
    await expect(createApiKey(ctx, project, { scopes: [] })).rejects.toThrow();
  });

  it("lists key metadata without the secret or the hash", async () => {
    const { ctx, project } = await setup();
    const { secret } = await createApiKey(ctx, project, {});
    const keys = await listApiKeys(ctx, project);
    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0]).sort()).toEqual(["createdAt", "id", "lastUsedAt", "name", "prefix", "revokedAt", "scopes"]);
    expect(JSON.stringify(keys)).not.toContain(secret);
  });

  it("enforces the active-key cap; revoking frees a slot", async () => {
    const { ctx, project } = await setup();
    const made = [];
    for (let i = 0; i < QUOTAS.keysPerProject; i++) made.push(await createApiKey(ctx, project, {}));
    await expect(createApiKey(ctx, project, {})).rejects.toBeInstanceOf(LimitReachedError);
    await revokeApiKey(ctx, project, made[0].key.id);
    await expect(createApiKey(ctx, project, {})).resolves.toBeDefined();
    await expect(createApiKey(ctx, project, {})).rejects.toBeInstanceOf(LimitReachedError);
    expect((await listApiKeys(ctx, project)).length).toBe(QUOTAS.keysPerProject + 1); // revoked keys stay listed
  });

  it("holds the cap under concurrent creates", async () => {
    const { ctx, project } = await setup();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => createApiKey(ctx, project, {})));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(QUOTAS.keysPerProject);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expect(r.reason).toBeInstanceOf(LimitReachedError);
  });

  it("a revoked key stops authenticating; revoking twice is idempotent and audited once", async () => {
    const { owner, ctx, project } = await setup();
    const { key, secret } = await createApiKey(ctx, project, {});
    expect(await ctxFromApiKey(secret)).not.toBeNull();
    await revokeApiKey(ctx, project, key.id, "203.0.113.1");
    expect(await ctxFromApiKey(secret)).toBeNull();
    await expect(revokeApiKey(ctx, project, key.id)).resolves.toBeUndefined();
    const [, audit] = await raw(owner, [], (t) => [t`select action, target, ip from audit_log where action like 'api_key.%' order by created_at`]);
    expect(audit).toEqual([
      { action: "api_key.create", target: key.id, ip: null },
      { action: "api_key.revoke", target: key.id, ip: "203.0.113.1" },
    ]);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  describe("IDOR: user B versus user A's project and keys", () => {
    it("B cannot create, list or revoke on A's project, and A's key keeps working", async () => {
      const a = await setup();
      const { key, secret } = await createApiKey(a.ctx, a.project, {});
      const bOwner = await newUser();
      const b = await ctxFor(bOwner);
      await expect(createApiKey(b, a.project, {})).rejects.toBeInstanceOf(NotFoundError);
      await expect(listApiKeys(b, a.project)).rejects.toBeInstanceOf(NotFoundError);
      await expect(revokeApiKey(b, a.project, key.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await ctxFromApiKey(secret)).not.toBeNull();
      expect((await listApiKeys(a.ctx, a.project)).every((k) => !k.revokedAt)).toBe(true);
    });

    it("B cannot revoke A's key through B's own project (project/key mismatch)", async () => {
      const a = await setup();
      const { key, secret } = await createApiKey(a.ctx, a.project, {});
      const b = await setup();
      await expect(revokeApiKey(b.ctx, b.project, key.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await ctxFromApiKey(secret)).not.toBeNull();
    });

    it("routes answer 404 for B, 401 signed out, and never leak A's keys", async () => {
      const a = await setup();
      const { key, secret } = await createApiKey(a.ctx, a.project, {});
      const base = `/api/dashboard/projects/${a.project}/keys`;
      signIn(await newUser());
      expect((await listRoute(http("GET", base), params(a.project))).status).toBe(404);
      expect((await createRoute(http("POST", base, { scopes: ["ingest"] }), params(a.project))).status).toBe(404);
      expect((await revokeRoute(http("DELETE", `${base}/${key.id}`), params(a.project, key.id))).status).toBe(404);
      signIn(null);
      expect((await listRoute(http("GET", base), params(a.project))).status).toBe(401);
      signIn(a.owner);
      const body = await (await listRoute(http("GET", base), params(a.project))).text();
      expect(body).not.toContain(secret);
    });

    it("B sees none of A's key audit entries", async () => {
      const a = await setup();
      await createApiKey(a.ctx, a.project, {});
      const [, rows] = await raw(await newUser(), [], (t) => [t`select * from audit_log`]);
      expect(rows).toHaveLength(0);
    });
  });

  it("route create returns the secret once; later lists and the logs never contain it", async () => {
    const { owner, project } = await setup();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((l) => vi.spyOn(console, l).mockImplementation(() => {}));
    signIn(owner);
    const base = `/api/dashboard/projects/${project}/keys`;
    const created = await createRoute(http("POST", base, { scopes: ["ingest"] }), params(project));
    expect(created.status).toBe(201);
    const { key, secret } = (await created.json()) as { key: { id: string }; secret: string };
    expect(secret).toMatch(/^lm_/);
    await listRoute(http("GET", base), params(project));
    await createRoute(http("POST", base, { scopes: ["nope"] }), params(project)); // failure path
    await revokeRoute(http("DELETE", `${base}/${key.id}`), params(project, key.id));
    const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(hashApiKey(secret));
  });

  it("deleting the project removes its keys", async () => {
    const { owner, ctx, project } = await setup();
    const { secret } = await createApiKey(ctx, project, {});
    await raw(owner, [], (t) => [t`delete from projects where id = ${project}`]);
    expect(await ctxFromApiKey(secret)).toBeNull();
  });
});
