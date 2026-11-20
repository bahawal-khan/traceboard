import { NeonDbError } from "@neondatabase/serverless";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissingPartitionError, type EventStore, type PersistResult } from "@/lib/events/store";
import { PriceBook } from "@/lib/ingest/cost";

import { UsageGate } from "@/lib/ingest/quota";
import { createLogger } from "@/lib/logger";
import { createOtlpTracesHandler, type OtlpDeps } from "@/lib/otlp/handler";
import { eventIdForSpan } from "@/lib/otlp/ids";
import { OTLP_LIMITS } from "@/lib/otlp/map";
import { issueCtx, type ApiKeyCtx } from "@/lib/repo/tenant";

const PID = "11111111-1111-4111-8111-111111111111";
const KEY = `lm_${"K".repeat(43)}`;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const ctx = issueCtx<ApiKeyCtx>({ kind: "apiKey", ownerId: null, projectIds: [PID], keyId: "22222222-2222-4222-8222-222222222222", scopes: ["ingest"], readOnly: false });
const TRACE = "5b8efff798038103d269b633813fc60c";
const ns = (ms: number) => (BigInt(ms) * BigInt(1_000_000)).toString();
const sid = (i: number) => (i + 1).toString(16).padStart(16, "0");
const sp = (i = 0, over: Record<string, unknown> = {}, attrs: Array<{ key: string; value: Record<string, unknown> }> = []) => ({
  traceId: TRACE, spanId: sid(i), name: `span-${i}`, startTimeUnixNano: ns(NOW - 60_000), endTimeUnixNano: ns(NOW - 59_000), attributes: attrs, status: { code: 1 }, ...over,
});
const str = (key: string, v: string) => ({ key, value: { stringValue: v } });
const int = (key: string, v: number) => ({ key, value: { intValue: String(v) } });
const otlp = (spans: unknown[]) => ({ resourceSpans: [{ resource: { attributes: [str("service.name", "agent")] }, scopeSpans: [{ scope: {}, spans }] }] });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/otlp/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...headers },
    body: typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
  });
const okResult = (o: Partial<PersistResult> = {}): PersistResult => ({ inserted: 1, contentStored: 0, usage: { events: 1, requests: 1, costMicro: 0 }, signals: { lastViewedAt: null, conserve: false }, budgets: [], ...o });

let logs: string[];
let persisted: Array<{ rows: Array<Record<string, unknown>> }>;
let afterWork: Array<() => Promise<void>>;
let store: EventStore & { persist: ReturnType<typeof vi.fn> };
let deps: OtlpDeps;

function build(over: Partial<OtlpDeps> = {}) {
  persisted = [];
  afterWork = [];
  logs = [];
  store = {
    persist: vi.fn(async (_c: ApiKeyCtx, rows: readonly unknown[]) => {
      persisted.push({ rows: [...rows] as Array<Record<string, unknown>> });
      return okResult({ inserted: rows.length });
    }),
  };
  deps = {
    authenticate: vi.fn(async () => ({ ok: true as const, ctx })),
    quota: new UsageGate(async () => null, { eventsPerDay: 1000, requestsPerDay: 100 }, { now: () => NOW }),
    prices: new PriceBook(async () => [{ model: "claude-sonnet-5-5", inputPer1m: "2.00", outputPer1m: "10.00", cachedInputPer1m: "0.10" }], 60_000, () => NOW),
    store,
    touchKey: vi.fn(async () => true),
    afterResponse: (w) => void afterWork.push(w),
    now: () => NOW,
    random: () => 0,
    genAiOnly: false, // these tests use plain spans; the filter has its own tests (otlp-filter.test.ts)
    log: createLogger({}, { minLevel: "debug", sink: (l) => void logs.push(l) }),
    ...over,
  };
  return createOtlpTracesHandler(deps);
}
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;
beforeEach(() => vi.restoreAllMocks());

