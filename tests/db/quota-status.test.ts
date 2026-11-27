import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { QUOTAS } from "@/lib/quotas";
import { ctxFromSession } from "@/lib/repo/ctx";
import { NotFoundError } from "@/lib/repo/errors";
import { createProject } from "@/lib/repo/projects";
import { readProjectStatus } from "@/lib/repo/quota-status";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";
import { cleanupOwners } from "./helpers/cleanup";
import { jobSql } from "./helpers/job-role";

/**
 * The project status reader (today's events against the daily limit, and the conserve flag) against the real database as app_rw,
 * with Clerk mocked: the owner sees their own counts, another user and a missing project get the SAME NotFoundError, the conserve
 * flag is reflected both ways, and "today" is the UTC day. app_state is GLOBAL, so the conserve tests restore it in afterAll (the
 * storage guard functions run as app_job; needs JOB_DATABASE_URL). Skipped without DATABASE_URL. Run alone with
 * `npm run test:db:quota-status`.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

run("project status reader (database)", () => {
  const sql = neon(url!);
  const users: string[] = [];
  let levelBefore: string | null = null;

  const state = async (key: string) => ((await sql`select value #>> '{}' as v from app_state where key = ${key}`)[0]?.v as string | undefined) ?? null;
  const tenant = async () => {
    const owner = `test_${randomUUID()}`;
    users.push(owner);
    await sql`select claim_user_slot(${owner}, 100000)`;
    mockAuth.mockResolvedValue({ userId: owner });
    const first = (await ctxFromSession())!;
    const project = await createProject(first, { name: "quota-status" });
    const ctx = (await ctxFromSession())!; // a fresh context that lists the new project
    return { owner, projectId: project.id, ctx };
  };
  const raw = (owner: string, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${ids.join(",")}, true)`, ...build(t)]);
  const usage = (owner: string, pid: string, dayExpr: "today" | "yesterday" | "tomorrow", events: number) =>
    raw(owner, [pid], (t) => [
      t`insert into usage_daily (project_id, day, events)
        values (${pid}::uuid, (now() at time zone 'UTC')::date + ${dayExpr === "today" ? 0 : dayExpr === "yesterday" ? -1 : 1}::int, ${events})`,
    ]);
  const failure = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return e as Error;
    }
    return null;
  };

  beforeAll(async () => {
    levelBefore = await state("storage_level");
  });
  afterAll(async () => {
    // Leave the guard as found: end at ok (conserve off), then restore a pre-existing warn/critical.
    const job = jobSql();
    await job`select * from apply_storage_level('ok')`;
    if (levelBefore === "warn" || levelBefore === "critical") await job`select * from apply_storage_level(${levelBefore})`;
    await cleanupOwners(sql, users);
  });

  describe("counts", () => {
    it("a project with no usage row today reads 0 events against the daily limit", async () => {
      const a = await tenant();
      const s = await readProjectStatus(a.ctx, a.projectId);
      expect(s.eventsToday).toBe(0);
      expect(s.eventsLimit).toBe(QUOTAS.eventsPerDayPerProject);
    });

    it("the owner sees their own count", async () => {
      const a = await tenant();
      await usage(a.owner, a.projectId, "today", 1_650);
      expect((await readProjectStatus(a.ctx, a.projectId)).eventsToday).toBe(1_650);
    });

    it("today is the UTC day: yesterday's and tomorrow's rows are not counted", async () => {
      const a = await tenant();
      await usage(a.owner, a.projectId, "yesterday", 1_900);
      await usage(a.owner, a.projectId, "tomorrow", 1_800);
      expect((await readProjectStatus(a.ctx, a.projectId)).eventsToday).toBe(0);
      await usage(a.owner, a.projectId, "today", 42);
      expect((await readProjectStatus(a.ctx, a.projectId)).eventsToday).toBe(42);
    });

    it("two projects of one owner keep separate counts", async () => {
      const a = await tenant();
      const second = await createProject((await ctxFromSession())!, { name: "second" });
      const both = (await ctxFromSession())!;
      await usage(a.owner, a.projectId, "today", 10);
      await usage(a.owner, second.id, "today", 20);
      expect((await readProjectStatus(both, a.projectId)).eventsToday).toBe(10);
      expect((await readProjectStatus(both, second.id)).eventsToday).toBe(20);
    });
  });

  describe("conserve flag", () => {
    it("is reflected both ways: on at warn, off again at ok", async () => {
      const a = await tenant();
      const job = jobSql();
      await job`select * from apply_storage_level('ok')`;
      expect((await readProjectStatus(a.ctx, a.projectId)).conserve).toBe(false);
      await job`select * from apply_storage_level('warn')`;
      expect((await readProjectStatus(a.ctx, a.projectId)).conserve).toBe(true);
      await job`select * from apply_storage_level('critical')`;
      expect((await readProjectStatus(a.ctx, a.projectId)).conserve).toBe(true);
      await job`select * from apply_storage_level('ok')`;
      expect((await readProjectStatus(a.ctx, a.projectId)).conserve).toBe(false);
    });

    it("is global: every project sees the same flag", async () => {
      const a = await tenant();
      const b = await tenant();
      await jobSql()`select * from apply_storage_level('warn')`;
      expect((await readProjectStatus(a.ctx, a.projectId)).conserve).toBe(true);
      mockAuth.mockResolvedValue({ userId: b.owner });
      expect((await readProjectStatus((await ctxFromSession())!, b.projectId)).conserve).toBe(true);
      await jobSql()`select * from apply_storage_level('ok')`;
    });
  });

  describe("tenant isolation", () => {
    it("another user gets the SAME NotFoundError as a project that does not exist, and never sees the count", async () => {
      const a = await tenant();
      const b = await tenant();
      await usage(a.owner, a.projectId, "today", 777);
      const missing = await failure(() => readProjectStatus(b.ctx, randomUUID()));

      // 1. through the real context: B's context does not list A's project, so no database work happens at all.
      const viaCtx = await failure(() => readProjectStatus(b.ctx, a.projectId));
      // 2. forced past that guard (a context that lists A's project but belongs to B): the database itself must refuse.
      const forged = issueCtx<SessionCtx>({ kind: "session", ownerId: b.owner, projectIds: [a.projectId], readOnly: false });
      const viaDb = await failure(() => readProjectStatus(forged, a.projectId));

      for (const e of [missing, viaCtx, viaDb]) {
        expect(e).toBeInstanceOf(NotFoundError);
        expect(e!.message).toBe(new NotFoundError().message);
        expect(JSON.stringify(e)).not.toContain("777");
      }
    });

    it("a malformed or deleted project id is the same NotFoundError", async () => {
      const a = await tenant();
      expect(await failure(() => readProjectStatus(a.ctx, "not-a-uuid"))).toBeInstanceOf(NotFoundError);
      await raw(a.owner, [], (t) => [t`delete from projects where id = ${a.projectId}::uuid and owner_id = ${a.owner}`]);
      expect(await failure(() => readProjectStatus(a.ctx, a.projectId))).toBeInstanceOf(NotFoundError);
    });
  });
});
