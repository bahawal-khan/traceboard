import { NeonDbError } from "@neondatabase/serverless";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getSql: () => ({ transaction: mocks.transaction }) }));

import { PgEventStore } from "@/lib/events/pg-store";
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

type Stmt = { text: string; values: unknown[] };
let seen: Stmt[];
beforeEach(() => {
  seen = [];
  mocks.transaction.mockReset();
  mocks.transaction.mockImplementation(async (build: (t: (s: TemplateStringsArray, ...v: unknown[]) => Stmt) => Stmt[]) => {
    const t = (s: TemplateStringsArray, ...values: unknown[]) => ({ text: s.join("?"), values });
    seen = build(t);
    return seen.map((_, i) => (i === 0 ? [] : [{ inserted: 3 }]));
  });
});

describe("PgEventStore (statement shape; no database)", () => {
  it("runs one static statement under the key's own project scope and returns the inserted count", async () => {
    const r = await new PgEventStore().persist(ctx(), [ev(), ev({ eventId: "3f0c1b2e-8a64-4d1f-9c7e-5b2a6d9e1f41" })]);
    expect(r).toEqual({ inserted: 3 });
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
    expect(await new PgEventStore().persist(ctx(), [])).toEqual({ inserted: 0 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses a key without the ingest scope, and any context that is not exactly one project, before the database", async () => {
    await expect(new PgEventStore().persist(ctx(["eval"]), [ev()])).rejects.toBeInstanceOf(TenantError);
    await expect(new PgEventStore().persist(ctx(["ingest"], [PID, OTHER]), [ev()])).rejects.toBeInstanceOf(TenantError);
    await expect(new PgEventStore().persist(ctx(["ingest"], []), [ev()])).rejects.toBeInstanceOf(TenantError);
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
