import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { ctxFromSession } from "@/lib/repo/ctx";
import { InvalidCursorError, NotFoundError } from "@/lib/repo/errors";
import { LIVE_LIMITS, LIVE_MAX_ID, decodeLiveCursor, encodeLiveCursor, getLiveSince, type LiveResult } from "@/lib/repo/live";
import { createProject, deleteProject } from "@/lib/repo/projects";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";
import { encodeCursor, traceListItemSchema } from "@/lib/repo/traces";
import { cleanupOwners } from "./helpers/cleanup";

/**
 * The live delta reader against the real database as app_rw, with Clerk mocked: the insertion-based cursor (a late event with an
 * old timestamp is still returned), strict no-gap / no-duplicate walking, the row cap, the reset, the empty path, the settle
 * horizon, cost rules, no content, and above all tenant isolation. Events are seeded through the same RLS-scoped door the app
 * uses. All times come from the DATABASE clock (`now() - offset`), so a skewed test machine cannot change the outcome. Skipped
 * without DATABASE_URL. Run alone with `npm run test:db:live`.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

const MIN = 60_000;
const HOUR = 3_600_000;

interface Ev {
  trace?: string | null;
  parent?: string | null;
  name?: string;
  model?: string | null;
  status?: "ok" | "error";
  input?: number | null;
  output?: number | null;
  /** micro-USD; omit for NULL (unpriced). */
  cost?: number | null;
  error?: string;
  /** The event's own timestamp, as milliseconds BEFORE the database now(). Default 0. */
  occurredAgoMs?: number;
  /** The insertion time, as milliseconds BEFORE the database now() (negative = in the future). Default 0 = the column default. */
  recvAgoMs?: number;
  id?: string;
}

