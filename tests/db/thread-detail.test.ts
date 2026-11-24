import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { ctxFromSession } from "@/lib/repo/ctx";
import { NotFoundError } from "@/lib/repo/errors";
import { createProject, deleteProject } from "@/lib/repo/projects";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";
import { getThread } from "@/lib/repo/thread-detail";
import { getTrace } from "@/lib/repo/trace-detail";
import { listTraces, traceListItemSchema } from "@/lib/repo/traces";
import { cleanupOwners } from "./helpers/cleanup";

/**
 * The thread DETAIL reader against the real database as app_rw, with Clerk mocked: turns per trace, ordering, cost rules, the two
 * caps, the window, and above all tenant isolation (one not-found for everything that is not the caller's thread). Events are
 * seeded through the same RLS-scoped door the app uses. Skipped without DATABASE_URL. Run with `npm run test:db:threads`.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

const MIN = 60_000;
const HOUR = 3_600_000;

interface Ev {
  thread?: string | null;
  trace?: string | null;
  parent?: string | null;
  name?: string | null;
  model?: string | null;
  status?: "ok" | "error";
  input?: number | null;
  output?: number | null;
  latency?: number | null;
  /** micro-USD; omit for NULL. */
  cost?: number | null;
  at: string;
  error?: string;
}

