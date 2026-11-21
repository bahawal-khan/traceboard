import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { GET as listRoute, POST as createRoute } from "@/app/api/dashboard/projects/route";
import { DELETE as delRoute, GET as getRoute, PATCH as patchRoute } from "@/app/api/dashboard/projects/[id]/route";
import { QUOTAS } from "@/lib/quotas";
import { ctxFromSession } from "@/lib/repo/ctx";
import { LimitReachedError, NotFoundError } from "@/lib/repo/errors";
import { createProject, deleteProject, getProject, listProjects, renameProject } from "@/lib/repo/projects";
import { cleanupOwners } from "./helpers/cleanup";

/** Projects repo + routes against the real database as app_rw, with Clerk mocked. Skipped without DATABASE_URL. */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

run("projects repo and routes", () => {
  const sql = neon(url!);
  const users: string[] = [];
  const asUser = async (withSlot = true) => {
    const u = `test_${randomUUID()}`;
    users.push(u);
    if (withSlot) await sql`select claim_user_slot(${u}, 100000)`;
    return u;
  };
  const signIn = (userId: string | null) => mockAuth.mockResolvedValue({ userId });
  const sessionCtx = async (u: string) => {
    signIn(u);
    return (await ctxFromSession())!;
  };
  const raw = (owner: string, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${ids.join(",")}, true)`,
      ...build(t),
    ]);
  const ORIGIN = "http://localhost";
  const call = (method: string, path: string, body?: unknown) =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

  beforeEach(() => {
    signIn(null);
  });

  afterAll(async () => {
    await cleanupOwners(sql, users); // one round trip for all users (tests/db/helpers/cleanup.ts)
  });

  it("creates, lists, gets, renames and deletes a project, writing audit rows", async () => {
    const u = await asUser();
    const ctx = await sessionCtx(u);
    const p = await createProject(ctx, { name: "  First  " }, "203.0.113.5");
    expect(p).toMatchObject({ name: "First", captureContent: false, contentRetentionDays: 7 });
    expect((await listProjects(ctx)).map((x) => x.id)).toEqual([p.id]);
    expect((await getProject(ctx, p.id)).name).toBe("First");
    expect((await renameProject(ctx, p.id, { name: "Renamed" })).name).toBe("Renamed");
    await deleteProject(ctx, p.id, "203.0.113.5");
    await expect(getProject(ctx, p.id)).rejects.toBeInstanceOf(NotFoundError);
    const [, audit] = await raw(u, [], (t) => [t`select action, target, ip from audit_log order by created_at`]);
    expect(audit).toEqual([
      { action: "project.create", target: p.id, ip: "203.0.113.5" },
      { action: "project.delete", target: p.id, ip: "203.0.113.5" },
    ]);
  });

  it("enforces the per-user project limit and writes no audit row for a refused create", async () => {
    const u = await asUser();
    const ctx = await sessionCtx(u);
    for (let i = 0; i < QUOTAS.projectsPerUser; i++) await createProject(ctx, { name: `p${i}` });
    await expect(createProject(ctx, { name: "over" })).rejects.toBeInstanceOf(LimitReachedError);
    const [, audit] = await raw(u, [], (t) => [t`select count(*)::int as n from audit_log where action = 'project.create'`]);
    expect(audit[0].n).toBe(QUOTAS.projectsPerUser);
  });

  it("holds the limit under concurrent creates by the same user", async () => {
    const u = await asUser();
    const ctx = await sessionCtx(u);
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => createProject(ctx, { name: `c${i}` })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(QUOTAS.projectsPerUser);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(5 - QUOTAS.projectsPerUser);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(LimitReachedError);
    expect((await listProjects(ctx)).length).toBe(QUOTAS.projectsPerUser);
  });

  it("rejects invalid input at the repo boundary", async () => {
    const ctx = await sessionCtx(await asUser());
    await expect(createProject(ctx, { name: "" })).rejects.toThrow();
    await expect(createProject(ctx, { name: "x", owner_id: "someone_else" })).rejects.toThrow();
    await expect(getProject(ctx, "not-a-uuid")).rejects.toThrow();
  });

  describe("IDOR: user B versus user A's project", () => {
    it("repo functions treat A's project as not found for B and leave it untouched", async () => {
      const a = await sessionCtx(await asUser());
      const proj = await createProject(a, { name: "A's secret" });
      const b = await sessionCtx(await asUser());
      await expect(getProject(b, proj.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(renameProject(b, proj.id, { name: "hacked" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteProject(b, proj.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await listProjects(b)).map((x) => x.id)).not.toContain(proj.id);
      expect((await getProject(a, proj.id)).name).toBe("A's secret");
    });

    it("routes answer 404 for B on A's project id and list only B's projects", async () => {
      const ua = await asUser();
      const a = await sessionCtx(ua);
      const proj = await createProject(a, { name: "A route" });
      const ub = await asUser();
      signIn(ub);
      const mine = await createProject((await ctxFromSession())!, { name: "B route" });

      expect((await getRoute(call("GET", `/api/dashboard/projects/${proj.id}`), idParams(proj.id))).status).toBe(404);
      expect((await patchRoute(call("PATCH", `/api/dashboard/projects/${proj.id}`, { name: "x" }), idParams(proj.id))).status).toBe(404);
      expect((await delRoute(call("DELETE", `/api/dashboard/projects/${proj.id}`), idParams(proj.id))).status).toBe(404);
      const listed = (await (await listRoute(call("GET", "/api/dashboard/projects"))).json()) as { projects: { id: string }[] };
      expect(listed.projects.map((p) => p.id)).toEqual([mine.id]);

      signIn(ua);
      expect((await getRoute(call("GET", `/api/dashboard/projects/${proj.id}`), idParams(proj.id))).status).toBe(200);
    });

    it("routes answer 401 when signed out or when the user never claimed a slot", async () => {
      signIn(null);
      expect((await listRoute(call("GET", "/api/dashboard/projects"))).status).toBe(401);
      signIn(await asUser(false));
      expect((await listRoute(call("GET", "/api/dashboard/projects"))).status).toBe(401);
      expect((await createRoute(call("POST", "/api/dashboard/projects", { name: "x" }))).status).toBe(401);
    });

    it("B cannot see A's audit entries", async () => {
      const ua = await asUser();
      await createProject(await sessionCtx(ua), { name: "audit-a" });
      const ub = await asUser();
      const [, rows] = await raw(ub, [], (t) => [t`select * from audit_log`]);
      expect(rows).toHaveLength(0);
    });
  });

  it("hard delete cascades to keys, budgets and events and keeps the owner's audit trail", async () => {
    const u = await asUser();
    const ctx = await sessionCtx(u);
    const p = await createProject(ctx, { name: "cascade" });
    await raw(u, [p.id], (t) => [
      t`insert into api_keys (project_id, key_hash, prefix) values (${p.id}, ${randomUUID()}, 'lm_x')`,
      t`insert into budgets (project_id, scope, period, limit_usd, action) values (${p.id}, 'project', 'day', 1, 'alert')`,
      t`insert into events (event_id, project_id, occurred_at) values (${randomUUID()}, ${p.id}, now())`,
    ]);
    await deleteProject(ctx, p.id);
    const [, ...counts] = await raw(u, [p.id], (t) => [
      t`select count(*)::int as n from api_keys`,
      t`select count(*)::int as n from budgets`,
      t`select count(*)::int as n from events`,
      t`select count(*)::int as n from audit_log where action = 'project.delete' and target = ${p.id}`,
    ]);
    expect(counts.map((c) => c[0].n)).toEqual([0, 0, 0, 1]);
  });

  it("route create rejects a cross-origin POST and accepts a same-origin one", async () => {
    signIn(await asUser());
    const bad = new Request(`${ORIGIN}/api/dashboard/projects`, { method: "POST", headers: { origin: "https://evil.example.com", "content-type": "application/json" }, body: JSON.stringify({ name: "csrf" }) });
    expect((await createRoute(bad)).status).toBe(403);
    expect((await createRoute(call("POST", "/api/dashboard/projects", { name: "legit" }))).status).toBe(201);
  });
});
