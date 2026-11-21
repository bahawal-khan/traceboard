import { neon, type NeonQueryFunctionInTransaction, type NeonQueryInTransaction } from "@neondatabase/serverless";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

import { ApiKeyAuthenticator } from "@/lib/api-key-auth";
import { PgEventStore } from "@/lib/events/pg-store";
import { authenticateApiKeyRequest } from "@/lib/http/api-key-request";
import { PriceBook } from "@/lib/ingest/cost";
import { createContentCipher } from "@/lib/ingest/content";
import type { IngestDeps } from "@/lib/ingest/handler";
import { UsageGate } from "@/lib/ingest/quota";
import { createOtlpTracesHandler, type OtlpDeps } from "@/lib/otlp/handler";
import { eventIdForSpan } from "@/lib/otlp/ids";
import { QUOTAS } from "@/lib/quotas";
import { TokenBucketLimiter } from "@/lib/ratelimit";
import { createApiKey, touchApiKey } from "@/lib/repo/api-keys";
import { ctxFromApiKey, ctxFromSession } from "@/lib/repo/ctx";
import { createProject } from "@/lib/repo/projects";
import { readUsageToday } from "@/lib/repo/usage";
import { cleanupOwners } from "./helpers/cleanup";
import { ensureEventPartitions } from "./helpers/job-role";