run("thread detail reader (database)", () => {
  const sql = neon(url!);
  const users: string[] = [];
  const nowMs = Date.now();
  const base = Math.floor(nowMs / MIN) * MIN - 20 * MIN;
  const at = (offsetMs: number, micros = 0) =>
    new Date(base + offsetMs).toISOString().replace(/\.(\d{3})Z$/, (_m, ms: string) => `.${ms}${String(micros).padStart(3, "0")}Z`);

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
    const project = await createProject(first, { name: "thread-detail" });
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
          t`insert into events (event_id, project_id, thread_id, trace_id, span_id, parent_id, kind, name, model, input_tokens, output_tokens, latency_ms, cost_usd, status, error, occurred_at)
            values (${randomUUID()}, ${pid}::uuid, ${e.thread === undefined ? "th" : e.thread}, ${e.trace === undefined ? "tr" : e.trace}, ${randomUUID()}, ${e.parent ?? null}, 'llm',
                    ${e.name ?? null}, ${e.model ?? null}, ${e.input ?? null}, ${e.output ?? null}, ${e.latency ?? null},
                    ${e.cost === undefined || e.cost === null ? null : e.cost / 1_000_000}, ${e.status ?? "ok"}, ${e.error ?? null}, ${e.at}::timestamptz)`,
      ),
    );
  const failure = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return e as Error;
    }
    return null;
  };

  beforeEach(() => {
    mockAuth.mockResolvedValue({ userId: null });
  });
  afterAll(async () => {
    await cleanupOwners(sql, users);
  });

  // ---- turns ----

  it("one turn per trace, oldest first: spans, errors, tokens, duration, root name", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { thread: "t", trace: "turn-2", parent: null, name: "second", input: 7, output: 3, latency: 400, at: at(10_000) },
      { thread: "t", trace: "turn-1", parent: null, name: "first", input: 100, output: 20, latency: 500, at: at(0) },
      { thread: "t", trace: "turn-1", parent: "r", name: "tool", status: "error", latency: 100, at: at(1_000) },
      { thread: "t", trace: "turn-1", parent: "r", name: "chat", input: 5, latency: 50, at: at(2_000) },
      { thread: "other", trace: "turn-x", at: at(0) },
    ]);
    const r = await getThread(ctx, projectId, "t");
    expect(r.threadId).toBe("t");
    expect(r.truncated).toBe(false);
    expect(r.untracedEvents).toBe(0);
    expect(r.turns.map((x) => x.traceId)).toEqual(["turn-1", "turn-2"]);
    expect(r.turns[0]).toMatchObject({ spanCount: 3, errorCount: 1, totalTokens: 125 /* (100+20) + 0 (error event, no tokens) + (5+0) */, startedAtMs: base, durationMs: 2_050, rootName: "first", hasRoot: true });
    expect(r.turns[1]).toMatchObject({ spanCount: 1, errorCount: 0, totalTokens: 10, startedAtMs: base + 10_000, durationMs: 400, rootName: "second" });
    for (const x of r.turns) expect(traceListItemSchema.safeParse(x).success).toBe(true);
  });

  it("PARITY: a turn equals the trace-list item of the same trace, field for field, over the same rows", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      // tokens: both set, only input, only output, neither; an error event; cost known, partial, unpriced, tool-only
      { thread: "p", trace: "full", parent: null, name: "root", model: "priced-1", input: 100, output: 20, cost: 1_500, latency: 500, at: at(0) },
      { thread: "p", trace: "full", parent: "r", name: "tool", status: "error", latency: 100, at: at(1_000) },
      { thread: "p", trace: "full", parent: "r", name: "in-only", model: "priced-1", input: 5, cost: 100, latency: 50, at: at(2_000, 3) },
      { thread: "p", trace: "full", parent: "r", name: "out-only", model: "priced-1", output: 9, cost: 100, at: at(2_000, 9) },
      { thread: "p", trace: "unpriced", parent: null, name: "u", model: "mystery-7b", input: 11, output: 2, latency: 40, at: at(5_000) },
      { thread: "p", trace: "partial", parent: null, name: "pp", model: "priced-1", input: 1, output: 1, cost: 700, at: at(6_000) },
      { thread: "p", trace: "partial", parent: "x", name: "pq", model: "mystery-7b", input: 2, output: 2, at: at(6_500) },
      { thread: "p", trace: "tools", parent: null, name: "t", latency: 10, at: at(7_000) },
      { thread: "p", trace: "orphan", parent: "missing", name: "o", input: 3, output: 4, latency: 5, at: at(8_000) },
      { thread: "p", trace: "free", parent: null, model: "free-1", cost: 0, input: 8, output: 8, at: at(9_000) },
      { thread: "p", trace: "errors-only", parent: null, status: "error", error: "x", at: at(10_000) },
    ]);
    const range = { fromMs: nowMs - 2 * HOUR, toMs: nowMs };
    const listed = (await listTraces(ctx, projectId, { range, nowMs, limit: 100 })).items;
    const turns = (await getThread(ctx, projectId, "p")).turns;
    // exactly the seven seeded traces, in both readers (so the toEqual loop below covers every one of them)
    const expectedIds = ["errors-only", "free", "full", "orphan", "partial", "tools", "unpriced"];
    expect(listed.map((i) => i.traceId).sort()).toEqual(expectedIds);
    expect(turns).toHaveLength(7);
    expect(turns.map((x) => x.traceId).sort()).toEqual(expectedIds);
    const byTrace = new Map(listed.map((i) => [i.traceId, i]));
    for (const turn of turns) expect(turn, turn.traceId).toEqual(byTrace.get(turn.traceId));
    // and the hand-computed numbers, so the two cannot be wrong in the same way
    expect(byTrace.get("full")).toMatchObject({ totalTokens: 120 + 5 + 9, spanCount: 4, errorCount: 1 });
    expect(byTrace.get("unpriced")).toMatchObject({ totalTokens: 13, costMicro: null, costLowerBound: true });
    expect(byTrace.get("partial")).toMatchObject({ totalTokens: 6, costMicro: 700, costLowerBound: true });
    expect(byTrace.get("tools")).toMatchObject({ totalTokens: 0, costMicro: 0, costLowerBound: false });
    // the other three, by hand: free = 8+8 tokens and a real 0; orphan = 3+4 tokens and no root; errors-only = 0 tokens, 1 error, no cost
    expect(byTrace.get("free")).toMatchObject({ totalTokens: 16, costMicro: 0, costLowerBound: false, hasRoot: true });
    expect(byTrace.get("orphan")).toMatchObject({ totalTokens: 7, hasRoot: false, rootName: null });
    expect(byTrace.get("errors-only")).toMatchObject({ totalTokens: 0, errorCount: 1, costMicro: 0, costLowerBound: false });
  });

  it("only this thread's events count: a trace that also has events in another thread shows just this thread's part", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { thread: "a", trace: "shared", at: at(0) },
      { thread: "a", trace: "shared", at: at(1_000) },
      { thread: "b", trace: "shared", at: at(2_000) },
    ]);
    expect((await getThread(ctx, projectId, "a")).turns[0]).toMatchObject({ traceId: "shared", spanCount: 2 });
    expect((await getThread(ctx, projectId, "b")).turns[0]).toMatchObject({ traceId: "shared", spanCount: 1 });
  });

  it("ties on the start are ordered by trace id ascending; microseconds count", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "b", at: at(0) },
      { trace: "a", at: at(0) },
      { trace: "c", at: at(0, 5) },
      { trace: "z-early", at: at(-1_000) },
    ]);
    expect((await getThread(ctx, projectId, "th")).turns.map((x) => x.traceId)).toEqual(["z-early", "a", "b", "c"]);
  });

  it("events without a trace id are counted but are not turns; a thread of only such events is still found", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { thread: "mixed", trace: null, at: at(0) },
      { thread: "mixed", trace: "t1", at: at(1_000) },
      { thread: "loose", trace: null, at: at(0) },
      { thread: "loose", trace: null, at: at(1_000) },
    ]);
    const mixed = await getThread(ctx, projectId, "mixed");
    expect(mixed.turns.map((x) => x.traceId)).toEqual(["t1"]);
    expect(mixed.untracedEvents).toBe(1);
    const loose = await getThread(ctx, projectId, "loose");
    expect(loose.turns).toEqual([]);
    expect(loose.untracedEvents).toBe(2);
  });

  it("cost is never invented: unknown = null, partial = a lower bound, nothing to price = a real 0, free model = 0", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "unknown", model: "mystery-7b", at: at(0) },
      { trace: "partial", model: "priced-1", cost: 1_500, at: at(1_000) },
      { trace: "partial", model: "mystery-7b", at: at(1_500) },
      { trace: "tools", model: null, at: at(2_000) },
      { trace: "free", model: "free-1", cost: 0, at: at(3_000) },
      { trace: "full", model: "priced-1", cost: 2_500, at: at(4_000) },
    ]);
    const by = new Map((await getThread(ctx, projectId, "th")).turns.map((x) => [x.traceId, x]));
    expect(by.get("unknown")).toMatchObject({ costMicro: null, costLowerBound: true, unpricedEvents: 1 });
    expect(by.get("partial")).toMatchObject({ costMicro: 1_500, costLowerBound: true, unpricedEvents: 1 });
    expect(by.get("tools")).toMatchObject({ costMicro: 0, costLowerBound: false });
    expect(by.get("free")).toMatchObject({ costMicro: 0, costLowerBound: false });
    expect(by.get("full")).toMatchObject({ costMicro: 2_500, costLowerBound: false });
  });

  it("an orphan turn (every parent missing) is kept without a root name", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "orphan", parent: "missing", name: "child", at: at(0) }]);
    expect((await getThread(ctx, projectId, "th")).turns[0]).toMatchObject({ hasRoot: false, rootName: null });
  });

  it("every turn links to a trace the trace detail can open", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "linked-1", at: at(0) }, { trace: "linked-2", at: at(1_000) }]);
    const r = await getThread(ctx, projectId, "th");
    for (const x of r.turns) expect((await getTrace(ctx, projectId, x.traceId)).spans.length).toBe(x.spanCount);
  });

  // ---- bounds ----

  it("the event cap is reported: the OLDEST events are kept, whole timestamps only", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "t1", at: at(0) },
      { trace: "t2", at: at(1_000) },
      { trace: "t3", at: at(2_000) },
      { trace: "t3", at: at(3_000) },
      { trace: "t4", at: at(4_000) },
    ]);
    const exact = await getThread(ctx, projectId, "th", { scanCap: 5 });
    expect(exact.truncated).toBe(false);
    expect(exact.turns.map((x) => x.traceId)).toEqual(["t1", "t2", "t3", "t4"]);
    const capped = await getThread(ctx, projectId, "th", { scanCap: 3 }); // reads t1, t2, t3(+2 s), t3(+3 s) to prove the cap; keeps older than the newest read
    expect(capped.truncated).toBe(true);
    expect(capped.turns.map((x) => [x.traceId, x.spanCount])).toEqual([["t1", 1], ["t2", 1], ["t3", 1]]);
  });

  it("at the event cap, rows tied on the boundary timestamp are dropped together", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "old", at: at(0) },
      { trace: "tie-1", at: at(5_000) },
      { trace: "tie-2", at: at(5_000) },
      { trace: "tie-3", at: at(5_000) },
    ]);
    const capped = await getThread(ctx, projectId, "th", { scanCap: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.turns.map((x) => x.traceId)).toEqual(["old"]);
  });

  it("the turn cap is reported: the EARLIEST turns are kept", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, ["a", "b", "c", "d"].map((trace, i) => ({ trace, at: at(i * 1_000) })));
    const capped = await getThread(ctx, projectId, "th", { turnCap: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.turns.map((x) => x.traceId)).toEqual(["a", "b"]);
    const exact = await getThread(ctx, projectId, "th", { turnCap: 4 });
    expect(exact.truncated).toBe(false);
    expect(exact.turns).toHaveLength(4);
  });

  it("the window: an event older than the 14-day retention is not read; one 20 minutes ago is", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ thread: "recent", trace: "r", at: at(0) }]);
    expect((await getThread(ctx, projectId, "recent")).turns).toHaveLength(1);
    // a clock so far in the past that the window excludes it
    const far = await getThread(ctx, projectId, "recent", { nowMs: nowMs + 20 * 24 * HOUR }).then(() => null, (e: Error) => e);
    expect(far).toBeInstanceOf(NotFoundError);
  });

  // ---- content never ----

  it("never returns text from event_content or the error column, and the turn has exactly the documented fields", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "t", parent: null, name: "root", status: "error", error: "SECRET-ERROR-TEXT", at: at(0) }]);
    const [, ev] = await raw(owner, [projectId], (t) => [t`select event_id from events where project_id = ${projectId}::uuid`]);
    await raw(owner, [projectId], (t) => [
      t`insert into event_content (event_id, project_id, input_text, output_text, expires_at) values (${ev![0]!.event_id}, ${projectId}::uuid, 'SECRET-PROMPT', 'SECRET-RESPONSE', now() + interval '1 day')`,
    ]);
    const r = await getThread(ctx, projectId, "th");
    const json = JSON.stringify(r);
    for (const s of ["SECRET-ERROR-TEXT", "SECRET-PROMPT", "SECRET-RESPONSE"]) expect(json).not.toContain(s);
    expect(Object.keys(r.turns[0]!).sort()).toEqual(Object.keys(traceListItemSchema.shape).sort());
  });

  // ---- tenant isolation: ONE identical NotFound ----

  it("IDOR: user B cannot read project A's thread; the answer is the same as for an unknown thread, a malformed id, a missing, a malformed and a deleted project", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ thread: "a-secret-thread", trace: "a-secret-trace", at: at(0) }]);
    const gone = await createProject(await sessionCtx(b.owner), { name: "gone" });
    const bCtx = await sessionCtx(b.owner);
    await deleteProject(bCtx, gone.id); // bCtx is now stale: it still lists a deleted project
    const attempts = await Promise.all([
      failure(() => getThread(b.ctx, a.projectId, "a-secret-thread")), // foreign project
      failure(() => getThread(b.ctx, b.projectId, "a-secret-thread")), // right project, someone else's thread id
      failure(() => getThread(b.ctx, b.projectId, "no-such-thread")),
      failure(() => getThread(b.ctx, b.projectId, "")),
      failure(() => getThread(b.ctx, b.projectId, "x".repeat(129))),
      failure(() => getThread(b.ctx, randomUUID(), "a-secret-thread")),
      failure(() => getThread(b.ctx, "not-a-uuid", "a-secret-thread")),
      failure(() => getThread(bCtx, gone.id, "a-secret-thread")),
      failure(() => getThread(a.ctx, a.projectId, "no-such-thread")),
    ]);
    for (const e of attempts) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect(e!.message).toBe("not found");
      expect(e!.name).toBe("NotFoundError");
    }
    expect((await getThread(a.ctx, a.projectId, "a-secret-thread")).turns.map((x) => x.traceId)).toEqual(["a-secret-trace"]); // the data really exists
  });

  it("defence in depth: a context that WRONGLY lists another owner's project still cannot read it (explicit owner filter)", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ thread: "a-thread", at: at(0) }]);
    const forged = issueCtx<SessionCtx>({ kind: "session", ownerId: b.owner, projectIds: [b.projectId, a.projectId], readOnly: false });
    expect(await failure(() => getThread(forged, a.projectId, "a-thread"))).toBeInstanceOf(NotFoundError);
  });

  it("RLS under the reader: another tenant's thread events are invisible even to a raw statement", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ thread: "a-thread", at: at(0) }]);
    const [, n] = await raw(b.owner, [b.projectId], (t) => [t`select count(*)::int as n from events where thread_id = 'a-thread'`]);
    expect(n![0]!.n).toBe(0);
  });

  it("one owner's two projects never leak into each other, even with the SAME thread id", async () => {
    const owner = await asUser();
    mockAuth.mockResolvedValue({ userId: owner });
    const first = (await ctxFromSession())!;
    const p1 = await createProject(first, { name: "one" });
    const p2 = await createProject(first, { name: "two" });
    const ctx = await sessionCtx(owner);
    await seed(owner, p1.id, [{ thread: "shared", trace: "p1-turn", at: at(0) }]);
    await seed(owner, p2.id, [{ thread: "shared", trace: "p2-turn-a", at: at(1_000) }, { thread: "shared", trace: "p2-turn-b", at: at(2_000) }]);
    expect((await getThread(ctx, p1.id, "shared")).turns.map((x) => x.traceId)).toEqual(["p1-turn"]);
    expect((await getThread(ctx, p2.id, "shared")).turns.map((x) => x.traceId)).toEqual(["p2-turn-a", "p2-turn-b"]);
    await seed(owner, p2.id, [{ thread: "only-in-two", at: at(0) }]);
    expect(await failure(() => getThread(ctx, p1.id, "only-in-two"))).toBeInstanceOf(NotFoundError);
  });

  it("a hostile thread id is only a value: nothing breaks, nothing leaks", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ thread: "ok", at: at(0) }]);
    expect(await failure(() => getThread(ctx, projectId, "x'; drop table events; --"))).toBeInstanceOf(NotFoundError);
    expect((await getThread(ctx, projectId, "ok")).turns).toHaveLength(1);
  });

  it("is read-only: reading changes no row", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ thread: "t", at: at(0) }]);
    const snapshot = () => raw(owner, [projectId], (t) => [t`select count(*)::int as n, max(received_at)::text as r from events where project_id = ${projectId}::uuid`]);
    const before = (await snapshot())[1]![0];
    await getThread(ctx, projectId, "t");
    expect((await snapshot())[1]![0]).toEqual(before);
  });
});
