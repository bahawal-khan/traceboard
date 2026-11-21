import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { ApiKeyAuthenticator } from "@/lib/api-key-auth";
import { PgEventStore } from "@/lib/events/pg-store";
import { authenticateApiKeyRequest } from "@/lib/http/api-key-request";
import { PriceBook } from "@/lib/ingest/cost";
import { createContentCipher } from "@/lib/ingest/content";
import { createIngestHandler, type IngestDeps } from "@/lib/ingest/handler";
import { UsageGate } from "@/lib/ingest/quota";
import { QUOTAS } from "@/lib/quotas";
import { TokenBucketLimiter } from "@/lib/ratelimit";
import { createApiKey, revokeApiKey, touchApiKey } from "@/lib/repo/api-keys";
import { ctxFromApiKey, ctxFromSession } from "@/lib/repo/ctx";
import { createProject } from "@/lib/repo/projects";
import { loadModelPrices } from "@/lib/repo/prices";
import { readUsageToday } from "@/lib/repo/usage";
import { ensureEventPartitions, jobSql } from "./helpers/job-role";

/** POST /api/ingest end to end against the real database as app_rw. Skipped without DATABASE_URL. */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

run("ingest route (database)", () => {
  const sql = neon(url!);
  const users: string[] = [];
  const cipher = createContentCipher(randomBytes(32));
  const raw = (owner: string, ids: string[], build: (t: T) => NeonQueryInTransaction[]) =>
    sql.transaction((t) => [
      t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', ${ids.join(",")}, true)`,
      ...build(t),
    ]);
  const q = async (x: { owner: string; project: string }, text: string) => (await raw(x.owner, [x.project], (t) => [t.query(text)]))[1] as Record<string, unknown>[];

  type Tenant = Awaited<ReturnType<typeof tenant>>;
  const tenant = async (scopes: string[] = ["ingest"]) => {
    const owner = `test_${randomUUID()}`;
    users.push(owner);
    await sql`select claim_user_slot(${owner}, 100000)`;
    mockAuth.mockResolvedValue({ userId: owner });
    const project = (await createProject((await ctxFromSession())!, { name: "route-test" })).id;
    const { key, secret } = await createApiKey((await ctxFromSession())!, project, { scopes });
    return { owner, project, secret, keyId: key.id, sessionCtx: (await ctxFromSession())! };
  };

  let afterWork: Array<() => Promise<void>>;
  /** Fresh handler per call: new caches, new limiters, so tests cannot leak state into each other. */
  const handlerFor = (over: Partial<IngestDeps> = {}) => {
    afterWork = [];
    const deps: IngestDeps = {
      authenticate: (request) =>
        authenticateApiKeyRequest(request, "ingest", {
          ipLimiter: new TokenBucketLimiter({ burst: 1000, refillPerSec: 1000 }),
          keyLimiter: new TokenBucketLimiter({ burst: 1000, refillPerSec: 1000 }),
          failureBudget: new TokenBucketLimiter({ burst: 1000, refillPerSec: 1000 }),
          authenticator: new ApiKeyAuthenticator(ctxFromApiKey),
        }),
      quota: new UsageGate(readUsageToday, { eventsPerDay: QUOTAS.eventsPerDayPerProject, requestsPerDay: QUOTAS.ingestRequestsPerDayPerProject }),
      prices: new PriceBook(async () => [{ model: "route-test-model", inputPer1m: "2.00", outputPer1m: "10.00", cachedInputPer1m: null }]),
      store: new PgEventStore({ cipher }),
      touchKey: touchApiKey,
      afterResponse: (w) => void afterWork.push(w),
      ...over,
    };
    return createIngestHandler(deps);
  };
  const ev = (o: Record<string, unknown> = {}) => ({ event_id: randomUUID(), ts: new Date(Date.now() - 60_000).toISOString(), ...o });
  const post = (secret: string | null, payload: unknown, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...headers },
      body: payload instanceof Uint8Array ? (payload as unknown as BodyInit) : JSON.stringify(payload),
    });
  const count = async (t: Tenant, table = "events") => ((await q(t, `select count(*)::int as n from ${table}`))[0]!.n as number);

  beforeAll(async () => {
    await ensureEventPartitions();
  });
  afterAll(async () => {
    for (const u of users) await raw(u, [], (t) => [t`delete from projects where owner_id = ${u}`, t`select release_user_slot()`]);
  });

  it("accepts a batch: 202, rows, server-side cost, rollups, usage, and last_used_at after the response", async () => {
    const a = await tenant();
    const handler = handlerFor();
    const r = await handler(post(a.secret, { events: [ev({ model: "route-test-model", input_tokens: 1000, output_tokens: 100, latency_ms: 90 }), ev({ kind: "tool", name: "search" })] }));
    expect(r.status).toBe(202);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ accepted: 2, duplicates: 0, rejected: [], guard: { status: "ok", exceeded: [] } });
    expect(body.flush_hint_ms).toBeGreaterThanOrEqual(10_000);
    expect(body.flush_hint_ms).toBeLessThanOrEqual(15_000);
    expect(await count(a)).toBe(2);
    expect((await q(a, "select cost_usd from events where model = 'route-test-model'"))[0]).toEqual({ cost_usd: "0.003000" }); // 1000 * 2 + 100 * 10 micro-USD
    expect(await q(a, "select events::text as e, requests::text as r, cost_micro::text as c from usage_daily")).toEqual([{ e: "2", r: "1", c: "3000" }]);
    expect(await count(a, "metrics_minute")).toBe(2);
    expect(await q(a, `select last_used_at from api_keys where id = '${a.keyId}'`)).toEqual([{ last_used_at: null }]);
    await afterWork[0]!();
    expect((await q(a, `select last_used_at from api_keys where id = '${a.keyId}'`))[0]!.last_used_at).not.toBeNull();
  });

  it("a repeated request inserts nothing new: duplicates reported, events and cost counted once, requests twice", async () => {
    const a = await tenant();
    const handler = handlerFor();
    const payload = { events: [ev({ model: "route-test-model", input_tokens: 10 }), ev()] };
    await handler(post(a.secret, payload));
    const second = (await (await handler(post(a.secret, payload))).json()) as Record<string, unknown>;
    expect(second).toMatchObject({ accepted: 2, duplicates: 2 });
    expect(await count(a)).toBe(2);
    expect(await q(a, "select events::text as e, requests::text as r from usage_daily")).toEqual([{ e: "2", r: "2" }]);
  });

  it("rejects out-of-window events individually and stores the rest", async () => {
    const a = await tenant();
    const old = ev({ ts: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    const r = (await (await handlerFor()(post(a.secret, { events: [ev(), old] }))).json()) as { accepted: number; rejected: unknown[] };
    expect(r.accepted).toBe(1);
    expect(r.rejected).toEqual([{ event_id: old.event_id, reason: "ts_too_old" }]);
    expect(await count(a)).toBe(1);
  });

  it("accepts a gzip batch of 100 events", async () => {
    const a = await tenant();
    const events = Array.from({ length: 100 }, (_, i) => ev({ name: `n${i}`, model: "route-test-model", input_tokens: 1 }));
    const r = await handlerFor()(post(a.secret, gzipSync(JSON.stringify({ events })), { "content-encoding": "gzip" }));
    expect(r.status).toBe(202);
    expect(await count(a)).toBe(100);
  });

  it("refuses a missing, unknown, revoked or wrong-scope key and writes nothing", async () => {
    const a = await tenant();
    const evalOnly = await tenant(["eval"]);
    const handler = handlerFor();
    expect((await handler(post(null, { events: [ev()] }))).status).toBe(401);
    expect((await handler(post(`lm_${"A".repeat(43)}`, { events: [ev()] }))).status).toBe(401);
    expect((await handlerFor()(post(evalOnly.secret, { events: [ev()] }))).status).toBe(403);
    expect(await count(evalOnly)).toBe(0);
    await revokeApiKey(a.sessionCtx, a.project, a.keyId);
    expect((await handlerFor()(post(a.secret, { events: [ev()] }))).status).toBe(401); // a fresh cache, so no 60 s grace
    expect(await count(a)).toBe(0);
  });

  it("IDOR: two tenants sending the same event ids keep separate data and never see each other's", async () => {
    const a = await tenant();
    const b = await tenant();
    const shared = ev({ model: "route-test-model", input_tokens: 5 });
    expect((await handlerFor()(post(a.secret, { events: [shared] }))).status).toBe(202);
    const rb = (await (await handlerFor()(post(b.secret, { events: [shared] }))).json()) as { duplicates: number };
    expect(rb.duplicates).toBe(0); // A's row does not make B's a duplicate
    expect(await count(a)).toBe(1);
    expect(await count(b)).toBe(1);
    for (const table of ["events", "metrics_minute", "usage_daily"]) {
      expect(await q(a, `select count(*)::int as n from ${table} where project_id = '${b.project}'`), table).toEqual([{ n: 0 }]);
    }
  });

  it("enforces the daily quotas: 429 quota_exceeded, nothing written, Retry-After set", async () => {
    const byEvents = await tenant();
    await raw(byEvents.owner, [byEvents.project], (t) => [
      t`insert into usage_daily (project_id, day, events, requests) values (${byEvents.project}, (now() at time zone 'UTC')::date, ${QUOTAS.eventsPerDayPerProject}, 1)`,
    ]);
    const r1 = await handlerFor()(post(byEvents.secret, { events: [ev()] }));
    expect(r1.status).toBe(429);
    expect(await r1.json()).toMatchObject({ error: "quota_exceeded", limit: "events" });
    expect(Number(r1.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await count(byEvents)).toBe(0);

    const byRequests = await tenant();
    await raw(byRequests.owner, [byRequests.project], (t) => [
      t`insert into usage_daily (project_id, day, events, requests) values (${byRequests.project}, (now() at time zone 'UTC')::date, 1, ${QUOTAS.ingestRequestsPerDayPerProject})`,
    ]);
    const r2 = await handlerFor()(post(byRequests.secret, { events: [ev()] }));
    expect(await r2.json()).toMatchObject({ error: "quota_exceeded", limit: "requests" });
    expect(await count(byRequests)).toBe(0);
  });

  it("returns the guard verdict from the budgets the batch touched", async () => {
    const a = await tenant();
    await raw(a.owner, [a.project], (t) => [t`insert into budgets (project_id, scope, period, limit_usd, action) values (${a.project}, 'project', 'day', 0.001, 'block')`]);
    const r = (await (await handlerFor()(post(a.secret, { events: [ev({ model: "route-test-model", input_tokens: 1000 })] }))).json()) as { guard: { status: string; exceeded: Array<{ action: string; spent_micro: number; limit_micro: number }> } };
    expect(r.guard.status).toBe("block"); // 1000 * 2 = 2000 micro-USD spent, limit 1000
    expect(r.guard.exceeded[0]).toMatchObject({ action: "block", spent_micro: 2000, limit_micro: 1000 });
  });

  it("stores encrypted content only when the project opted in", async () => {
    const off = await tenant();
    const on = await tenant();
    await raw(on.owner, [on.project], (t) => [t`update projects set capture_content = true where id = ${on.project}`]);
    const payload = () => ({ events: [ev({ content: { input: "ROUTE-SENTINEL" } })] });
    await handlerFor()(post(off.secret, payload()));
    await handlerFor()(post(on.secret, payload()));
    expect(await count(off, "event_content")).toBe(0);
    expect(await count(on, "event_content")).toBe(1);
    expect(JSON.stringify(await q(on, "select * from event_content"))).not.toContain("ROUTE-SENTINEL");
  });

  it("flush_hint_ms follows the project: 1 s while viewed, 60 s in conserve mode", async () => {
    const a = await tenant();
    await raw(a.owner, [a.project], (t) => [t`update projects set last_viewed_at = now() where id = ${a.project}`]);
    const viewed = (await (await handlerFor()(post(a.secret, { events: [ev()] }))).json()) as { flush_hint_ms: number };
    expect(viewed.flush_hint_ms).toBe(1000);

    const job = jobSql(); // app_rw cannot write app_state since 0012: the storage guard functions (app_job) are the only writer
    try {
      await job`select * from apply_storage_level('warn')`; // warn turns the conserve flag on
      const conserve = (await (await handlerFor()(post(a.secret, { events: [ev()] }))).json()) as { flush_hint_ms: number };
      expect(conserve.flush_hint_ms).toBe(60_000);
    } finally {
      await job`select * from apply_storage_level('ok')`; // leaving warn turns conserve off again
    }
  });
});

run("model price loader (database)", () => {
  it("reads the global price list with numeric values as text", async () => {
    const prices = await loadModelPrices();
    for (const p of prices) {
      expect(p.model).toMatch(/^[a-z0-9]/);
      expect(p.inputPer1m).toMatch(/^\d+(\.\d+)?$/);
      expect(p.outputPer1m).toMatch(/^\d+(\.\d+)?$/);
      expect(p.cachedInputPer1m === null || /^\d+(\.\d+)?$/.test(p.cachedInputPer1m)).toBe(true);
    }
  });
});
