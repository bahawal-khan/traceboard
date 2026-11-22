import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { ctxFromSession } from "@/lib/repo/ctx";
import { InvalidCursorError, NotFoundError } from "@/lib/repo/errors";
import { createProject, deleteProject } from "@/lib/repo/projects";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";
import { encodeCursor, listTraces, traceListItemSchema, type TraceListItem } from "@/lib/repo/traces";
import { cleanupOwners } from "./helpers/cleanup";

/**
 * The trace LIST reader against the real database as app_rw, with Clerk mocked: aggregation per trace, orphans, cost rules,
 * keyset pagination (ties, microseconds), the scan cap, and above all tenant isolation. Events are seeded through the same
 * RLS-scoped door the app uses. Skipped without DATABASE_URL. Run alone with `npm run test:db:traces`.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

const MIN = 60_000;
const HOUR = 3_600_000;

interface Ev {
  trace?: string | null;
  parent?: string | null;
  name?: string | null;
  model?: string | null;
  status?: "ok" | "error";
  input?: number | null;
  output?: number | null;
  latency?: number | null;
  /** micro-USD; omit for NULL (unpriced). */
  cost?: number | null;
  /** ISO text, microseconds allowed. */
  at: string;
  error?: string;
}

run("trace list reader (database)", () => {
  const sql = neon(url!);
  const users: string[] = [];
  const nowMs = Date.now();
  /** Whole-minute anchor, 20 minutes ago: all seeded events are in the past and inside the current partitions. */
  const base = Math.floor(nowMs / MIN) * MIN - 20 * MIN;
  const at = (offsetMs: number, micros = 0) => {
    const d = new Date(base + offsetMs);
    return d.toISOString().replace(/\.(\d{3})Z$/, (_m, ms: string) => `.${ms}${String(micros).padStart(3, "0")}Z`);
  };
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
    const project = await createProject(first, { name: "traces" });
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
          t`insert into events (event_id, project_id, trace_id, span_id, parent_id, kind, name, model, input_tokens, output_tokens, latency_ms, cost_usd, status, error, occurred_at)
            values (${randomUUID()}, ${pid}::uuid, ${e.trace === undefined ? "tr" : e.trace}, ${randomUUID()}, ${e.parent ?? null}, 'llm', ${e.name ?? null}, ${e.model ?? null},
                    ${e.input ?? null}, ${e.output ?? null}, ${e.latency ?? null}, ${e.cost === undefined || e.cost === null ? null : e.cost / 1_000_000}, ${e.status ?? "ok"}, ${e.error ?? null},
                    ${e.at}::timestamptz)`,
      ),
    );
  const list = (ctx: SessionCtx, pid: string, o: Partial<Parameters<typeof listTraces>[2]> = {}) => listTraces(ctx, pid, { range, nowMs, ...o });
  const failure = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return e as Error;
    }
    return null;
  };
  const byId = (items: TraceListItem[]) => new Map(items.map((i) => [i.traceId, i]));

  beforeEach(() => {
    mockAuth.mockResolvedValue({ userId: null });
  });
  afterAll(async () => {
    await cleanupOwners(sql, users);
  });

  // ---- aggregation ----

  it("one row per trace: spans, errors, tokens, cost, duration (end of the last span minus start of the first), root name", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "t1", parent: null, name: "agent.run", at: at(0), latency: 5_000 },
      { trace: "t1", parent: "root", name: "chat", model: "priced-1", input: 100, output: 20, cost: 1_000, at: at(1_000), latency: 2_000 },
      { trace: "t1", parent: "root", name: "search", at: at(3_000), latency: 4_000 }, // ends at +7 s: the latest end
      { trace: "t1", parent: "root", name: "chat", model: "priced-1", input: 50, output: null, cost: 500, status: "error", at: at(500), latency: null },
    ]);
    const r = await list(ctx, projectId);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toEqual({
      traceId: "t1", startedAtMs: base, durationMs: 7_000, spanCount: 4, errorCount: 1, totalTokens: 170,
      costMicro: 1_500, costLowerBound: false, unpricedEvents: 0, rootName: "agent.run", hasRoot: true,
    });
    expect(traceListItemSchema.safeParse(r.items[0]).success).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.nextCursor).toBeNull();
  });

  it("cost is never invented: unknown = null, partial = a lower bound, nothing to price = a real 0, free model = 0", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "all-unpriced", parent: null, model: "mystery-7b", input: 10, output: 5, at: at(0) },
      { trace: "mixed", parent: null, model: "priced-1", input: 10, output: 5, cost: 700, at: at(1_000) },
      { trace: "mixed", parent: "r", model: "mystery-7b", input: 10, output: 5, at: at(1_100) },
      { trace: "tool-only", parent: null, name: "lookup", at: at(2_000) },
      { trace: "free", parent: null, model: "free-1", input: 10, output: 5, cost: 0, at: at(3_000) },
      { trace: "no-tokens", parent: null, model: "priced-1", at: at(4_000) }, // a model but no token counts: ingest could not price it
    ]);
    const m = byId((await list(ctx, projectId)).items);
    expect(m.get("all-unpriced")).toMatchObject({ costMicro: null, costLowerBound: true, unpricedEvents: 1 });
    expect(m.get("mixed")).toMatchObject({ costMicro: 700, costLowerBound: true, unpricedEvents: 1 });
    expect(m.get("tool-only")).toMatchObject({ costMicro: 0, costLowerBound: false, unpricedEvents: 0 });
    expect(m.get("free")).toMatchObject({ costMicro: 0, costLowerBound: false });
    expect(m.get("no-tokens")).toMatchObject({ costMicro: null, costLowerBound: true });
  });

  it("an orphan trace (every parent missing) is listed, without a root name; events without a trace id are not traces", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "orphan", parent: "lost-1", name: "child-a", at: at(0) },
      { trace: "orphan", parent: "lost-1", name: "child-b", at: at(1_000) },
      { trace: null, parent: null, name: "loose", at: at(2_000) },
      { trace: "rooted-late", parent: "x", name: "child", at: at(3_000) },
      { trace: "rooted-late", parent: null, name: "late-root", at: at(4_000) }, // root arrives later than a child: still the root
    ]);
    const r = await list(ctx, projectId);
    expect(r.items.map((i) => i.traceId).sort()).toEqual(["orphan", "rooted-late"]);
    const m = byId(r.items);
    expect(m.get("orphan")).toMatchObject({ hasRoot: false, rootName: null, spanCount: 2 });
    expect(m.get("rooted-late")).toMatchObject({ hasRoot: true, rootName: "late-root", spanCount: 2 });
  });

  it("with two roots the EARLIEST one names the trace", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "two", parent: null, name: "second", at: at(5_000) },
      { trace: "two", parent: null, name: "first", at: at(1_000) },
    ]);
    expect((await list(ctx, projectId)).items[0]!.rootName).toBe("first");
  });

  // ---- order and pagination ----

  it("newest trace first; equal starts are ordered by trace id descending; microseconds count", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "old", at: at(0) },
      { trace: "b-tie", at: at(10_000) },
      { trace: "a-tie", at: at(10_000) },
      { trace: "c-tie", at: at(10_000) },
      { trace: "newest-us", at: at(10_000, 5) }, // 5 microseconds later than the tie group: same millisecond
    ]);
    expect((await list(ctx, projectId)).items.map((i) => i.traceId)).toEqual(["newest-us", "c-tie", "b-tie", "a-tie", "old"]);
  });

  it("pages walk the whole list exactly once: no gap and no repeat, across ties and sub-millisecond starts", async () => {
    const { owner, projectId, ctx } = await tenant();
    const ids = Array.from({ length: 11 }, (_, i) => `tr-${String(i).padStart(2, "0")}`);
    await seed(
      owner,
      projectId,
      ids.map((trace, i) => ({ trace, at: at(Math.floor(i / 3) * 1_000, i % 3 === 1 ? 7 : 0) })), // per group of 3: two starts are exactly equal, one is 7 microseconds later
    );
    const all = (await list(ctx, projectId, { limit: 100 })).items.map((i) => i.traceId);
    expect(all).toHaveLength(11);
    for (const size of [1, 2, 3, 4, 10, 11]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await list(ctx, projectId, { limit: size, cursor });
        expect(page.items.length).toBeLessThanOrEqual(size);
        seen.push(...page.items.map((i) => i.traceId));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(seen, `page size ${size}`).toEqual(all);
    }
  });

  it("a status filter applies before paging: pages hold only matching traces", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "ok-1", at: at(0) },
      { trace: "bad-1", at: at(1_000), status: "error" },
      { trace: "ok-2", at: at(2_000) },
      { trace: "bad-2", at: at(3_000) },
      { trace: "bad-2", at: at(3_500), status: "error" }, // one failed span marks the whole trace
      { trace: "bad-3", at: at(4_000), status: "error" },
    ]);
    const bad: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const p = await list(ctx, projectId, { status: "error", limit: 2, cursor });
      bad.push(...p.items.map((x) => x.traceId));
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect(bad).toEqual(["bad-3", "bad-2", "bad-1"]);
    expect((await list(ctx, projectId, { status: "ok" })).items.map((x) => x.traceId)).toEqual(["ok-2", "ok-1"]);
  });

  it("a cursor past the end gives an empty page; a malformed one is a clean InvalidCursorError (and no SQL text)", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "only", at: at(0) }]);
    const past = encodeCursor({ start: "2000-01-01T00:00:00.000000Z", traceId: "a" });
    expect((await list(ctx, projectId, { cursor: past })).items).toEqual([]);
    for (const bad of ["garbage", "", encodeCursor({ start: "2026-02-31T00:00:00.000000Z", traceId: "a" })]) {
      const e = await failure(() => list(ctx, projectId, { cursor: bad }));
      expect(e).toBeInstanceOf(InvalidCursorError);
      expect(e!.message).toBe("invalid cursor");
    }
  });

  it("a hostile cursor trace id is only a value: nothing breaks, nothing leaks", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "only", at: at(0) }]);
    const evil = encodeCursor({ start: at(60_000), traceId: "x'; drop table events; --" });
    expect((await list(ctx, projectId, { cursor: evil })).items.map((i) => i.traceId)).toEqual(["only"]);
    expect((await sql`select count(*)::int as n from pg_class where relname = 'events'`)[0]!.n).toBe(1);
  });

  // ---- window and scan cap ----

  it("the window is honoured and clamped: older events stay out, a 90-day request is 14 days, never the future", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "recent", at: at(0) },
      { trace: "three-hours-ago", at: new Date(nowMs - 3 * HOUR).toISOString() },
    ]);
    expect((await list(ctx, projectId, { range: { fromMs: nowMs - 2 * HOUR, toMs: nowMs } })).items.map((i) => i.traceId)).toEqual(["recent"]);
    const wide = await list(ctx, projectId, { range: { fromMs: 0, toMs: nowMs + 90 * 24 * HOUR } });
    expect(wide.window.toMs - wide.window.fromMs).toBe(14 * 24 * HOUR);
    expect(wide.window.toMs).toBeLessThanOrEqual(Math.floor(nowMs / HOUR) * HOUR + HOUR);
    expect(wide.items.map((i) => i.traceId).sort()).toEqual(["recent", "three-hours-ago"]);
    expect((await list(ctx, projectId, { range: { fromMs: nowMs, toMs: nowMs - HOUR } })).items).toEqual([]);
  });

  it("the scan cap is reported, not hidden: the NEWEST events are kept, whole timestamps only", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "a", at: at(0) },
      { trace: "b", at: at(1_000) },
      { trace: "c", at: at(2_000) },
      { trace: "c", at: at(3_000) },
      { trace: "d", at: at(4_000) },
      { trace: "e", at: at(5_000) },
    ]);
    const exact = await list(ctx, projectId, { scanCap: 6 });
    expect(exact.truncated).toBe(false);
    expect(exact.items).toHaveLength(5);

    const capped = await list(ctx, projectId, { scanCap: 4 }); // reads e, d, c(+3 s), c(+2 s) and one more (b) to prove the cap was hit
    expect(capped.truncated).toBe(true);
    expect(capped.items.map((i) => [i.traceId, i.spanCount])).toEqual([["e", 1], ["d", 1], ["c", 2]]);
  });

  it("at the cap, rows tied on the boundary timestamp are dropped together (the result never depends on which tied row the LIMIT cut)", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [
      { trace: "new", at: at(10_000) },
      { trace: "tie-1", at: at(5_000) },
      { trace: "tie-2", at: at(5_000) },
      { trace: "tie-3", at: at(5_000) },
    ]);
    const capped = await list(ctx, projectId, { scanCap: 2 }); // reads new + two of the three tied rows, then one more to prove the cap
    expect(capped.truncated).toBe(true);
    expect(capped.items.map((i) => i.traceId)).toEqual(["new"]);
  });

  it("an empty page still tells the truth about the cap (status filter that matches nothing in a truncated window)", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "a", at: at(0) }, { trace: "b", at: at(1_000) }, { trace: "c", at: at(2_000), status: "error" }]);
    const r = await list(ctx, projectId, { scanCap: 1, status: "error" }); // the error trace is the newest and is kept...
    expect(r.truncated).toBe(true);
    const none = await list(ctx, projectId, { scanCap: 2, status: "error", cursor: encodeCursor({ start: "2000-01-01T00:00:00.000000Z", traceId: "a" }) });
    expect(none.items).toEqual([]);
    expect(none.truncated).toBe(true);
  });

  // ---- privacy ----

  it("never returns text from event_content or the error column, and the result has exactly the documented fields", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "t", parent: null, name: "root", status: "error", error: "SECRET-ERROR-TEXT", at: at(0) }]);
    const [, ev] = await raw(owner, [projectId], (t) => [t`select event_id from events where project_id = ${projectId}::uuid`]);
    await raw(owner, [projectId], (t) => [
      t`insert into event_content (event_id, project_id, input_text, output_text, expires_at) values (${ev![0]!.event_id}, ${projectId}::uuid, 'SECRET-PROMPT', 'SECRET-RESPONSE', now() + interval '1 day')`,
    ]);
    const r = await list(ctx, projectId);
    const json = JSON.stringify(r);
    for (const s of ["SECRET-ERROR-TEXT", "SECRET-PROMPT", "SECRET-RESPONSE"]) expect(json).not.toContain(s);
    expect(Object.keys(r.items[0]!).sort()).toEqual(Object.keys(traceListItemSchema.shape).sort());
  });

  // ---- tenant isolation ----

  it("IDOR: user B can never list project A's traces, with any option", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ trace: "a-secret-trace", name: "a-root", at: at(0) }]);
    const attempts = [
      failure(() => list(b.ctx, a.projectId)),
      failure(() => list(b.ctx, a.projectId, { status: "error" })),
      failure(() => list(b.ctx, a.projectId, { limit: 100, cursor: encodeCursor({ start: at(60_000), traceId: "zzz" }) })),
      failure(() => list(b.ctx, a.projectId, { range: { fromMs: 0, toMs: nowMs + HOUR } })),
    ];
    for (const e of await Promise.all(attempts)) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect(e!.message).toBe("not found");
    }
    expect((await list(a.ctx, a.projectId)).items.map((i) => i.traceId)).toEqual(["a-secret-trace"]); // the data really exists
    expect(JSON.stringify((await list(b.ctx, b.projectId)).items)).not.toContain("a-secret-trace");
  });

  it("a wrong project id gives the SAME answer as a missing one, a malformed one and a deleted one", async () => {
    const a = await tenant();
    const b = await tenant();
    const gone = await createProject(await sessionCtx(b.owner), { name: "gone" });
    const bCtx = await sessionCtx(b.owner);
    await deleteProject(bCtx, gone.id); // bCtx is now stale: it still lists a deleted project
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
    await seed(a.owner, a.projectId, [{ trace: "a-trace", at: at(0) }]);
    const forged = issueCtx<SessionCtx>({ kind: "session", ownerId: b.owner, projectIds: [b.projectId, a.projectId], readOnly: false });
    expect(await failure(() => list(forged, a.projectId))).toBeInstanceOf(NotFoundError);
  });

  it("RLS under the reader: another tenant's events are invisible even to a raw statement", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ trace: "a-trace", at: at(0) }]);
    const [, n] = await raw(b.owner, [b.projectId], (t) => [t`select count(*)::int as n from events where project_id = ${a.projectId}::uuid`]);
    expect(n![0]!.n).toBe(0);
  });

  it("one owner's two projects never leak into each other, even with the SAME trace id", async () => {
    const owner = await asUser();
    mockAuth.mockResolvedValue({ userId: owner });
    const first = (await ctxFromSession())!;
    const p1 = await createProject(first, { name: "one" });
    const p2 = await createProject(first, { name: "two" });
    const ctx = await sessionCtx(owner);
    await seed(owner, p1.id, [{ trace: "shared-id", parent: null, name: "p1-root", at: at(0) }]);
    await seed(owner, p2.id, [
      { trace: "shared-id", parent: null, name: "p2-root", at: at(1_000) },
      { trace: "shared-id", parent: "r", name: "p2-child", at: at(2_000) },
    ]);
    const r1 = (await list(ctx, p1.id)).items;
    const r2 = (await list(ctx, p2.id)).items;
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ rootName: "p1-root", spanCount: 1, startedAtMs: base });
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({ rootName: "p2-root", spanCount: 2, startedAtMs: base + 1_000 });
  });

  it("a cursor taken from project A, used on project B, only ever shows B's own traces", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ trace: "a1", at: at(2_000) }, { trace: "a2", at: at(1_000) }]);
    await seed(b.owner, b.projectId, [{ trace: "b1", at: at(1_500) }]);
    const pageA = await list(a.ctx, a.projectId, { limit: 1 });
    expect(pageA.nextCursor).not.toBeNull();
    const onB = await list(b.ctx, b.projectId, { cursor: pageA.nextCursor! });
    expect(onB.items.map((i) => i.traceId)).toEqual(["b1"]);
  });

  it("is read-only: listing changes no row", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "t", at: at(0) }]);
    const snapshot = () => raw(owner, [projectId], (t) => [t`select count(*)::int as n, max(received_at)::text as r from events where project_id = ${projectId}::uuid`]);
    const before = (await snapshot())[1]![0];
    await list(ctx, projectId);
    await list(ctx, projectId, { status: "error", limit: 1 });
    expect((await snapshot())[1]![0]).toEqual(before);
  });
});
