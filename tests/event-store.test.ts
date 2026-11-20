import { NeonDbError } from "@neondatabase/serverless";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getSql: () => ({ transaction: mocks.transaction }) }));

import { isRetryableTxError, PgEventStore } from "@/lib/events/pg-store";
import { isMissingPartitionError, MissingPartitionError } from "@/lib/events/store";
import type { NormalizedEvent } from "@/lib/ingest/normalize";
import { issueCtx, TenantError, type ApiKeyCtx } from "@/lib/repo/tenant";

const PID = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ctx = (scopes = ["ingest"], projectIds = [PID]) =>
  issueCtx<ApiKeyCtx>({ kind: "apiKey", ownerId: null, projectIds, keyId: "22222222-2222-4222-8222-222222222222", scopes, readOnly: false });

const ev = (o: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  eventId: "3f0c1b2e-8a64-4d1f-9c7e-5b2a6d9e1f40",
  occurredAt: new Date("2026-11-20T11:59:00Z"),
  traceId: null, spanId: null, parentId: null, threadId: null, kind: "llm", name: null, model: null, provider: null,
  inputTokens: null, outputTokens: null, cachedTokens: null, latencyMs: null, ttftMs: null, costMicro: null, costUsd: null,
  status: "ok", error: null, promptHash: null, argsHash: null, userIdHash: null, tags: null, content: null,
  ...o,
});

const RESULT = {
  inserted: 3,
  usage: { events: 10, requests: 2, cost_micro: 500 },
  budgets: [{ budget_id: "44444444-4444-4444-8444-444444444444", scope: "project", period: "day", limit_usd: "5", action: "block", period_key: "2026-11-20", spent_micro: 123456 }],
};

type Stmt = { text: string; values: unknown[] };
let seen: Stmt[];
beforeEach(() => {
  seen = [];
  mocks.transaction.mockReset();
  mocks.transaction.mockImplementation(async (build: (t: (s: TemplateStringsArray, ...v: unknown[]) => Stmt) => Stmt[]) => {
    const t = (s: TemplateStringsArray, ...values: unknown[]) => ({ text: s.join("?"), values });
    seen = build(t);
    return seen.map((_, i) => (i === 0 ? [] : [RESULT]));
  });
});