describe("POST /api/otlp/v1/traces: success", () => {
  it("answers 200 {} and persists ONE batch with server-computed cost and deterministic event ids", async () => {
    const handler = build();
    const llm = sp(0, {}, [str("gen_ai.operation.name", "chat"), str("gen_ai.response.model", "claude-sonnet-5-5"), int("gen_ai.usage.input_tokens", 1000), int("gen_ai.usage.output_tokens", 500)]);
    const r = await handler(post(otlp([llm, sp(1)])));
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({});
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(store.persist).toHaveBeenCalledTimes(1);
    const rows = persisted[0]!.rows;
    expect(rows.map((x) => x.costMicro)).toEqual([2000 + 5000, null]);
    expect(rows[0]!.eventId).toBe(eventIdForSpan(TRACE, sid(0)));
    expect(rows[0]!.traceId).toBe(TRACE);
  });

  it("a re-export of the same spans produces the same event ids (idempotent)", async () => {
    const handler = build();
    await handler(post(otlp([sp(0), sp(1)])));
    await handler(post(otlp([sp(0), sp(1)])));
    expect(persisted[0]!.rows.map((x) => x.eventId)).toEqual(persisted[1]!.rows.map((x) => x.eventId));
  });

  it("accepts a gzip body and echoes a safe request id", async () => {
    const handler = build();
    const r = await handler(post(gzipSync(JSON.stringify(otlp([sp(0)]))), { "content-encoding": "gzip", "x-request-id": "abc-12345678" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-request-id")).toBe("abc-12345678");
  });

  it("an empty export is a 200 and never touches the store", async () => {
    const handler = build();
    expect((await handler(post({}))).status).toBe(200);
    expect((await handler(post(otlp([])))).status).toBe(200);
    expect(store.persist).not.toHaveBeenCalled();
  });

  it("schedules last_used_at after the response and refreshes the quota from the write", async () => {
    const handler = build();
    store.persist.mockResolvedValueOnce(okResult({ usage: { events: 1000, requests: 5, costMicro: 0 } }));
    await handler(post(otlp([sp(0)])));
    expect(deps.touchKey).not.toHaveBeenCalled();
    await afterWork[0]!();
    expect(deps.touchKey).toHaveBeenCalledWith(ctx);
    expect((await handler(post(otlp([sp(1)])))).status).toBe(429);
  });
});

describe("POST /api/otlp/v1/traces: partial success", () => {
  it("counts spans it cannot store, never resends them, and stores the rest", async () => {
    const handler = build();
    const spans = [sp(0), sp(1, { traceId: "zz" }), sp(2, { startTimeUnixNano: "0" }), sp(3, { startTimeUnixNano: ns(NOW - 3 * 86_400_000) }), sp(4, { startTimeUnixNano: ns(NOW + 3 * 86_400_000) })];
    const r = await handler(post(otlp(spans)));
    expect(r.status).toBe(200);
    const b = (await body(r)) as { partialSuccess: { rejectedSpans: string; errorMessage: string } };
    expect(b.partialSuccess.rejectedSpans).toBe("4"); // int64 is a string in OTLP JSON
    expect(b.partialSuccess.errorMessage).toMatch(/bad_ids=1/);
    expect(b.partialSuccess.errorMessage).toMatch(/bad_time=1/);
    expect(b.partialSuccess.errorMessage).toMatch(/ts_too_old=1/);
    expect(b.partialSuccess.errorMessage).toMatch(/ts_in_future=1/);
    expect(persisted[0]!.rows).toHaveLength(1);
  });

  it("spans over the per-request cap are reported, not silently lost", async () => {
    const handler = build();
    const r = await handler(post(otlp(Array.from({ length: OTLP_LIMITS.maxSpansPerRequest + 3 }, (_, i) => sp(i)))));
    expect(persisted[0]!.rows).toHaveLength(OTLP_LIMITS.maxSpansPerRequest);
    expect(((await body(r)) as { partialSuccess: { rejectedSpans: string } }).partialSuccess.rejectedSpans).toBe("3");
  });

  it("when every span is rejected the answer is still 200 with a partialSuccess and nothing is persisted", async () => {
    const handler = build();
    const r = await handler(post(otlp([sp(0, { traceId: "" })])));
    expect(r.status).toBe(200);
    expect(await body(r)).toMatchObject({ partialSuccess: { rejectedSpans: "1" } });
    expect(store.persist).not.toHaveBeenCalled();
  });
});

describe("POST /api/otlp/v1/traces: request errors", () => {
  it("auth failures are passed through with Retry-After and WWW-Authenticate", async () => {
    let handler = build({ authenticate: async () => ({ ok: false, status: 401, error: "unauthorized" }) });
    let r = await handler(post(otlp([sp()])));
    expect([r.status, r.headers.get("www-authenticate")]).toEqual([401, "Bearer"]);
    handler = build({ authenticate: async () => ({ ok: false, status: 429, error: "rate_limited", retryAfterSec: 7 }) });
    r = await handler(post(otlp([sp()])));
    expect([r.status, r.headers.get("retry-after")]).toEqual([429, "7"]);
    handler = build({ authenticate: async () => ({ ok: false, status: 403, error: "forbidden" }) });
    expect((await handler(post(otlp([sp()])))).status).toBe(403);
  });

  it("429 quota_exceeded with Retry-After once the day's events are used", async () => {
    const handler = build({ quota: new UsageGate(async () => ({ events: 5000, requests: 1, costMicro: 0 }), { eventsPerDay: 1000, requestsPerDay: 100 }, { now: () => NOW }) });
    const r = await handler(post(otlp([sp()])));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await body(r)).toMatchObject({ error: "quota_exceeded" });
  });

  it("other content types are 415, a permanent answer OTLP clients do not retry", async () => {
    const handler = build();
    for (const type of ["text/plain", "application/protobuf", "application/grpc"]) {
      const r = await handler(post(new Uint8Array([10, 2, 8, 1]), { "content-type": type }));
      expect(r.status, type).toBe(415);
    }
    expect(store.persist).not.toHaveBeenCalled();
  });

  it("400 for malformed JSON and for a body that is not a trace request; nothing is echoed", async () => {
    const handler = build();
    expect((await handler(post("{not json"))).status).toBe(400);
    const r = await handler(post({ resourceSpans: "SECRET-INPUT-VALUE" }));
    expect(r.status).toBe(400);
    expect(JSON.stringify(await body(r))).not.toContain("SECRET-INPUT-VALUE");
    expect((await handler(post({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 5 }] }] }] }))).status).toBe(400);
  });

  it("413 above the size caps, before parsing", async () => {
    const handler = build({ limits: { maxCompressedBytes: 200, maxDecompressedBytes: 400 } });
    expect((await handler(post(JSON.stringify(otlp(Array.from({ length: 20 }, (_, i) => sp(i))))))).status).toBe(413);
    expect(store.persist).not.toHaveBeenCalled();
  });
});

