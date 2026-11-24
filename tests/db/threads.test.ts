import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { ctxFromSession } from "@/lib/repo/ctx";
import { InvalidCursorError, NotFoundError } from "@/lib/repo/errors";
import { createProject, deleteProject } from "@/lib/repo/projects";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";
import { encodeThreadCursor, listThreads, threadListItemSchema, type ThreadListItem } from "@/lib/repo/threads";
import { cleanupOwners } from "./helpers/cleanup";

/**
 * The thread LIST reader against the real database as app_rw, with Clerk mocked: aggregation per thread, cost rules, keyset
 * pagination (ties, microseconds), the scan cap, and above all tenant isolation. Events are seeded through the same RLS-scoped
 * door the app uses. Skipped without DATABASE_URL. Run alone with `npm run test:db:threads`.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

const MIN = 60_000;
const HOUR = 3_600_000;

interface Ev {
  thread?: string | null;
  trace?: string | null;
  model?: string | null;
  status?: "ok" | "error";
  input?: number | null;
  output?: number | null;
  /** micro-USD; omit for NULL (unpriced). */
  cost?: number | null;
  at: string;
  error?: string;
}

run("thread list reader (database)", () => {
  const sql = neon(url!);
  const users: string[] = [];
  const nowMs = Date.now();
  const base = Math.floor(nowMs / MIN) * MIN - 20 * MIN;
  const at = (offsetMs: number, micros = 0) =>
    new Date(base + offsetMs).toISOString().replace(/\.(\d{3})Z$/, (_m, ms: string) => `.${ms}${String(micros).padStart(3, "0")}Z`);
  const range = { fromMs: nowMs - 2 * HOUR, toMs: nowMs };

  const asUser = async () => {
    const u = `test_${randomUUID()}`;
    users.push(u);
    await sql`select claim_user_slot(${u}, 100000)`;
    return u;
  };
  const sessionCtx = async (u: string) => {
    mockAuth.mockResolvedValue({ userId: u });
    return (await ctxFromSession())!;
  };
  const tenant = async () => {
    const owner = await asUser();
    mockAuth.mockResolvedValue({ userId: owner });
    const first = (await ctxFromSession())!;
    const project = await createProject(first, { name: "threads" });
    const ctx = await sessionCtx(owner);
    return { owner, projectId: project.id, ctx };
  };
  const raw = (owner: string, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${ids.join(",")}, true)`,
      ...build(t),
    ]);
  const seed = (owner: string, pid: string, evs: Ev[]) =>
    raw(owner, [pid], (t) =>
      evs.map(
        (e) =>
          t`insert into events (event_id, project_id, thread_id, trace_id, span_id, kind, model, input_tokens, output_tokens, cost_usd, status, error, occurred_at)
            values (${randomUUID()}, ${pid}::uuid, ${e.thread === undefined ? "th" : e.thread}, ${e.trace === undefined ? randomUUID() : e.trace}, ${randomUUID()}, 'llm', ${e.model ?? null},
                    ${e.input ?? null}, ${e.output ?? null}, ${e.cost === undefined || e.cost === null ? null : e.cost / 1_000_000}, ${e.status ?? "ok"}, ${e.error ?? null},
                    ${e.at}::timestamptz)`,
      ),
    );
  const list = (ctx: SessionCtx, pid: string, o: Partial<Parameters<typeof listThreads>[2]> = {}) => listThreads(ctx, pid, { range, nowMs, ...o });
  const failure = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return e as Error;
    }
    return null;
  };
  const byId = (items: ThreadListItem[]) => new Map(items.map((i) => [i.threadId, i]));

  beforeEach(() => {
    mockAuth.mockResolvedValue({ userId: null });
  });
  afterAll(async () => {
    await cleanupOwners(sql, users);
  });

  // ---- aggregation ----

  it("one row per thread: traces, events, errors, tokens, first and last activity", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { thread: "a", trace: "t1", input: 100, output: 20, at: at(0) },
      { thread: "a", trace: "t1", input: 5, output: 5, status: "error", at: at(1_000) },
      { thread: "a", trace: "t2", input: 1, at: at(5_000, 9) },
      { thread: "b", trace: "t3", at: at(2_000) },
    ]);
    const r = await list(ctx, projectId);
    expect(r.truncated).toBe(false);
    const by = byId(r.items);
    expect(by.get("a")).toMatchObject({ traceCount: 2, spanCount: 3, errorCount: 1, totalTokens: 131, startedAtMs: base, lastActiveAtMs: base + 5_000 });
    expect(by.get("b")).toMatchObject({ traceCount: 1, spanCount: 1, errorCount: 0, totalTokens: 0 });
    for (const i of r.items) expect(threadListItemSchema.safeParse(i).success).toBe(true);
  });

  it("events without a thread id are not threads; events without a trace id count as events but not as traces", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { thread: null, trace: "t-no-thread", at: at(0) },
      { thread: "x", trace: null, at: at(1_000) },
      { thread: "x", trace: "t1", at: at(2_000) },
    ]);
    const r = await list(ctx, projectId);
    expect(r.items.map((i) => i.threadId)).toEqual(["x"]);
    expect(r.items[0]).toMatchObject({ spanCount: 2, traceCount: 1 });
  });

  it("cost is never invented: unknown = null, partial = a lower bound, nothing to price = a real 0, free model = 0", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { thread: "unknown", model: "mystery-7b", at: at(0) },
      { thread: "partial", model: "priced-1", cost: 1_500, at: at(1_000) },
      { thread: "partial", model: "mystery-7b", at: at(2_000) },
      { thread: "tools", model: null, at: at(3_000) },
      { thread: "free", model: "free-1", cost: 0, at: at(4_000) },
      { thread: "full", model: "priced-1", cost: 2_500, at: at(5_000) },
    ]);
    const by = byId((await list(ctx, projectId)).items);
    expect(by.get("unknown")).toMatchObject({ costMicro: null, costLowerBound: true, unpricedEvents: 1 });
    expect(by.get("partial")).toMatchObject({ costMicro: 1_500, costLowerBound: true, unpricedEvents: 1 });
    expect(by.get("tools")).toMatchObject({ costMicro: 0, costLowerBound: false });
    expect(by.get("free")).toMatchObject({ costMicro: 0, costLowerBound: false });
    expect(by.get("full")).toMatchObject({ costMicro: 2_500, costLowerBound: false });
  });

  // ---- order and paging ----

  it("most recently active first; equal last activity is ordered by thread id descending; microseconds count", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { thread: "old", at: at(0) },
      { thread: "tie-a", at: at(5_000) },
      { thread: "tie-b", at: at(5_000) },
      { thread: "micro", at: at(5_000, 7) },
      { thread: "old", at: at(-1_000) }, // an older event never moves a thread down
    ]);
    expect((await list(ctx, projectId)).items.map((i) => i.threadId)).toEqual(["micro", "tie-b", "tie-a", "old"]);
  });

  it("a new event moves its thread to the top (order is by LAST activity, not by start)", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ thread: "first", at: at(0) }, { thread: "second", at: at(1_000) }, { thread: "first", at: at(9_000) }]);
    const r = await list(ctx, projectId);
    expect(r.items.map((i) => i.threadId)).toEqual(["first", "second"]);
    expect(r.items[0]).toMatchObject({ startedAtMs: base, lastActiveAtMs: base + 9_000 });
  });

  it("pages walk the whole list exactly once: no gap and no repeat, across ties and sub-millisecond differences", async () => {
    const { owner, projectId, ctx } = await tenant();
    const ids = Array.from({ length: 11 }, (_, i) => `th-${String(i).padStart(2, "0")}`);
    await seed(owner, projectId, ids.map((thread, i) => ({ thread, at: at(Math.floor(i / 3) * 1_000, i % 3 === 1 ? 7 : 0) })));
    const all = (await list(ctx, projectId, { limit: 100 })).items.map((i) => i.threadId);
    expect(all).toHaveLength(11);
    for (const size of [1, 2, 3, 4, 10, 11]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await list(ctx, projectId, { limit: size, cursor });
        expect(page.items.length).toBeLessThanOrEqual(size);
        seen.push(...page.items.map((i) => i.threadId));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(seen, `page size ${size}`).toEqual(all);
    }
  });

  it("a cursor past the end gives an empty page; a malformed one is a clean InvalidCursorError", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ thread: "a", at: at(0) }]);
    const past = await list(ctx, projectId, { cursor: encodeThreadCursor({ lastActive: at(-60_000), threadId: "a" }) });
    expect(past.items).toEqual([]);
    expect(past.nextCursor).toBeNull();
    const e = await failure(() => list(ctx, projectId, { cursor: "garbage!" }));
    expect(e).toBeInstanceOf(InvalidCursorError);
    expect(e!.message).toBe("invalid cursor");
  });

  it("a hostile cursor thread id is only a value: nothing breaks, nothing leaks", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ thread: "a", at: at(0) }]);
    const r = await list(ctx, projectId, { cursor: encodeThreadCursor({ lastActive: at(60_000), threadId: "x'; drop table events; --" }) });
    expect(r.items.map((i) => i.threadId)).toEqual(["a"]);
  });

  // ---- bounds ----

  it("the window is honoured and clamped: older events stay out, a 90-day request is 14 days, never the future", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { thread: "recent", at: at(0) },
      { thread: "three-hours-ago", at: new Date(nowMs - 3 * HOUR).toISOString() },
    ]);
    expect((await list(ctx, projectId)).items.map((i) => i.threadId)).toEqual(["recent"]);
    const wide = await list(ctx, projectId, { range: { fromMs: nowMs - 90 * 24 * HOUR, toMs: nowMs + 5 * 24 * HOUR } });
    expect(wide.window.clamped).toBe(true);
    expect(wide.window.toMs - wide.window.fromMs).toBe(14 * 24 * HOUR);
    expect(wide.window.toMs).toBeLessThanOrEqual(nowMs + HOUR);
    expect(wide.items.map((i) => i.threadId).sort()).toEqual(["recent", "three-hours-ago"]);
  });

  it("the scan cap is reported, not hidden: the NEWEST events are kept, whole timestamps only", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { thread: "a", at: at(0) },
      { thread: "b", at: at(1_000) },
      { thread: "c", at: at(2_000) },
      { thread: "c", at: at(3_000) },
      { thread: "d", at: at(4_000) },
      { thread: "e", at: at(5_000) },
    ]);
    const exact = await list(ctx, projectId, { scanCap: 6 });
    expect(exact.truncated).toBe(false);
    expect(exact.items).toHaveLength(5);
    const capped = await list(ctx, projectId, { scanCap: 4 });
    expect(capped.truncated).toBe(true);
    expect(capped.items.map((i) => [i.threadId, i.spanCount])).toEqual([["e", 1], ["d", 1], ["c", 2]]);
  });

  it("at the cap, rows tied on the boundary timestamp are dropped together", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { thread: "new", at: at(10_000) },
      { thread: "tie-1", at: at(5_000) },
      { thread: "tie-2", at: at(5_000) },
      { thread: "tie-3", at: at(5_000) },
    ]);
    const capped = await list(ctx, projectId, { scanCap: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.items.map((i) => i.threadId)).toEqual(["new"]);
  });

  it("an empty project gives an empty, untruncated page", async () => {
    const { ctx, projectId } = await tenant();
    const r = await list(ctx, projectId);
    expect(r).toMatchObject({ items: [], nextCursor: null, truncated: false });
  });

  // ---- content never ----

  it("never returns text from event_content or the error column, and the result has exactly the documented fields", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ thread: "t", status: "error", error: "SECRET-ERROR-TEXT", at: at(0) }]);
    const [, ev] = await raw(owner, [projectId], (t) => [t`select event_id from events where project_id = ${projectId}::uuid`]);
    await raw(owner, [projectId], (t) => [
      t`insert into event_content (event_id, project_id, input_text, output_text, expires_at) values (${ev![0]!.event_id}, ${projectId}::uuid, 'SECRET-PROMPT', 'SECRET-RESPONSE', now() + interval '1 day')`,
    ]);
    const r = await list(ctx, projectId);
    const json = JSON.stringify(r);
    for (const s of ["SECRET-ERROR-TEXT", "SECRET-PROMPT", "SECRET-RESPONSE"]) expect(json).not.toContain(s);
    expect(Object.keys(r.items[0]!).sort()).toEqual(Object.keys(threadListItemSchema.shape).sort());
  });

  // ---- tenant isolation ----

  it("IDOR: user B can never list project A's threads, with any option", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ thread: "a-secret-thread", at: at(0) }]);
    const attempts = [
      failure(() => list(b.ctx, a.projectId)),
      failure(() => list(b.ctx, a.projectId, { limit: 100, cursor: encodeThreadCursor({ lastActive: at(60_000), threadId: "zzz" }) })),
      failure(() => list(b.ctx, a.projectId, { range: { fromMs: 0, toMs: nowMs + HOUR } })),
    ];
    for (const e of await Promise.all(attempts)) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect(e!.message).toBe("not found");
    }
    expect((await list(a.ctx, a.projectId)).items.map((i) => i.threadId)).toEqual(["a-secret-thread"]);
    expect(JSON.stringify((await list(b.ctx, b.projectId)).items)).not.toContain("a-secret-thread");
  });

  it("a wrong project id gives the SAME answer as a missing one, a malformed one and a deleted one", async () => {
    const a = await tenant();
    const b = await tenant();
    const gone = await createProject(await sessionCtx(b.owner), { name: "gone" });
    const bCtx = await sessionCtx(b.owner);
    await deleteProject(bCtx, gone.id);
    const attempts = await Promise.all([
      failure(() => list(b.ctx, a.projectId)),
      failure(() => list(b.ctx, randomUUID())),
      failure(() => list(b.ctx, "not-a-uuid")),
      failure(() => list(bCtx, gone.id)),
    ]);
    for (const e of attempts) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect(e!.message).toBe("not found");
      expect(e!.name).toBe("NotFoundError");
    }
  });

  it("defence in depth: a context that WRONGLY lists another owner's project still cannot read it (explicit owner filter)", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ thread: "a-thread", at: at(0) }]);
    const forged = issueCtx<SessionCtx>({ kind: "session", ownerId: b.owner, projectIds: [b.projectId, a.projectId], readOnly: false });
    expect(await failure(() => list(forged, a.projectId))).toBeInstanceOf(NotFoundError);
  });

  it("RLS under the reader: another tenant's events are invisible even to a raw statement", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ thread: "a-thread", at: at(0) }]);
    const [, n] = await raw(b.owner, [b.projectId], (t) => [t`select count(*)::int as n from events where project_id = ${a.projectId}::uuid`]);
    expect(n![0]!.n).toBe(0);
  });

  it("one owner's two projects never leak into each other, even with the SAME thread id", async () => {
    const owner = await asUser();
    mockAuth.mockResolvedValue({ userId: owner });
    const first = (await ctxFromSession())!;
    const p1 = await createProject(first, { name: "one" });
    const p2 = await createProject(first, { name: "two" });
    const ctx = await sessionCtx(owner);
    await seed(owner, p1.id, [{ thread: "shared-id", at: at(0) }]);
    await seed(owner, p2.id, [{ thread: "shared-id", at: at(1_000) }, { thread: "shared-id", at: at(2_000) }]);
    const r1 = (await list(ctx, p1.id)).items;
    const r2 = (await list(ctx, p2.id)).items;
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ spanCount: 1, startedAtMs: base });
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({ spanCount: 2, startedAtMs: base + 1_000 });
  });

  it("a cursor taken from project A, used on project B, only ever shows B's own threads", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ thread: "a1", at: at(2_000) }, { thread: "a2", at: at(1_000) }]);
    await seed(b.owner, b.projectId, [{ thread: "b1", at: at(1_500) }]);
    const pageA = await list(a.ctx, a.projectId, { limit: 1 });
    expect(pageA.nextCursor).not.toBeNull();
    const onB = await list(b.ctx, b.projectId, { cursor: pageA.nextCursor! });
    expect(onB.items.map((i) => i.threadId)).toEqual(["b1"]);
  });

  it("is read-only: listing changes no row", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ thread: "t", at: at(0) }]);
    const snapshot = () => raw(owner, [projectId], (t) => [t`select count(*)::int as n, max(received_at)::text as r from events where project_id = ${projectId}::uuid`]);
    const before = (await snapshot())[1]![0];
    await list(ctx, projectId);
    await list(ctx, projectId, { limit: 1 });
    expect((await snapshot())[1]![0]).toEqual(before);
  });
});