describe("PgEventStore (statement shape; no database)", () => {
  it("runs one static statement under the key's own project scope and returns the inserted count", async () => {
    const r = await new PgEventStore().persist(ctx(), [ev(), ev({ eventId: "3f0c1b2e-8a64-4d1f-9c7e-5b2a6d9e1f41" })]);
    expect(r).toEqual({
      inserted: 3,
      usage: { events: 10, requests: 2, costMicro: 500 },
      budgets: [{ budgetId: "44444444-4444-4444-8444-444444444444", scope: "project", period: "day", limitUsd: "5", action: "block", periodKey: "2026-11-20", spentMicro: 123456 }],
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1); // one round trip
    expect(seen).toHaveLength(2); // set_config + the insert
    expect(seen[0]!.values).toContain(PID);
    const insert = seen[1]!;
    expect(insert.text).toContain("on conflict (project_id, event_id, occurred_at) do nothing");
    expect(insert.text).not.toContain("3f0c1b2e"); // data never appears in the SQL text
  });

  it("takes project_id from the context, never from the rows", async () => {
    // Even a row smuggling a foreign project id in any field cannot change the project parameter.
    const sneaky = { ...ev(), projectId: OTHER, project_id: OTHER } as unknown as NormalizedEvent;
    await new PgEventStore().persist(ctx(), [sneaky]);
    const insert = seen[1]!;
    expect(insert.values[0]).toBe(PID);
    const payload = JSON.parse(insert.values[1] as string) as Array<Record<string, unknown>>;
    expect(JSON.stringify(payload)).not.toContain(OTHER); // the wire form lists columns explicitly
    expect(payload[0]).not.toHaveProperty("project_id");
  });

  it("sends the rows as one JSON parameter with ISO timestamps", async () => {
    await new PgEventStore().persist(ctx(), [ev({ model: "m", inputTokens: 5, costUsd: "0.000001", tags: ["a"] })]);
    const payload = JSON.parse(seen[1]!.values[1] as string) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ model: "m", input_tokens: 5, cost_usd: "0.000001", tags: ["a"], occurred_at: "2026-11-20T11:59:00.000Z", status: "ok", kind: "llm" });
  });

  it("does not touch the database for an empty batch", async () => {
    expect(await new PgEventStore().persist(ctx(), [])).toEqual({ inserted: 0, usage: null, budgets: [] });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses a key without the ingest scope, and any context that is not exactly one project, before the database", async () => {
    await expect(new PgEventStore().persist(ctx(["eval"]), [ev()])).rejects.toBeInstanceOf(TenantError);
    await expect(new PgEventStore().persist(ctx(["ingest"], [PID, OTHER]), [ev()])).rejects.toBeInstanceOf(TenantError);
    await expect(new PgEventStore().persist(ctx(["ingest"], []), [ev()])).rejects.toBeInstanceOf(TenantError);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("computes every rollup from the insert's RETURNING rows (`ins`), never from the request batch", async () => {
    await new PgEventStore().persist(ctx(), [ev()]);
    const text = seen[1]!.text;
    // The only place rows are read from the request payload is the insert itself.
    expect(text.match(/jsonb_to_recordset/g)).toHaveLength(1);
    expect(text).toMatch(/returning occurred_at, trace_id, model, status/);
    expect(text).toMatch(/from ins\s*\)/); // ev is built from ins
    for (const cte of ["metrics_minute", "metrics_hourly"]) expect(text).toContain(`insert into ${cte}`);
    expect(text).toContain("insert into usage_daily");
    expect(text).toContain("insert into budget_usage");
  });

  it("passes the latency bounds and a valid shard as parameters; rejects an out-of-range shard before the database", async () => {
    await new PgEventStore({ pickShard: () => 5 }).persist(ctx(), [ev()]);
    const values = seen[1]!.values;
    expect(values).toContainEqual([50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200]);
    expect(values).toContain(5);
    mocks.transaction.mockClear();
    for (const bad of [-1, 8, 1.5, NaN]) await expect(new PgEventStore({ pickShard: () => bad }).persist(ctx(), [ev()])).rejects.toThrow(/shard/);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("maps a missing-partition error to MissingPartitionError and passes other errors through", async () => {
    const missing = Object.assign(new NeonDbError('no partition of relation "events" found for row'), { code: "23514" });
    mocks.transaction.mockRejectedValueOnce(missing);
    await expect(new PgEventStore().persist(ctx(), [ev()])).rejects.toBeInstanceOf(MissingPartitionError);
    const other = Object.assign(new NeonDbError("permission denied"), { code: "42501" });
    mocks.transaction.mockRejectedValueOnce(other);
    await expect(new PgEventStore().persist(ctx(), [ev()])).rejects.toBe(other);
  });
});

describe("isMissingPartitionError", () => {
  it("matches only SQLSTATE 23514 with the partition message", () => {
    expect(isMissingPartitionError(Object.assign(new Error('no partition of relation "events" found for row'), { code: "23514" }))).toBe(true);
    expect(isMissingPartitionError(Object.assign(new Error("new row violates check constraint"), { code: "23514" }))).toBe(false);
    expect(isMissingPartitionError(Object.assign(new Error("no partition of relation"), { code: "42501" }))).toBe(false);
    for (const v of [null, undefined, "no partition of relation", 5, {}]) expect(isMissingPartitionError(v)).toBe(false);
  });
});

describe("deadlock / serialization retry", () => {
  const dbErr = (code: string, message = "boom") => Object.assign(new NeonDbError(message), { code });
  const okRows = (build: (t: (s: TemplateStringsArray, ...v: unknown[]) => Stmt) => Stmt[]) => {
    const t = (s: TemplateStringsArray, ...values: unknown[]) => ({ text: s.join("?"), values });
    return build(t).map((_, i) => (i === 0 ? [] : [RESULT]));
  };
  const store = (sleep = vi.fn(async () => {})) => ({ sleep, store: new PgEventStore({ sleep, retryDelayMs: () => 77 }) });

  it("recognises only SQLSTATE 40P01 and 40001", () => {
    expect(isRetryableTxError(dbErr("40P01"))).toBe(true);
    expect(isRetryableTxError(dbErr("40001"))).toBe(true);
    for (const c of ["23505", "23514", "42501", "57014", "40002", "08006"]) expect(isRetryableTxError(dbErr(c)), c).toBe(false);
    for (const v of [null, undefined, "40P01", 40001, new Error("deadlock detected"), {}]) expect(isRetryableTxError(v)).toBe(false);
  });

  it.each(["40P01", "40001"])("retries once on %s and returns the second result", async (code) => {
    mocks.transaction.mockReset();
    mocks.transaction.mockRejectedValueOnce(dbErr(code, "deadlock detected")).mockImplementationOnce(async (b) => okRows(b));
    const { store: s, sleep } = store();
    const r = await s.persist(ctx(), [ev()]);
    expect(r.inserted).toBe(3);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(77);
  });

  it("the retry sends the identical statement and parameters (the rolled-back attempt left nothing behind)", async () => {
    const calls: Stmt[][] = [];
    mocks.transaction.mockReset();
    mocks.transaction.mockImplementation(async (b: (t: (s: TemplateStringsArray, ...v: unknown[]) => Stmt) => Stmt[]) => {
      const t = (s: TemplateStringsArray, ...values: unknown[]) => ({ text: s.join("?"), values });
      calls.push(b(t));
      if (calls.length === 1) throw dbErr("40P01");
      return calls[1]!.map((_, i) => (i === 0 ? [] : [RESULT]));
    });
    await new PgEventStore({ sleep: async () => {}, pickShard: () => 4 }).persist(ctx(), [ev()]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it("waits 50 to 150 ms by default", async () => {
    const waits: number[] = [];
    const rnd = vi.spyOn(Math, "random");
    try {
      for (const r of [0, 0.5, 0.999999]) {
        rnd.mockReturnValue(r);
        mocks.transaction.mockReset();
        mocks.transaction.mockRejectedValueOnce(dbErr("40P01")).mockImplementationOnce(async (b) => okRows(b));
        await new PgEventStore({ sleep: async (ms) => void waits.push(ms), pickShard: () => 0 }).persist(ctx(), [ev()]);
      }
    } finally {
      rnd.mockRestore();
    }
    expect(waits[0]).toBe(50);
    expect(waits[1]).toBe(100);
    expect(waits[2]).toBeGreaterThan(149.9);
    expect(waits.every((w) => w >= 50 && w < 150)).toBe(true);
  });

  it("does not retry a constraint, permission or partition error", async () => {
    for (const code of ["23505", "42501", "23514", "22P02"]) {
      mocks.transaction.mockReset();
      const e = dbErr(code, code === "23514" ? 'no partition of relation "events" found for row' : "nope");
      mocks.transaction.mockRejectedValue(e);
      const { store: s, sleep } = store();
      const rejected = await s.persist(ctx(), [ev()]).catch((x) => x);
      expect(mocks.transaction, code).toHaveBeenCalledTimes(1);
      expect(sleep, code).not.toHaveBeenCalled();
      if (code === "23514") expect(rejected).toBeInstanceOf(MissingPartitionError);
      else expect(rejected).toBe(e); // surfaced unchanged
    }
  });

  it("surfaces the second failure unchanged and does not retry a third time", async () => {
    const first = dbErr("40P01", "first");
    const second = dbErr("40P01", "second");
    mocks.transaction.mockReset();
    mocks.transaction.mockRejectedValueOnce(first).mockRejectedValueOnce(second).mockRejectedValue(new Error("never"));
    const { store: s, sleep } = store();
    await expect(s.persist(ctx(), [ev()])).rejects.toBe(second);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("a retry that then hits a missing partition is mapped like any other", async () => {
    mocks.transaction.mockReset();
    mocks.transaction
      .mockRejectedValueOnce(dbErr("40001"))
      .mockRejectedValueOnce(dbErr("23514", 'no partition of relation "events" found for row'));
    await expect(store().store.persist(ctx(), [ev()])).rejects.toBeInstanceOf(MissingPartitionError);
  });

  it("does not retry the scope and context checks that run before the database", async () => {
    mocks.transaction.mockReset();
    await expect(store().store.persist(ctx(["eval"]), [ev()])).rejects.toBeInstanceOf(TenantError);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
