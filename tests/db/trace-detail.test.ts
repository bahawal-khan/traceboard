import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { ctxFromSession } from "@/lib/repo/ctx";
import { NotFoundError } from "@/lib/repo/errors";
import { createProject, deleteProject } from "@/lib/repo/projects";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";
import { getTrace, spanRowSchema } from "@/lib/repo/trace-detail";
import { buildTraceTree } from "@/lib/dashboard/trace-tree";
import { cleanupOwners } from "./helpers/cleanup";

/**
 * The trace DETAIL reader against the real database as app_rw, with Clerk mocked: span mapping, ordering, the row cap, the time
 * window, and above all tenant isolation (one not-found for everything that is not the caller's trace). Events are seeded
 * through the same RLS-scoped door the app uses. Skipped without DATABASE_URL. Run with `npm run test:db:traces`.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

const MIN = 60_000;
const HOUR = 3_600_000;

interface Ev {
  trace?: string | null;
  span?: string | null;
  parent?: string | null;
  name?: string | null;
  kind?: string | null;
  model?: string | null;
  status?: "ok" | "error";
  input?: number | null;
  output?: number | null;
  cached?: number | null;
  latency?: number | null;
  /** micro-USD; omit for NULL. */
  cost?: number | null;
  at: string;
  error?: string;
  eventId?: string;
}