run("live delta reader (database)", () => {
  const sql = neon(url!);
  const users: string[] = [];

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
    const project = await createProject(first, { name: "live" });
    const ctx = await sessionCtx(owner);
    return { owner, projectId: project.id, ctx };
  };
  const raw = (owner: string, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${ids.join(",")}, true)`,
      ...build(t),
    ]);
  /** ONE transaction, so every row shares the same now() (and the same default received_at). */
  const seed = (owner: string, pid: string, evs: Ev[]) =>
    raw(owner, [pid], (t) =>
      evs.map(
        (e) =>
          t`insert into events (id, event_id, project_id, trace_id, span_id, parent_id, kind, name, model, input_tokens, output_tokens, cost_usd, status, error, occurred_at, received_at)
            values (${e.id ?? randomUUID()}::uuid, ${randomUUID()}, ${pid}::uuid, ${e.trace === undefined ? randomUUID() : e.trace}, ${randomUUID()}, ${e.parent ?? null},
                    'llm', ${e.name ?? "step"}, ${e.model ?? null}, ${e.input ?? null}, ${e.output ?? null},
                    ${e.cost === undefined || e.cost === null ? null : e.cost / 1_000_000}, ${e.status ?? "ok"}, ${e.error ?? null},
                    now() - ${e.occurredAgoMs ?? 0}::int * interval '1 millisecond', now() - ${e.recvAgoMs ?? 0}::int * interval '1 millisecond')`,
      ),
    );
  /** Settle lag 0 by default (the horizon is then the database clock), so tests do not sleep. */
  const poll = (ctx: SessionCtx, pid: string, cursor?: string, o: Parameters<typeof getLiveSince>[3] = {}) =>
    getLiveSince(ctx, pid, cursor, { settleMs: 0, ...o });
  const failure = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return e as Error;
    }
    return null;
  };
  const dbNow = async () => {
    const [r] = await sql`select floor(extract(epoch from now()) * 1000)::bigint::text as ms, to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts`;
    return { ms: Number(r!.ms), ts: String(r!.ts) };
  };
  const msOf = (c: string) => {
    const t = decodeLiveCursor(c).receivedAt;
    return Date.parse(t.slice(0, 23) + "Z");
  };
  const ids = (r: LiveResult) => r.traces.map((t) => t.traceId).sort();

  beforeEach(() => {
    mockAuth.mockResolvedValue({ userId: null });
  });
  afterAll(async () => {
    await cleanupOwners(sql, users);
  });

  // ---- baseline, empty path, plain deltas ----

  it("the first call is a baseline: no history, no events, no traces, even when the project is full of events", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "old-1", recvAgoMs: 60_000 }, { trace: "old-2", recvAgoMs: 30_000 }, { trace: "old-3" }]);
    const r = await poll(ctx, projectId);
    expect(r).toMatchObject({ baseline: true, reset: false, truncated: false, newEvents: 0, newErrors: 0, newTraces: 0, traces: [] });
    expect(decodeLiveCursor(r.cursor).id).toBe(LIVE_MAX_ID);
    // Nothing from before the baseline is ever delivered afterwards either.
    const next = await poll(ctx, projectId, r.cursor);
    expect(next).toMatchObject({ baseline: false, newEvents: 0, traces: [] });
  });

  it("counts new events, errors and traces since the cursor, and the next call with the returned cursor sees nothing (no duplicate)", async () => {
    const { owner, projectId, ctx } = await tenant();
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [
      { trace: "t1", name: "root" },
      { trace: "t1", parent: "x", status: "error" },
      { trace: "t2" },
      { trace: null },
    ]);
    const r = await poll(ctx, projectId, base.cursor);
    expect(r).toMatchObject({ baseline: false, reset: false, truncated: false, newEvents: 4, newErrors: 1, newTraces: 2 });
    expect(ids(r)).toEqual(["t1", "t2"]);
    for (const t of r.traces) expect(traceListItemSchema.safeParse(t).success).toBe(true);
    const again = await poll(ctx, projectId, r.cursor);
    expect(again).toMatchObject({ newEvents: 0, newErrors: 0, newTraces: 0, traces: [] });
  });

  it("the empty path: zero counts, no traces, and the cursor moves forward (never back) so an idle client does not age out", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "t", recvAgoMs: 5_000 }]);
    const a = await poll(ctx, projectId);
    await new Promise((r) => setTimeout(r, 50));
    const b = await poll(ctx, projectId, a.cursor);
    const c = await poll(ctx, projectId, b.cursor);
    for (const r of [b, c]) expect(r).toMatchObject({ baseline: false, reset: false, truncated: false, newEvents: 0, newErrors: 0, newTraces: 0, traces: [] });
    expect(msOf(b.cursor)).toBeGreaterThanOrEqual(msOf(a.cursor));
    expect(msOf(c.cursor)).toBeGreaterThanOrEqual(msOf(b.cursor));
  });

  // ---- the cursor follows INSERTION, not the event's own timestamp ----

  it("a late-arriving event with an OLD timestamp is still returned (23 h in the past, inserted after the cursor was taken)", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "fresh-before" }]);
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [{ trace: "late-old", occurredAgoMs: 23 * HOUR }, { trace: "late-older", occurredAgoMs: 2 * HOUR, status: "error" }]);
    const r = await poll(ctx, projectId, base.cursor);
    expect(r).toMatchObject({ newEvents: 2, newErrors: 1, newTraces: 2 });
    expect(ids(r)).toEqual(["late-old", "late-older"]);
    // and it is delivered once only
    expect((await poll(ctx, projectId, r.cursor)).newEvents).toBe(0);
  });

  it("an event whose own timestamp is in the FUTURE (within the ingest window) is delivered when it is inserted, not when its time comes", async () => {
    const { owner, projectId, ctx } = await tenant();
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [{ trace: "future", occurredAgoMs: -20 * HOUR }]);
    const r = await poll(ctx, projectId, base.cursor);
    expect(ids(r)).toEqual(["future"]);
  });

  // ---- strict pagination: no gap, no duplicate ----

  it("two consecutive polls with inserts in between: the union is exactly everything, with no gap and no repeat", async () => {
    const { owner, projectId, ctx } = await tenant();
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [{ trace: "a" }, { trace: "b" }]);
    const first = await poll(ctx, projectId, base.cursor);
    await seed(owner, projectId, [{ trace: "c" }, { trace: "d" }]);
    const second = await poll(ctx, projectId, first.cursor);
    expect(ids(first)).toEqual(["a", "b"]);
    expect(ids(second)).toEqual(["c", "d"]);
    expect(first.newEvents + second.newEvents).toBe(4);
    const third = await poll(ctx, projectId, second.cursor);
    expect(third.newEvents).toBe(0);
  });

  it("the SAME cursor used twice gives the same answer except the cursor, which only moves forward; either cursor continues with no gap or repeat", async () => {
    const { owner, projectId, ctx } = await tenant();
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [{ trace: "x" }, { trace: "y", status: "error" }]);
    const one = await poll(ctx, projectId, base.cursor);
    await new Promise((r) => setTimeout(r, 30)); // the horizon follows the clock, so the second cursor may be later
    const two = await poll(ctx, projectId, base.cursor);
    // Not the same cursor by design: a non-truncated answer moves the cursor to the settle horizon.
    const { cursor: c1, ...rest1 } = one;
    const { cursor: c2, ...rest2 } = two;
    expect(rest2).toEqual(rest1);
    expect(rest1).toMatchObject({ newEvents: 2, newErrors: 1, newTraces: 2 });
    expect(decodeLiveCursor(c1).id).toBe(LIVE_MAX_ID);
    expect(decodeLiveCursor(c2).id).toBe(LIVE_MAX_ID);
    expect(msOf(c2)).toBeGreaterThanOrEqual(msOf(c1));
    // One new row after both polls: it is returned exactly once from EITHER cursor, and the old rows are not repeated.
    await seed(owner, projectId, [{ trace: "after" }]);
    for (const c of [c1, c2]) {
      const next = await poll(ctx, projectId, c);
      expect(next).toMatchObject({ newEvents: 1, newErrors: 0, newTraces: 1, truncated: false });
      expect(ids(next)).toEqual(["after"]);
      expect((await poll(ctx, projectId, next.cursor)).newEvents).toBe(0);
    }
  });

  it("rows inserted in ONE transaction share a received_at: the id tie-break still walks them one page at a time with no gap or repeat", async () => {
    const { owner, projectId, ctx } = await tenant();
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, ["t0", "t1", "t2", "t3", "t4"].map((trace) => ({ trace })));
    const [, same] = await raw(owner, [projectId], (t) => [t`select count(distinct received_at)::int as n from events where project_id = ${projectId}::uuid`]);
    expect(same![0]!.n).toBe(1);
    const seen: string[] = [];
    let cursor = base.cursor;
    let pages = 0;
    const truncatedFlags: boolean[] = [];
    for (; pages < 10; pages++) {
      const r = await poll(ctx, projectId, cursor, { scanCap: 2 });
      truncatedFlags.push(r.truncated);
      seen.push(...ids(r));
      expect(r.newEvents).toBeLessThanOrEqual(2);
      cursor = r.cursor;
      if (!r.truncated) break;
    }
    expect(seen.sort()).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(truncatedFlags).toEqual([true, true, false]);
  });

  it("truncation: the cap is reported, the cursor stops at the last row counted, and walking on delivers the rest exactly once", async () => {
    const { owner, projectId, ctx } = await tenant();
    // The rows are back-dated by up to 7 s, so the starting cursor must be older than all of them (a baseline taken now would be newer).
    const base = { cursor: encodeLiveCursor({ receivedAt: new Date((await dbNow()).ms - 30_000).toISOString().replace("Z", "000Z"), id: LIVE_MAX_ID }) };
    // seven rows at DIFFERENT insertion times, oldest first
    for (let i = 0; i < 7; i++) await seed(owner, projectId, [{ trace: `r${i}`, recvAgoMs: (7 - i) * 1_000 }]);
    const p1 = await poll(ctx, projectId, base.cursor, { scanCap: 3 });
    expect(p1).toMatchObject({ truncated: true, newEvents: 3 });
    expect(ids(p1)).toEqual(["r0", "r1", "r2"]);
    expect(decodeLiveCursor(p1.cursor).id).not.toBe(LIVE_MAX_ID); // the last row counted, not the horizon
    const p2 = await poll(ctx, projectId, p1.cursor, { scanCap: 3 });
    expect(p2).toMatchObject({ truncated: true, newEvents: 3 });
    expect(ids(p2)).toEqual(["r3", "r4", "r5"]);
    const p3 = await poll(ctx, projectId, p2.cursor, { scanCap: 3 });
    expect(p3).toMatchObject({ truncated: false, newEvents: 1 });
    expect(ids(p3)).toEqual(["r6"]);
    expect(decodeLiveCursor(p3.cursor).id).toBe(LIVE_MAX_ID);
  });

  it("exactly at the cap is NOT truncated (cap+1 rows are what prove 'more')", async () => {
    const { owner, projectId, ctx } = await tenant();
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [{ trace: "a" }, { trace: "b" }, { trace: "c" }]);
    const r = await poll(ctx, projectId, base.cursor, { scanCap: 3 });
    expect(r).toMatchObject({ truncated: false, newEvents: 3 });
  });

  // ---- reset and invalid cursors ----

  it("a cursor older than the lookback is a RESET: a fresh baseline, reset true, and the history after it is not downloaded", async () => {
    const { owner, projectId, ctx } = await tenant();
    const now = await dbNow();
    const old = encodeLiveCursor({ receivedAt: new Date(now.ms - LIVE_LIMITS.lookbackMs - 5 * MIN).toISOString().replace("Z", "000Z"), id: LIVE_MAX_ID });
    await seed(owner, projectId, [{ trace: "after-old-cursor-1", recvAgoMs: 2 * MIN }, { trace: "after-old-cursor-2" }]);
    const r = await poll(ctx, projectId, old);
    expect(r).toMatchObject({ baseline: true, reset: true, truncated: false, newEvents: 0, newErrors: 0, newTraces: 0, traces: [] });
    expect(msOf(r.cursor)).toBeGreaterThan(now.ms - 60_000);
    // after the reset the client is in sync again
    expect((await poll(ctx, projectId, r.cursor)).baseline).toBe(false);
  });

  it("a cursor from the future, a trace cursor and garbage are InvalidCursorError; a project that is not yours stays NotFound", async () => {
    const a = await tenant();
    const b = await tenant();
    const now = await dbNow();
    const future = encodeLiveCursor({ receivedAt: new Date(now.ms + 10 * MIN).toISOString().replace("Z", "000Z"), id: LIVE_MAX_ID });
    for (const bad of [future, "garbage", "", encodeCursor({ start: now.ts, traceId: "x" })]) {
      expect(await failure(() => poll(a.ctx, a.projectId, bad))).toBeInstanceOf(InvalidCursorError);
      expect(await failure(() => poll(b.ctx, a.projectId, bad))).toBeInstanceOf(NotFoundError);
    }
  });

  // ---- the settle horizon ----

  it("the cursor never passes now() minus the settle lag, and a row inserted after the horizon is never skipped", async () => {
    const { owner, projectId, ctx } = await tenant();
    const a = await getLiveSince(ctx, projectId, undefined); // default settle lag
    const after = await dbNow();
    expect(msOf(a.cursor)).toBeLessThanOrEqual(after.ms - LIVE_LIMITS.settleMs);
    await seed(owner, projectId, [{ trace: "just-after" }]);
    await new Promise((r) => setTimeout(r, LIVE_LIMITS.settleMs + 400));
    const r = await getLiveSince(ctx, projectId, a.cursor);
    expect(ids(r)).toEqual(["just-after"]);
    expect(msOf(r.cursor)).toBeLessThanOrEqual((await dbNow()).ms - LIVE_LIMITS.settleMs);
    expect((await getLiveSince(ctx, projectId, r.cursor)).newEvents).toBe(0);
  });

  it("a row whose insertion time is still beyond the horizon is not delivered, and is delivered later (not lost)", async () => {
    const { owner, projectId, ctx } = await tenant();
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [{ trace: "not-yet", recvAgoMs: -3_000 }]); // received_at = now() + 3 s
    const early = await poll(ctx, projectId, base.cursor);
    expect(early.newEvents).toBe(0);
    await new Promise((r) => setTimeout(r, 3_500));
    const later = await poll(ctx, projectId, early.cursor);
    expect(ids(later)).toEqual(["not-yet"]);
  });

  // ---- trace summaries ----

  it("trace summaries cover the WHOLE trace, newest start first, and at most the configured few (the counts are not capped)", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "t0", name: "agent.run", occurredAgoMs: 40_000, recvAgoMs: 40_000 }]); // before the cursor
    const base = await poll(ctx, projectId);
    const evs: Ev[] = [{ trace: "t0", parent: "root", name: "tool", occurredAgoMs: 100 }];
    for (let i = 1; i < 8; i++) evs.push({ trace: `t${i}`, occurredAgoMs: (8 - i) * 100 });
    await seed(owner, projectId, evs);
    const r = await poll(ctx, projectId, base.cursor);
    expect(r.newEvents).toBe(8);
    expect(r.newTraces).toBe(8);
    expect(r.traces).toHaveLength(LIVE_LIMITS.recentTraces);
    const starts = r.traces.map((t) => t.startedAtMs);
    expect([...starts].sort((x, y) => y - x)).toEqual(starts);
    // All eight rows share one insertion time, so the "newest" few are picked by trace id descending: t7..t3 (t0 is cut).
    expect(ids(r)).toEqual(["t3", "t4", "t5", "t6", "t7"]);
  });

  it("a trace that got one new event is summarised with its older events too", async () => {
    const { owner, projectId, ctx } = await tenant();
    await seed(owner, projectId, [{ trace: "long", name: "agent.run", input: 10, output: 5, recvAgoMs: 30_000, occurredAgoMs: 30_000 }]);
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [{ trace: "long", parent: "p", input: 1, output: 1, status: "error" }]);
    const r = await poll(ctx, projectId, base.cursor);
    expect(r.newEvents).toBe(1);
    expect(r.traces).toHaveLength(1);
    expect(r.traces[0]).toMatchObject({ traceId: "long", spanCount: 2, errorCount: 1, totalTokens: 17 });
  });

  it("cost is never invented: unknown = null, partial = a lower bound, nothing to price = a real 0, free model = 0", async () => {
    const { owner, projectId, ctx } = await tenant();
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [
      { trace: "unknown", model: "mystery-7b" },
      { trace: "partial", model: "priced-1", cost: 1_500 },
      { trace: "partial", model: "mystery-7b" },
      { trace: "tools", model: null },
      { trace: "free", model: "free-1", cost: 0 },
      { trace: "full", model: "priced-1", cost: 2_500 },
    ]);
    const by = new Map((await poll(ctx, projectId, base.cursor)).traces.map((t) => [t.traceId, t]));
    expect(by.get("unknown")).toMatchObject({ costMicro: null, costLowerBound: true, unpricedEvents: 1 });
    expect(by.get("partial")).toMatchObject({ costMicro: 1_500, costLowerBound: true, unpricedEvents: 1 });
    expect(by.get("tools")).toMatchObject({ costMicro: 0, costLowerBound: false });
    expect(by.get("free")).toMatchObject({ costMicro: 0, costLowerBound: false });
    expect(by.get("full")).toMatchObject({ costMicro: 2_500, costLowerBound: false });
  });

  it("events without a trace id count as events but not as traces and appear in no summary", async () => {
    const { owner, projectId, ctx } = await tenant();
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [{ trace: null }, { trace: null, status: "error" }, { trace: "one" }]);
    const r = await poll(ctx, projectId, base.cursor);
    expect(r).toMatchObject({ newEvents: 3, newErrors: 1, newTraces: 1 });
    expect(ids(r)).toEqual(["one"]);
  });

  // ---- content never ----

  it("never returns text from event_content or the error column, and the result has exactly the documented fields", async () => {
    const { owner, projectId, ctx } = await tenant();
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [{ trace: "t", status: "error", error: "SECRET-ERROR-TEXT" }]);
    const [, ev] = await raw(owner, [projectId], (t) => [t`select event_id from events where project_id = ${projectId}::uuid`]);
    await raw(owner, [projectId], (t) => [
      t`insert into event_content (event_id, project_id, input_text, output_text, expires_at) values (${ev![0]!.event_id}, ${projectId}::uuid, 'SECRET-PROMPT', 'SECRET-RESPONSE', now() + interval '1 day')`,
    ]);
    const r = await poll(ctx, projectId, base.cursor);
    expect(r.newEvents).toBe(1);
    const json = JSON.stringify(r);
    for (const s of ["SECRET-ERROR-TEXT", "SECRET-PROMPT", "SECRET-RESPONSE"]) expect(json).not.toContain(s);
    expect(Object.keys(r).sort()).toEqual(["baseline", "cursor", "newErrors", "newEvents", "newTraces", "reset", "traces", "truncated"]);
    expect(Object.keys(r.traces[0]!).sort()).toEqual(Object.keys(traceListItemSchema.shape).sort());
  });

  // ---- tenant isolation ----

  it("IDOR: user B can never poll project A, with any cursor or option", async () => {
    const a = await tenant();
    const b = await tenant();
    const base = await poll(a.ctx, a.projectId);
    await seed(a.owner, a.projectId, [{ trace: "a-secret-trace" }]);
    const attempts = [
      failure(() => poll(b.ctx, a.projectId)),
      failure(() => poll(b.ctx, a.projectId, base.cursor)),
      failure(() => poll(b.ctx, a.projectId, base.cursor, { scanCap: 1000 })),
    ];
    for (const e of await Promise.all(attempts)) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect(e!.message).toBe("not found");
    }
    expect(ids(await poll(a.ctx, a.projectId, base.cursor))).toEqual(["a-secret-trace"]);
    expect(JSON.stringify(await poll(b.ctx, b.projectId, base.cursor))).not.toContain("a-secret-trace");
  });

  it("a wrong project id gives the SAME answer as a missing one, a malformed one and a deleted one", async () => {
    const a = await tenant();
    const b = await tenant();
    const gone = await createProject(await sessionCtx(b.owner), { name: "gone" });
    const bCtx = await sessionCtx(b.owner);
    await deleteProject(bCtx, gone.id);
    const attempts = await Promise.all([
      failure(() => poll(b.ctx, a.projectId)),
      failure(() => poll(b.ctx, randomUUID())),
      failure(() => poll(b.ctx, "not-a-uuid")),
      failure(() => poll(bCtx, gone.id)),
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
    await seed(a.owner, a.projectId, [{ trace: "a-trace" }]);
    const forged = issueCtx<SessionCtx>({ kind: "session", ownerId: b.owner, projectIds: [b.projectId, a.projectId], readOnly: false });
    expect(await failure(() => poll(forged, a.projectId))).toBeInstanceOf(NotFoundError);
  });

  it("RLS under the reader: another tenant's events are invisible even to a raw statement ordered by received_at", async () => {
    const a = await tenant();
    const b = await tenant();
    await seed(a.owner, a.projectId, [{ trace: "a-trace" }]);
    const [, n] = await raw(b.owner, [b.projectId], (t) => [
      t`select count(*)::int as n from events where project_id = ${a.projectId}::uuid and received_at > now() - interval '1 hour'`,
    ]);
    expect(n![0]!.n).toBe(0);
  });

  it("one owner's two projects never leak into each other, even with the SAME trace id", async () => {
    const owner = await asUser();
    mockAuth.mockResolvedValue({ userId: owner });
    const first = (await ctxFromSession())!;
    const p1 = await createProject(first, { name: "one" });
    const p2 = await createProject(first, { name: "two" });
    const ctx = await sessionCtx(owner);
    const b1 = await poll(ctx, p1.id);
    const b2 = await poll(ctx, p2.id);
    await seed(owner, p1.id, [{ trace: "shared-id", name: "in-one" }]);
    await seed(owner, p2.id, [{ trace: "shared-id", name: "in-two" }, { trace: "shared-id", parent: "x" }]);
    const r1 = await poll(ctx, p1.id, b1.cursor);
    const r2 = await poll(ctx, p2.id, b2.cursor);
    expect(r1).toMatchObject({ newEvents: 1, newTraces: 1 });
    expect(r1.traces[0]).toMatchObject({ spanCount: 1, rootName: "in-one" });
    expect(r2).toMatchObject({ newEvents: 2, newTraces: 1 });
    expect(r2.traces[0]).toMatchObject({ spanCount: 2, rootName: "in-two" });
  });

  it("a cursor taken from project A, used on project B, only ever shows B's own rows", async () => {
    const a = await tenant();
    const b = await tenant();
    const baseA = await poll(a.ctx, a.projectId);
    await seed(a.owner, a.projectId, [{ trace: "a1" }]);
    await seed(b.owner, b.projectId, [{ trace: "b1" }]);
    const onB = await poll(b.ctx, b.projectId, baseA.cursor);
    expect(ids(onB)).toEqual(["b1"]);
  });

  it("is read-only: polling changes no row", async () => {
    const { owner, projectId, ctx } = await tenant();
    const base = await poll(ctx, projectId);
    await seed(owner, projectId, [{ trace: "t" }]);
    const snapshot = () => raw(owner, [projectId], (t) => [t`select count(*)::int as n, max(received_at)::text as r from events where project_id = ${projectId}::uuid`]);
    const before = (await snapshot())[1]![0];
    await poll(ctx, projectId, base.cursor);
    await poll(ctx, projectId);
    expect((await snapshot())[1]![0]).toEqual(before);
  });

  // ---- the index (migration 0013) ----

  it("migration 0013: the parent and EVERY current events partition have an index on (project_id, received_at, id); partitions created later inherit the parent's", async () => {
    const rows = await sql`
      select c.relname as tbl, i.indexrelid::regclass::text as idx, pg_get_indexdef(i.indexrelid) as def, i.indisvalid as valid
        from pg_class c
        join pg_index i on i.indrelid = c.oid
       where (c.relname = 'events' or c.relname ~ '^events_y[0-9]{4}m[0-9]{2}$')
         and pg_get_indexdef(i.indexrelid) ~ '\\(project_id, received_at, id\\)$'`;
    const [parts] = await sql`select count(*)::int as n from pg_inherits where inhparent = 'public.events'::regclass`;
    const by = new Set(rows.map((r) => String(r.tbl)));
    expect(by.has("events")).toBe(true);
    expect(by.size).toBe(Number(parts!.n) + 1); // the parent plus every partition
    for (const r of rows) expect(r.valid).toBe(true);
    // a partition that exists later is created by CREATE TABLE ... PARTITION OF, which attaches the parent's indexes by itself:
    // the parent index being partitioned (relkind 'I') is what guarantees it
    const [kind] = await sql`select relkind from pg_class where relname = 'events_project_received_idx'`;
    expect(kind!.relkind).toBe("I");
  });
});
