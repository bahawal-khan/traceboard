import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { PgEventStore } from "@/lib/events/pg-store";
import { MissingPartitionError } from "@/lib/events/store";
import type { NormalizedEvent } from "@/lib/ingest/normalize";
import { createApiKey } from "@/lib/repo/api-keys";
import { ctxFromApiKey, ctxFromSession } from "@/lib/repo/ctx";
import { createProject } from "@/lib/repo/projects";
import { withTenant } from "@/lib/repo/tenant";

/** persistEvents (events insert + dedupe) against the real database as app_rw. Skipped without DATABASE_URL. */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

run("PgEventStore (database)", () => {
  const sql = neon(url!);
  const store = new PgEventStore();
  const users: string[] = [];
  const raw = (owner: string, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${ids.join(",")}, true)`,
      ...build(t),
    ]);

  /** A user, a project and an ingest key; returns the key's context. */
  const tenant = async (scopes: string[] = ["ingest"]) => {
    const owner = `test_${randomUUID()}`;
    users.push(owner);
    await sql`select claim_user_slot(${owner}, 100000)`;
    mockAuth.mockResolvedValue({ userId: owner });
    const project = await createProject((await ctxFromSession())!, { name: "store-test" });
    const { secret } = await createApiKey((await ctxFromSession())!, project.id, { scopes });
    return { owner, project: project.id, ctx: (await ctxFromApiKey(secret))! };
  };
  const base = Date.now() - 3600_000;
  const ev = (o: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
    eventId: randomUUID(),
    occurredAt: new Date(base),
    traceId: null, spanId: null, parentId: null, threadId: null, kind: "llm", name: null, model: null, provider: null,
    inputTokens: null, outputTokens: null, cachedTokens: null, latencyMs: null, ttftMs: null, costMicro: null, costUsd: null,
    status: "ok", error: null, promptHash: null, argsHash: null, userIdHash: null, tags: null, content: null,
    ...o,
  });
  const count = async (t: { owner: string; project: string }, where = "true") => {
    const [, rows] = await raw(t.owner, [t.project], (q) => [q.query(`select count(*)::int as n from events where ${where}`)]);
    return rows[0].n as number;
  };

  beforeAll(async () => {
    await sql`select ensure_event_partitions((date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date, 5)`;
  });
  afterAll(async () => {
    for (const u of users) await raw(u, [], (t) => [t`delete from projects where owner_id = ${u}`, t`select release_user_slot()`]);
  });

  it("inserts a batch and stores every field with the right type", async () => {
    const a = await tenant();
    const e = ev({
      traceId: "tr1", spanId: "sp1", parentId: "sp0", threadId: "th1", kind: "tool", name: "search", model: "gpt-4o", provider: "openai",
      inputTokens: 100, outputTokens: 20, cachedTokens: 40, latencyMs: 1234, ttftMs: 120, costMicro: 5860, costUsd: "0.005860",
      status: "error", error: "boom", promptHash: "a".repeat(64), argsHash: "b".repeat(64), userIdHash: "c".repeat(64), tags: ["x", "y"],
    });
    const plain = ev();
    expect((await store.persist(a.ctx, [e, plain])).inserted).toBe(2);
    const [, rows] = await raw(a.owner, [a.project], (t) => [t`select * from events where event_id = ${e.eventId}`]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: a.project, trace_id: "tr1", span_id: "sp1", parent_id: "sp0", thread_id: "th1", kind: "tool", name: "search",
      model: "gpt-4o", provider: "openai", input_tokens: 100, output_tokens: 20, cached_tokens: 40, latency_ms: 1234, ttft_ms: 120,
      cost_usd: "0.005860", status: "error", error: "boom", tags: ["x", "y"],
    });
    expect(new Date(rows[0].occurred_at).toISOString()).toBe(e.occurredAt.toISOString());
    const [, p] = await raw(a.owner, [a.project], (t) => [t`select cost_usd, tags, input_tokens, trace_id from events where event_id = ${plain.eventId}`]);
    expect(p[0]).toEqual({ cost_usd: null, tags: null, input_tokens: null, trace_id: null }); // unknown stays NULL, never 0
  });

  it("a duplicate batch inserts once", async () => {
    const a = await tenant();
    const batch = [ev(), ev(), ev()];
    expect((await store.persist(a.ctx, batch)).inserted).toBe(3);
    expect((await store.persist(a.ctx, batch)).inserted).toBe(0);
    expect(await count(a)).toBe(3);
  });

  it("a partly duplicate batch inserts only the new events", async () => {
    const a = await tenant();
    const old = [ev(), ev()];
    await store.persist(a.ctx, old);
    expect((await store.persist(a.ctx, [old[0]!, ev(), old[1]!, ev()])).inserted).toBe(2);
    expect(await count(a)).toBe(4);
  });

  it("the same event twice inside ONE batch inserts once and does not error", async () => {
    const a = await tenant();
    const e = ev();
    expect((await store.persist(a.ctx, [e, e, { ...e }])).inserted).toBe(1);
    expect(await count(a)).toBe(1);
  });

  it("the dedupe key includes occurred_at: the same event_id at another ts is a different row (the SDK must keep ts stable)", async () => {
    const a = await tenant();
    const id = randomUUID();
    await store.persist(a.ctx, [ev({ eventId: id }), ev({ eventId: id, occurredAt: new Date(base + 1000) })]);
    expect(await count(a, `event_id = '${id}'`)).toBe(2);
  });

  it("IDOR: the same event_id and ts in two projects are two independent rows, each visible only to its own tenant", async () => {
    const a = await tenant();
    const b = await tenant();
    const shared = ev();
    expect((await store.persist(a.ctx, [shared])).inserted).toBe(1);
    expect((await store.persist(b.ctx, [shared])).inserted).toBe(1); // A's row does not make B's a "duplicate"
    expect(await count(a)).toBe(1);
    expect(await count(b)).toBe(1);
    const [, seenByA] = await raw(a.owner, [a.project], (t) => [t`select distinct project_id from events`]);
    expect(seenByA).toEqual([{ project_id: a.project }]);
    const [, aScopedForB] = await raw(a.owner, [a.project], (t) => [t`select count(*)::int as n from events where project_id = ${b.project}`]);
    expect(aScopedForB[0].n).toBe(0);
  });

  it("RLS: a key context for A cannot write an event for B's project even with hand-written SQL", async () => {
    const a = await tenant();
    const b = await tenant();
    await expect(
      withTenant(a.ctx, (t) => [t`insert into events (event_id, project_id, occurred_at) values (${randomUUID()}, ${b.project}, now())`]),
    ).rejects.toThrow(/row-level security/i);
    expect(await count(b)).toBe(0);
  });

  it("a key without the ingest scope cannot persist anything", async () => {
    const a = await tenant(["eval"]);
    await expect(store.persist(a.ctx, [ev()])).rejects.toThrow(/ingest scope/);
    expect(await count(a)).toBe(0);
  });

  it("an event with no partition raises MissingPartitionError and the whole batch is rolled back", async () => {
    const a = await tenant();
    await expect(store.persist(a.ctx, [ev(), ev({ occurredAt: new Date("2001-01-01T00:00:00Z") })])).rejects.toBeInstanceOf(MissingPartitionError);
    expect(await count(a)).toBe(0);
  });

  it("accepts a full 100-event batch in one call", async () => {
    const a = await tenant();
    const batch = Array.from({ length: 100 }, (_, i) => ev({ occurredAt: new Date(base + i), name: `n${i}` }));
    expect((await store.persist(a.ctx, batch)).inserted).toBe(100);
    expect(await count(a)).toBe(100);
  });
});
