import { NeonDbError } from "@neondatabase/serverless";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getSql: () => ({ transaction: mocks.transaction }) }));

import { isRetryableTxError, PgEventStore } from "@/lib/events/pg-store";
import { isMissingPartitionError, MissingPartitionError } from "@/lib/events/store";
import { QUOTAS } from "@/lib/quotas";
import { checkCteOrder } from "./helpers/cte-order";
import type { NormalizedEvent } from "@/lib/ingest/normalize";
import { contentAad, createContentCipher } from "@/lib/ingest/content";
import { issueCtx, TenantError, type ApiKeyCtx } from "@/lib/repo/tenant";
import { randomBytes } from "node:crypto";

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
  content_stored: 0,
  content_dropped: 0,
  last_viewed_at: null,
  conserve: false,
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
      contentStored: 0, contentDropped: 0,
      signals: { lastViewedAt: null, conserve: false },
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

  it("enforces the daily content cap in the same statement: capped insert, counter in usage_daily, dropped count; cap is a bound parameter", async () => {
    await new PgEventStore().persist(ctx(), [ev()]);
    const insert = seen[1]!;
    expect(insert.text).toMatch(/limit \(select content_slots_left\(\?::uuid, \?::int\)\)/);
    expect(insert.values).toContain(QUOTAS.contentRowsPerDayPerProject);
    expect(insert.text).toContain("content_rows = usage_daily.content_rows + excluded.content_rows");
    expect(insert.text).toMatch(/\(select count\(\*\) from cw\) - \(select count\(\*\) from c\)\)::int as content_dropped/);
  });

  it("the ingest statement's WITH list is well ordered: every CTE reads only earlier CTEs or known tables (P2.11c1 regression)", async () => {
    await new PgEventStore().persist(ctx(), [ev()]);
    const { names, problems } = checkCteOrder(seen[1]!.text, ["events", "projects", "budgets", "app_state", "metrics_minute", "metrics_hourly", "usage_daily", "event_content", "budget_usage"]);
    expect(problems).toEqual([]);
    // c (content insert) must come before u (usage_daily upsert, which counts c's rows) and the final select.
    expect(names).toEqual(["src", "ins", "ev", "m", "h", "cw", "c", "u", "bk", "bu"]);
    expect(names.indexOf("cw")).toBeLessThan(names.indexOf("c"));
    expect(names.indexOf("c")).toBeLessThan(names.indexOf("u"));
  });

  it("takes project_id from the context, never from the rows", async () => {
    // Even a row smuggling a foreign project id in any field cannot change the project parameter.
    const sneaky = { ...ev(), projectId: OTHER, project_id: OTHER } as unknown as NormalizedEvent;
    await new PgEventStore().persist(ctx(), [sneaky]);
    const insert = seen[1]!;
    expect(insert.values).toContain(PID);
    expect(insert.values[0]).not.toBe(PID); // the first parameter is the row payload, not a project id
    const payload = JSON.parse(insert.values[0] as string) as Array<Record<string, unknown>>;
    expect(JSON.stringify(payload)).not.toContain(OTHER); // the wire form lists columns explicitly
    expect(payload[0]).not.toHaveProperty("project_id");
  });

  it("sends the rows as one JSON parameter with ISO timestamps", async () => {
    await new PgEventStore().persist(ctx(), [ev({ model: "m", inputTokens: 5, costUsd: "0.000001", tags: ["a"] })]);
    const payload = JSON.parse(seen[1]!.values[0] as string) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ model: "m", input_tokens: 5, cost_usd: "0.000001", tags: ["a"], occurred_at: "2026-11-20T11:59:00.000Z", status: "ok", kind: "llm" });
  });

  it("does not touch the database for an empty batch", async () => {
    expect(await new PgEventStore().persist(ctx(), [])).toEqual({ inserted: 0, contentStored: 0, contentDropped: 0, usage: null, signals: null, budgets: [] });
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
    expect(text).toMatch(/returning event_id, occurred_at, trace_id, model, status/);
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

  it("spreads minute rollups over shards but writes hourly rollups with the single shard 0", async () => {
    await new PgEventStore({ pickShard: () => 5 }).persist(ctx(), [ev()]);
    const text = seen[1]!.text;
    const hourly = text.slice(text.indexOf("insert into metrics_hourly"), text.indexOf("u as ("));
    const minute = text.slice(text.indexOf("insert into metrics_minute"), text.indexOf("h as ("));
    expect(hourly).toContain("0::smallint");
    expect(hourly).not.toMatch(/\?::smallint/); // no shard parameter in the hourly statement
    expect(minute).toMatch(/\?::smallint/); // the minute statement takes the picked shard
    expect(seen[1]!.values.filter((v) => v === 5)).toHaveLength(1); // the shard parameter appears exactly once
    expect(hourly).toContain("on conflict (project_id, bucket, model, shard)"); // the column and key stay: no migration
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

describe("content capture in the statement (no database)", () => {
  const key = randomBytes(32);
  const cipher = createContentCipher(key);
  const withContent = (o: Partial<NormalizedEvent> = {}) => ev({ content: { input: "user asked about jane@example.com", output: "PLAINTEXT-ANSWER" }, ...o });
  const payloadOf = () => JSON.parse(seen[1]!.values[0] as string) as Array<Record<string, unknown>>;

  it("sends ciphertext only: the plaintext appears in no parameter and no SQL text", async () => {
    await new PgEventStore({ cipher }).persist(ctx(), [withContent()]);
    const all = JSON.stringify(seen);
    for (const secret of ["PLAINTEXT-ANSWER", "jane@example.com", "user asked about"]) expect(all).not.toContain(secret);
    const row = payloadOf()[0]!;
    expect(String(row.c_in)).toMatch(/^v1\.1\./);
    expect(String(row.c_out)).toMatch(/^v1\.1\./);
    // Bound to this project and event: the stored ciphertext decrypts only with the matching AAD.
    expect(cipher.decrypt(String(row.c_out), contentAad(PID, "3f0c1b2e-8a64-4d1f-9c7e-5b2a6d9e1f40", "output"))).toBe("PLAINTEXT-ANSWER");
    expect(cipher.decrypt(String(row.c_in), contentAad(PID, "3f0c1b2e-8a64-4d1f-9c7e-5b2a6d9e1f40", "input"))).toBe("user asked about [redacted:email]");
    expect(row.c_rep).toMatchObject({ v: 1, enc: "aes-256-gcm", redactions: { email: 1 } });
  });

  it("with no key configured, content is dropped: no ciphertext, no plaintext, events still persist", async () => {
    const r = await new PgEventStore({ cipher: null }).persist(ctx(), [withContent()]);
    expect(r.inserted).toBe(3);
    const row = payloadOf()[0]!;
    expect([row.c_in, row.c_out, row.c_rep]).toEqual([null, null, null]);
    expect(JSON.stringify(seen)).not.toContain("PLAINTEXT-ANSWER");
  });

  it("does not even look for the key when the batch has no content", async () => {
    const source = vi.fn(() => cipher);
    await new PgEventStore({ cipher: source }).persist(ctx(), [ev(), ev()]);
    expect(source).not.toHaveBeenCalled();
    await new PgEventStore({ cipher: source }).persist(ctx(), [withContent()]);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("the content insert reads only inserted rows, only for opted-in projects, with a capped retention", async () => {
    await new PgEventStore({ cipher }).persist(ctx(), [withContent()]);
    const text = seen[1]!.text;
    const c = text.slice(text.indexOf("c as ("), text.indexOf("bk as ("));
    expect(c).toContain("from ins i");
    expect(c).toContain("p.capture_content");
    expect(c).toContain("least(p.content_retention_days,");
    expect(c).toContain("on conflict (project_id, event_id) do nothing");
    expect(seen[1]!.values).toContain(3); // RETENTION.contentDays, the platform cap
  });

  it("never stores content for an event without any (null columns)", async () => {
    await new PgEventStore({ cipher }).persist(ctx(), [ev(), withContent({ eventId: "3f0c1b2e-8a64-4d1f-9c7e-5b2a6d9e1f41" })]);
    const rows = payloadOf();
    expect([rows[0]!.c_in, rows[0]!.c_out, rows[0]!.c_rep]).toEqual([null, null, null]);
    expect(rows[1]!.c_in).not.toBeNull();
  });
});