run("trace detail reader (database)", () => {
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
    const project = await createProject(first, { name: "detail" });
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
          t`insert into events (event_id, project_id, trace_id, span_id, parent_id, kind, name, model, input_tokens, output_tokens, cached_tokens, latency_ms, cost_usd, status, error, occurred_at)
            values (${e.eventId ?? randomUUID()}, ${pid}::uuid, ${e.trace === undefined ? "tr" : e.trace}, ${e.span === undefined ? randomUUID() : e.span}, ${e.parent ?? null},
                    ${e.kind === undefined ? "llm" : e.kind}, ${e.name ?? null}, ${e.model ?? null}, ${e.input ?? null}, ${e.output ?? null}, ${e.cached ?? null}, ${e.latency ?? null},
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

  // ---- mapping ----

  it("returns every span of the trace with its metadata, oldest first, microseconds exact", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "t1", span: "child", parent: "root", name: "chat", model: "priced-1", input: 100, output: 20, cached: 10, cost: 1_500, latency: 800, at: at(1_000, 7) },
      { trace: "t1", span: "root", name: "agent.run", kind: "agent", latency: 5_000, at: at(0) },
      { trace: "t1", span: "bad", parent: "root", name: "search", kind: "tool", status: "error", at: at(2_000), latency: null },
      { trace: "t1", span: "unp", parent: "root", name: "chat", model: "mystery-7b", input: 5, output: 5, at: at(3_000), latency: 100 },
      { trace: "t1", span: "free", parent: "root", name: "chat", model: "free-1", cost: 0, at: at(3_500), latency: 100 },
      { trace: "other-trace", span: "x", at: at(0) },
    ]);
    const r = await getTrace(ctx, projectId, "t1");
    expect(r.truncated).toBe(false);
    expect(r.spans.map((s) => s.key)).toEqual(["root", "child", "bad", "unp", "free"]);
    const by = new Map(r.spans.map((s) => [s.key, s]));
    expect(by.get("root")).toMatchObject({ parentId: null, name: "agent.run", kind: "agent", isError: false, latencyMs: 5_000, startUs: base * 1000, costMicro: null, unpriced: false });
    expect(by.get("child")).toMatchObject({ parentId: "root", model: "priced-1", inputTokens: 100, outputTokens: 20, cachedTokens: 10, costMicro: 1_500, unpriced: false, startUs: (base + 1_000) * 1000 + 7 });
    expect(by.get("bad")).toMatchObject({ isError: true, latencyMs: null, model: null, costMicro: null, unpriced: false });
    expect(by.get("unp")).toMatchObject({ costMicro: null, unpriced: true }); // a model but no price: flagged, not 0
    expect(by.get("free")).toMatchObject({ costMicro: 0, unpriced: false }); // a genuine zero
    for (const s of r.spans) expect(spanRowSchema.safeParse(s).success).toBe(true);
  });

  it("an event sent without a span id gets a unique key; two such events are two spans", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "t", span: null, name: "a", at: at(0) },
      { trace: "t", span: null, name: "b", at: at(1_000) },
    ]);
    const r = await getTrace(ctx, projectId, "t");
    expect(r.spans).toHaveLength(2);
    expect(new Set(r.spans.map((s) => s.key)).size).toBe(2);
    expect(r.spans.every((s) => s.key.startsWith("ev-"))).toBe(true);
  });

  it("ties on the start time are ordered by event id, so the order is stable", async () => {
    const { owner, projectId, ctx } = await tenant();
    const ids = ["00000000-0000-4000-8000-00000000000c", "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"];
    await seed(owner, projectId, ids.map((eventId, i) => ({ trace: "t", span: `s${i}`, eventId, at: at(5_000) })));
    expect((await getTrace(ctx, projectId, "t")).spans.map((s) => s.key)).toEqual(["s1", "s2", "s0"]);
  });

  it("feeds the tree builder: orphans and duplicate span ids from real rows come out right", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "t", span: "r", name: "root", at: at(0), latency: 100 },
      { trace: "t", span: "c", parent: "r", at: at(10), latency: 10 },
      { trace: "t", span: "c", parent: "r", at: at(20), latency: 20 }, // duplicate span id
      { trace: "t", span: "o", parent: "never-received", at: at(30), latency: 5 },
    ]);
    const tree = buildTraceTree((await getTrace(ctx, projectId, "t")).spans);
    expect(tree).toMatchObject({ duplicates: 1, orphanCount: 1, rootCount: 2 });
    expect(tree.rows.map((x) => x.span.key)).toEqual(["r", "c", "o"]);
  });

  // ---- limits ----

  it("the row cap is reported, not hidden: the OLDEST spans are kept", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, Array.from({ length: 6 }, (_, i) => ({ trace: "big", span: `s${i}`, at: at(i * 1_000) })));
    const capped = await getTrace(ctx, projectId, "big", { spanCap: 4 });
    expect(capped.truncated).toBe(true);
    expect(capped.spans.map((s) => s.key)).toEqual(["s0", "s1", "s2", "s3"]);
    const exact = await getTrace(ctx, projectId, "big", { spanCap: 6 });
    expect(exact.truncated).toBe(false);
    expect(exact.spans).toHaveLength(6);
  });

  it("the time window is honoured: a span 30 hours in the future is outside it; one 3 hours ago is inside", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "t", span: "now", at: at(0) },
      { trace: "t", span: "earlier", at: new Date(nowMs - 3 * HOUR).toISOString() },
      { trace: "t", span: "far-future", at: new Date(nowMs + 30 * HOUR).toISOString() },
    ]);
    expect((await getTrace(ctx, projectId, "t")).spans.map((s) => s.key)).toEqual(["earlier", "now"]);
    // a trace that ONLY has out-of-window spans does not exist as far as the reader is concerned
    await seed(owner, projectId, [{ trace: "future-only", span: "f", at: new Date(nowMs + 30 * HOUR).toISOString() }]);
    expect(await failure(() => getTrace(ctx, projectId, "future-only"))).toBeInstanceOf(NotFoundError);
  });

  // ---- privacy ----

  it("never returns text from event_content or the error column, and the span has exactly the documented fields", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "t", span: "s", name: "root", status: "error", error: "SECRET-ERROR-TEXT", at: at(0) }]);
    const [, ev] = await raw(owner, [projectId], (t) => [t`select event_id from events where project_id = ${projectId}::uuid`]);
    await raw(owner, [projectId], (t) => [
      t`insert into event_content (event_id, project_id, input_text, output_text, expires_at) values (${ev![0]!.event_id}, ${projectId}::uuid, 'SECRET-PROMPT', 'SECRET-RESPONSE', now() + interval '1 day')`,
    ]);
    const r = await getTrace(ctx, projectId, "t");
    const json = JSON.stringify(r);
    for (const s of ["SECRET-ERROR-TEXT", "SECRET-PROMPT", "SECRET-RESPONSE"]) expect(json).not.toContain(s);
    expect(Object.keys(r.spans[0]!).sort()).toEqual(Object.keys(spanRowSchema.shape).sort());
    expect(r.spans[0]!.isError).toBe(true);
  });

  // ---- tenant isolation ----

  it("IDOR: user B cannot read project A's trace, with A's project id or with their own", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ trace: "a-secret-trace", span: "s", name: "a-root", at: at(0) }]);
    const attempts = await Promise.all([
      failure(() => getTrace(b.ctx, a.projectId, "a-secret-trace")), // A's project id
      failure(() => getTrace(b.ctx, b.projectId, "a-secret-trace")), // A's trace id under B's own project
    ]);
    for (const e of attempts) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect(e!.message).toBe("not found");
    }
    expect((await getTrace(a.ctx, a.projectId, "a-secret-trace")).spans).toHaveLength(1); // the data really exists
  });

  it("every way of 'not readable' gives the SAME error: foreign, never existed, malformed, deleted, bad trace id, another project's trace, no trace", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ trace: "a-trace", at: at(0) }]);
    await seed(b.owner, b.projectId, [{ trace: "b-trace", at: at(0) }]);
    const gone = await createProject(await sessionCtx(b.owner), { name: "gone" });
    const bCtx = await sessionCtx(b.owner);
    await seed(b.owner, gone.id, [{ trace: "gone-trace", at: at(0) }]);
    await deleteProject(bCtx, gone.id); // bCtx is now stale: it still lists a deleted project

    const errs = await Promise.all([
      failure(() => getTrace(b.ctx, a.projectId, "a-trace")), // foreign project
      failure(() => getTrace(b.ctx, randomUUID(), "b-trace")), // project that never existed
      failure(() => getTrace(b.ctx, "not-a-uuid", "b-trace")), // malformed project id
      failure(() => getTrace(bCtx, gone.id, "gone-trace")), // deleted project, stale context
      failure(() => getTrace(b.ctx, b.projectId, "no-such-trace")), // own project, trace does not exist
      failure(() => getTrace(b.ctx, b.projectId, "a-trace")), // own project, another project's trace
      failure(() => getTrace(b.ctx, b.projectId, "x\u0000y")), // malformed trace id
      failure(() => getTrace(b.ctx, b.projectId, "x".repeat(129))), // too long
      failure(() => getTrace(b.ctx, b.projectId, "")), // empty
    ]);
    for (const e of errs) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect(e!.message).toBe("not found");
      expect(e!.name).toBe("NotFoundError");
    }
  });

  it("defence in depth: a context that WRONGLY lists another owner's project still cannot read it (explicit owner filter)", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ trace: "a-trace", at: at(0) }]);
    const forged = issueCtx<SessionCtx>({ kind: "session", ownerId: b.owner, projectIds: [b.projectId, a.projectId], readOnly: false });
    expect(await failure(() => getTrace(forged, a.projectId, "a-trace"))).toBeInstanceOf(NotFoundError);
  });

  it("RLS under the reader: another tenant's events are invisible even to a raw statement", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ trace: "a-trace", at: at(0) }]);
    const [, n] = await raw(b.owner, [b.projectId], (t) => [t`select count(*)::int as n from events where project_id = ${a.projectId}::uuid and trace_id = 'a-trace'`]);
    expect(n![0]!.n).toBe(0);
  });

  it("the SAME trace id in two projects of one owner returns each project's own spans only", async () => {
    const owner = await asUser();
    mockAuth.mockResolvedValue({ userId: owner });
    const first = (await ctxFromSession())!;
    const p1 = await createProject(first, { name: "one" });
    const p2 = await createProject(first, { name: "two" });
    const ctx = await sessionCtx(owner);
    await seed(owner, p1.id, [{ trace: "shared-id", span: "p1-root", name: "p1", at: at(0) }]);
    await seed(owner, p2.id, [
      { trace: "shared-id", span: "p2-root", name: "p2", at: at(1_000) },
      { trace: "shared-id", span: "p2-child", parent: "p2-root", name: "p2c", at: at(2_000) },
    ]);
    expect((await getTrace(ctx, p1.id, "shared-id")).spans.map((s) => s.key)).toEqual(["p1-root"]);
    expect((await getTrace(ctx, p2.id, "shared-id")).spans.map((s) => s.key)).toEqual(["p2-root", "p2-child"]);
  });

  it("is read-only: reading changes no row", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "t", span: "s", at: at(0) }]);
    const snapshot = () => raw(owner, [projectId], (t) => [t`select count(*)::int as n, max(received_at)::text as r from events where project_id = ${projectId}::uuid`]);
    const before = (await snapshot())[1]![0];
    await getTrace(ctx, projectId, "t");
    await failure(() => getTrace(ctx, projectId, "missing"));
    expect((await snapshot())[1]![0]).toEqual(before);
  });
});