describe("POST /api/otlp/v1/traces: server faults and logs", () => {
  const connectionFailure = () => Object.assign(new NeonDbError("Error connecting to database: fetch failed"), { sourceError: new TypeError("fetch failed") });

  it("503 (retryable by OTLP clients) when the database is unreachable or a partition is missing", async () => {
    const handler = build();
    store.persist.mockRejectedValueOnce(connectionFailure());
    let r = await handler(post(otlp([sp()])));
    expect([r.status, r.headers.get("retry-after")]).toEqual([503, "5"]);
    store.persist.mockRejectedValueOnce(new MissingPartitionError());
    r = await handler(post(otlp([sp()])));
    expect([r.status, r.headers.get("retry-after")]).toEqual([503, "60"]);
  });

  it("500 with a generic body for anything else", async () => {
    const handler = build();
    store.persist.mockRejectedValueOnce(new Error("kaboom internal detail"));
    const r = await handler(post(otlp([sp()])));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await body(r))).not.toContain("kaboom");
  });

  it("logs counts and ids only: no span names, error text or keys", async () => {
    const handler = build();
    await handler(post(otlp([sp(0, { name: "NAME-SENTINEL", status: { code: 2, message: "ERROR-SENTINEL bob@example.com" } })])));
    const all = logs.join("\n");
    for (const s of ["NAME-SENTINEL", "ERROR-SENTINEL", "bob@example.com", KEY.slice(3)]) expect(all, s).not.toContain(s);
    expect(all).toContain("otlp ok");
  });

  it("an email in an error never reaches the store", async () => {
    const handler = build();
    await handler(post(otlp([sp(0, { status: { code: 2, message: "failed for carol@example.com" } })])));
    expect(persisted[0]!.rows[0]!.error).toBe("failed for [redacted:email]");
  });
});