/**
 * POST /api/otlp/v1/traces end to end against the real database as app_rw (OTLP/JSON, timestamps relative to now: the protobuf
 * fixture of the real Python exporter is dated 2026-01-01 and is covered, with a fake store, by tests/otlp-fixture.test.ts).
 * Skipped without DATABASE_URL.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
type T = NeonQueryFunctionInTransaction<false, false>;

const ns = (ms: number) => (BigInt(ms) * BigInt(1_000_000)).toString();
const str = (key: string, v: string) => ({ key, value: { stringValue: v } });
const int = (key: string, v: number) => ({ key, value: { intValue: String(v) } });
const dbl = (key: string, v: number) => ({ key, value: { doubleValue: v } });
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

run("otlp route (database)", () => {
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
    const project = (await createProject((await ctxFromSession())!, { name: "otlp-route-test" })).id;
    const { secret } = await createApiKey((await ctxFromSession())!, project, { scopes });
    return { owner, project, secret };
  };
  const handlerFor = (over: Partial<OtlpDeps> = {}) => {
    const deps: IngestDeps & { genAiOnly?: boolean } = {
      authenticate: (request) =>
        authenticateApiKeyRequest(request, "ingest", {
          ipLimiter: new TokenBucketLimiter({ burst: 1000, refillPerSec: 1000 }),
          keyLimiter: new TokenBucketLimiter({ burst: 1000, refillPerSec: 1000 }),
          failureBudget: new TokenBucketLimiter({ burst: 1000, refillPerSec: 1000 }),
          authenticator: new ApiKeyAuthenticator(ctxFromApiKey),
        }),
      quota: new UsageGate(readUsageToday, { eventsPerDay: QUOTAS.eventsPerDayPerProject, requestsPerDay: QUOTAS.ingestRequestsPerDayPerProject }),
      prices: new PriceBook(async () => [{ model: "gpt-4o-2024-08-06", inputPer1m: "2.50", outputPer1m: "10.00", cachedInputPer1m: "1.25" }]),
      store: new PgEventStore({ cipher }),
      touchKey: touchApiKey,
      afterResponse: () => {},
      ...over,
    };
    return createOtlpTracesHandler(deps);
  };
  const post = (secret: string | null, payload: unknown) =>
    new Request("http://localhost/api/otlp/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify(payload),
    });
  const count = async (t: Tenant, table = "events") => (await q(t, `select count(*)::int as n from ${table}`))[0]!.n as number;

  /** One trace like the demo exporter's: agent > step > chat, agent > tool (fails), plus a plain HTTP span in another trace. */
  function trace() {
    const t0 = Date.now() - 120_000;
    const traceId = hex(16);
    const ids = { agent: hex(8), step: hex(8), chat: hex(8), tool: hex(8), http: hex(8) };
    const span = (spanId: string, name: string, parentSpanId: string | undefined, at: number, ms: number, attributes: unknown[], status = 1, tid = traceId) => ({
      traceId: tid, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, kind: 1, startTimeUnixNano: ns(t0 + at), endTimeUnixNano: ns(t0 + at + ms), attributes, status: { code: status },
    });
    const spans = [
      span(ids.agent, "invoke_agent support", undefined, 0, 3100, [str("gen_ai.operation.name", "invoke_agent"), str("gen_ai.agent.name", "support")]),
      span(ids.step, "workflow.step", ids.agent, 100, 2800, [str("app.step", "plan")]),
      span(ids.chat, "chat gpt-4o", ids.step, 200, 850, [
        str("gen_ai.operation.name", "chat"), str("gen_ai.provider.name", "openai"), str("gen_ai.request.model", "gpt-4o"), str("gen_ai.response.model", "gpt-4o-2024-08-06"),
        int("gen_ai.usage.input_tokens", 1200), int("gen_ai.usage.output_tokens", 80), int("gen_ai.usage.cache_read.input_tokens", 1024),
        dbl("gen_ai.response.time_to_first_chunk", 0.42), str("gen_ai.conversation.id", "conv-9"),
        str("gen_ai.input.messages", "SENTINEL-OTLP-PROMPT-TEXT"), // must never be read or stored
      ]),
      span(ids.tool, "execute_tool search", ids.agent, 2900, 100, [str("gen_ai.operation.name", "execute_tool"), str("gen_ai.tool.name", "search")], 2),
      span(ids.http, "GET /health", undefined, 50, 5, [str("http.request.method", "GET"), str("http.route", "/health")], 1, hex(16)),
    ];
    return { ids, traceId, body: { resourceSpans: [{ resource: { attributes: [str("service.name", "otlp-e2e-demo")] }, scopeSpans: [{ scope: { name: "test" }, spans }] }] } };
  }

  beforeAll(async () => {
    await ensureEventPartitions();
  });
  afterAll(async () => {
    await cleanupOwners(sql, users);
  });

  it("stores the GenAI spans and their plain ancestor, drops the plain HTTP span, and maps tokens, cache, TTFT, parents and errors", async () => {
    const a = await tenant();
    const { ids, traceId, body } = trace();
    const r = await handlerFor()(post(a.secret, body));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
    expect(await count(a)).toBe(4); // agent, step, chat, tool; the HTTP span is filtered out
    const rows = await q(a, "select event_id::text as id, kind, name, model, provider, input_tokens, output_tokens, cached_tokens, ttft_ms, status, span_id, parent_id, thread_id, cost_usd::text as cost from events order by occurred_at");
    const byName = Object.fromEntries(rows.map((x) => [x.name as string, x]));
    expect(Object.keys(byName).sort()).toEqual(["chat gpt-4o", "execute_tool search", "invoke_agent support", "workflow.step"]);
    const chat = byName["chat gpt-4o"]!;
    expect(chat).toMatchObject({ kind: "llm", model: "gpt-4o-2024-08-06", provider: "openai", input_tokens: 1200, output_tokens: 80, cached_tokens: 1024, ttft_ms: 420, status: "ok", parent_id: ids.step, thread_id: "conv-9" });
    expect(chat.id).toBe(eventIdForSpan(traceId, ids.chat)); // deterministic: a re-export is idempotent
    expect(Number(chat.cost)).toBeGreaterThan(0); // priced on the server from the price book, never taken from the client
    expect(byName["execute_tool search"]).toMatchObject({ kind: "tool", status: "error", parent_id: ids.agent });
    expect(byName["workflow.step"]).toMatchObject({ parent_id: ids.agent });
    expect(byName["invoke_agent support"]).toMatchObject({ kind: "agent" });
    expect(await q(a, "select events::text as e, requests::text as r from usage_daily")).toEqual([{ e: "4", r: "1" }]);
  });

  it("never reads or stores prompt text: no row, rollup or content table contains the sentinel", async () => {
    const a = await tenant();
    await handlerFor()(post(a.secret, trace().body));
    expect(await count(a, "event_content")).toBe(0);
    for (const table of ["events", "event_content", "metrics_minute", "metrics_hourly", "usage_daily"]) {
      for (const row of await q(a, `select row_to_json(t)::text as j from ${table} t`)) expect(String(row.j), table).not.toContain("SENTINEL");
    }
  });

  it("a re-export of the same spans inserts nothing new and counts events once (requests count twice)", async () => {
    const a = await tenant();
    const { body } = trace();
    const handler = handlerFor();
    await handler(post(a.secret, body));
    const first = await q(a, "select (select count(*) from events)::int as ev, (select coalesce(sum(calls), 0) from metrics_minute)::int as calls");
    const again = await handler(post(a.secret, body));
    expect(again.status).toBe(200);
    expect(await q(a, "select (select count(*) from events)::int as ev, (select coalesce(sum(calls), 0) from metrics_minute)::int as calls")).toEqual(first);
    expect(await q(a, "select events::text as e, requests::text as r from usage_daily")).toEqual([{ e: "4", r: "2" }]);
  });

  it("with the filter off (OTLP_GENAI_ONLY=false) the plain HTTP span is stored too", async () => {
    const a = await tenant();
    await handlerFor({ genAiOnly: false })(post(a.secret, trace().body));
    expect(await count(a)).toBe(5);
  });

  it("refuses a missing or unknown key and writes nothing", async () => {
    const a = await tenant();
    const handler = handlerFor();
    expect((await handler(post(null, trace().body))).status).toBe(401);
    expect((await handler(post(`lm_${"Z".repeat(43)}`, trace().body))).status).toBe(401);
    expect(await count(a)).toBe(0);
  });

  it("IDOR: two tenants exporting the same trace and span ids keep separate data", async () => {
    const a = await tenant();
    const b = await tenant();
    const { body } = trace();
    const handler = handlerFor();
    await handler(post(b.secret, body)); // B first: must not turn A's identical spans into duplicates
    const ra = await handler(post(a.secret, body));
    expect(ra.status).toBe(200);
    expect(await count(a)).toBe(4);
    expect(await count(b)).toBe(4);
    expect(await q(a, `select count(*)::int as n from events where project_id = '${b.project}'`)).toEqual([{ n: 0 }]);
  });
});
