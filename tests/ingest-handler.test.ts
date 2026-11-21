import { NeonDbError } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissingPartitionError, type EventStore, type PersistResult } from "@/lib/events/store";
import { PriceBook } from "@/lib/ingest/cost";
import { createIngestHandler, type IngestDeps } from "@/lib/ingest/handler";
import { UsageGate } from "@/lib/ingest/quota";
import { createLogger } from "@/lib/logger";
import { issueCtx, type ApiKeyCtx } from "@/lib/repo/tenant";

const PID = "11111111-1111-4111-8111-111111111111";
const KEY = `lm_${"K".repeat(43)}`;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const ctx = issueCtx<ApiKeyCtx>({ kind: "apiKey", ownerId: null, projectIds: [PID], keyId: "22222222-2222-4222-8222-222222222222", scopes: ["ingest"], readOnly: false });
const ev = (o: Record<string, unknown> = {}) => ({ event_id: randomUUID(), ts: "2026-11-20T11:59:00Z", ...o });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...headers },
    body: typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
  });

const okResult = (o: Partial<PersistResult> = {}): PersistResult => ({
  inserted: 1,
  contentStored: 0, contentDropped: 0,
  usage: { events: 1, requests: 1, costMicro: 0 },
  signals: { lastViewedAt: null, conserve: false },
  budgets: [],
  ...o,
});

let logs: string[];
let persisted: Array<{ rows: unknown[] }>;
let afterWork: Array<() => Promise<void>>;
let store: EventStore & { persist: ReturnType<typeof vi.fn> };
let deps: IngestDeps;

function build(over: Partial<IngestDeps> = {}) {
  persisted = [];
  afterWork = [];
  logs = [];
  store = {
    persist: vi.fn(async (_c: ApiKeyCtx, rows: readonly unknown[]) => {
      persisted.push({ rows: [...rows] });
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
    log: createLogger({}, { minLevel: "debug", sink: (l) => void logs.push(l) }),
    ...over,
  };
  return createIngestHandler(deps);
}
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/ingest: content cap", () => {
  it("adds content_dropped to the 202 only when the daily content cap cut content off", async () => {
    const handler = build();
    store.persist.mockImplementationOnce(async (_c: ApiKeyCtx, rows: readonly unknown[]) => okResult({ inserted: rows.length, contentDropped: 3 }));
    const capped = await body(await handler(post({ events: [ev()] })));
    expect(capped.content_dropped).toBe(3);
    const normal = await body(await handler(post({ events: [ev()] })));
    expect(normal).not.toHaveProperty("content_dropped");
  });
});

describe("POST /api/ingest: success", () => {
  it("answers 202 with accepted, duplicates, rejected, guard and flush_hint_ms; prices events on the server", async () => {
    const handler = build();
    const r = await handler(post({ events: [ev({ model: "claude-sonnet-5-5", input_tokens: 1000, output_tokens: 500 }), ev()] }));
    expect(r.status).toBe(202);
    expect(await body(r)).toEqual({ accepted: 2, duplicates: 0, rejected: [], guard: { status: "ok", exceeded: [] }, flush_hint_ms: 10_000 });
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const rows = persisted[0]!.rows as Array<{ costMicro: number | null }>;
    expect(rows.map((x) => x.costMicro)).toEqual([2000 + 5000, null]);
  });

  it("reports duplicates (accepted minus inserted) and refreshes the quota cache from the write", async () => {
    const handler = build();
    store.persist.mockResolvedValueOnce(okResult({ inserted: 1, usage: { events: 1000, requests: 5, costMicro: 0 } }));
    const r = await handler(post({ events: [ev(), ev()] }));
    expect(await body(r)).toMatchObject({ accepted: 2, duplicates: 1 });
    // The write reported 1000 events today, so the very next request is refused without any usage read.
    expect((await handler(post({ events: [ev()] }))).status).toBe(429);
  });

  it("echoes a safe caller request id and mints one otherwise", async () => {
    const handler = build();
    expect((await handler(post({ events: [ev()] }, { "x-request-id": "abc-12345678" }))).headers.get("x-request-id")).toBe("abc-12345678");
    expect((await handler(post({ events: [ev()] }, { "x-request-id": "bad id!" }))).headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("accepts a gzip body", async () => {
    const handler = build();
    const r = await handler(post(gzipSync(JSON.stringify({ events: [ev(), ev(), ev()] })), { "content-encoding": "gzip" }));
    expect(r.status).toBe(202);
    expect((await body(r)).accepted).toBe(3);
  });

  it("schedules last_used_at AFTER the response and logs a warning if it fails", async () => {
    const handler = build();
    await handler(post({ events: [ev()] }));
    expect(deps.touchKey).not.toHaveBeenCalled(); // not before the response is returned
    expect(afterWork).toHaveLength(1);
    await afterWork[0]!();
    expect(deps.touchKey).toHaveBeenCalledWith(ctx);
    expect(logs.join("\n")).not.toContain("last_used_at");

    (deps.touchKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    await handler(post({ events: [ev()] }));
    await afterWork[1]!();
    expect(logs.join("\n")).toContain("last_used_at update failed");
  });

  it("passes the budget facts through as the guard verdict", async () => {
    const handler = build();
    store.persist.mockResolvedValueOnce(
      okResult({ budgets: [{ budgetId: "b1", scope: "project", period: "day", limitUsd: "5", action: "block", periodKey: "2026-11-20", spentMicro: 5_100_000 }] }),
    );
    const r = await body(await handler(post({ events: [ev()] })));
    expect(r.guard).toMatchObject({ status: "block", exceeded: [{ budget_id: "b1", action: "block", spent_micro: 5_100_000 }] });
  });

  it("derives flush_hint_ms from what the write learned: live viewer 1 s, conserve 60 s", async () => {
    const handler = build();
    store.persist.mockResolvedValueOnce(okResult({ signals: { lastViewedAt: new Date(NOW - 3000), conserve: false } }));
    expect((await body(await handler(post({ events: [ev()] })))).flush_hint_ms).toBe(1000);
    store.persist.mockResolvedValueOnce(okResult({ signals: { lastViewedAt: new Date(NOW), conserve: true } }));
    expect((await body(await handler(post({ events: [ev()] })))).flush_hint_ms).toBe(60_000);
  });
});

describe("POST /api/ingest: timestamps", () => {
  it("rejects only the events outside now +/- 24h, individually, and persists the rest", async () => {
    const handler = build();
    const old = ev({ ts: "2026-11-10T00:00:00Z" });
    const future = ev({ ts: "2026-12-30T00:00:00Z" });
    const good = ev();
    const r = await body(await handler(post({ events: [old, good, future] })));
    expect(r).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(r.rejected).toEqual([
      { event_id: old.event_id, reason: "ts_too_old" },
      { event_id: future.event_id, reason: "ts_in_future" },
    ]);
    expect(persisted[0]!.rows).toHaveLength(1);
  });

  it("202 with accepted 0 and NO database write when every event is rejected", async () => {
    const handler = build();
    const r = await handler(post({ events: [ev({ ts: "2026-01-01T00:00:00Z" })] }));
    expect(r.status).toBe(202);
    expect(await body(r)).toMatchObject({ accepted: 0, rejected: [{ reason: "ts_too_old" }], flush_hint_ms: 10_000 });
    expect(store.persist).not.toHaveBeenCalled();
    expect(afterWork).toHaveLength(0);
  });
});

describe("POST /api/ingest: refusals (generic bodies, request id, nothing written)", () => {
  const generic = async (r: Response, status: number, error: string) => {
    expect(r.status).toBe(status);
    const b = await body(r);
    expect(Object.keys(b).sort()).toEqual(["error", "requestId"]);
    expect(b.error).toBe(error);
    expect(r.headers.get("x-request-id")).toBe(b.requestId);
    expect(store.persist).not.toHaveBeenCalled();
  };

  it("401 for an unknown key (with WWW-Authenticate), 403 without the scope, and the body is never read", async () => {
    const handler = build({ authenticate: vi.fn(async () => ({ ok: false as const, status: 401 as const, error: "unauthorized" as const })) });
    const req = post({ events: [ev()] });
    const r = await handler(req);
    await generic(r, 401, "unauthorized");
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
    expect(req.bodyUsed).toBe(false);
    const h2 = build({ authenticate: vi.fn(async () => ({ ok: false as const, status: 403 as const, error: "forbidden" as const })) });
    await generic(await h2(post({ events: [ev()] })), 403, "forbidden");
  });

  it("429 from the limiters carries Retry-After and reads no body", async () => {
    const handler = build({ authenticate: vi.fn(async () => ({ ok: false as const, status: 429 as const, error: "rate_limited" as const, retryAfterSec: 7 })) });
    const req = post({ events: [ev()] });
    const r = await handler(req);
    await generic(r, 429, "rate_limited");
    expect(r.headers.get("retry-after")).toBe("7");
    expect(req.bodyUsed).toBe(false);
  });

  it("429 quota_exceeded (events or requests) with Retry-After until UTC midnight, before the body is read", async () => {
    const quota = new UsageGate(async () => ({ events: 1000, requests: 1, costMicro: 0 }), { eventsPerDay: 1000, requestsPerDay: 100 }, { now: () => NOW });
    const handler = build({ quota });
    const req = post({ events: [ev()] });
    const r = await handler(req);
    expect(r.status).toBe(429);
    expect(await body(r)).toMatchObject({ error: "quota_exceeded", limit: "events" });
    expect(r.headers.get("retry-after")).toBe(String(12 * 3600)); // 12:00 -> next 00:00 UTC
    expect(req.bodyUsed).toBe(false);
    expect(store.persist).not.toHaveBeenCalled();
    const rq = build({ quota: new UsageGate(async () => ({ events: 1, requests: 100, costMicro: 0 }), { eventsPerDay: 1000, requestsPerDay: 100 }, { now: () => NOW }) });
    expect(await body(await rq(post({ events: [ev()] })))).toMatchObject({ limit: "requests" });
  });

  it("413 for an oversized body, plain or gzip bomb", async () => {
    const handler = build();
    await generic(await handler(post("x".repeat(300_000))), 413, "payload_too_large");
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(256_000);
    await generic(await handler(post(bomb, { "content-encoding": "gzip" })), 413, "payload_too_large");
  });

  it("415 for the wrong content type or encoding, 400 for malformed JSON", async () => {
    const handler = build();
    await generic(await handler(post("{}", { "content-type": "text/plain" })), 415, "unsupported");
    await generic(await handler(post("{}", { "content-encoding": "br" })), 415, "unsupported");
    await generic(await handler(post("{broken")), 400, "invalid_json");
    await generic(await handler(post("not gzip", { "content-encoding": "gzip" })), 400, "invalid_json");
  });

  it("422 for schema violations, without echoing anything from the input", async () => {
    const handler = build();
    const bad: unknown[] = [
      {},
      { events: [] },
      { events: [{ event_id: "nope", ts: "2026-11-20T11:59:00Z" }] },
      { events: [{ event_id: randomUUID() }] }, // ts is required
      { events: [ev({ cost_usd: 1 })] }, // clients cannot set cost
      { events: [ev({ project_id: randomUUID() })] }, // clients cannot choose a project
      { events: Array.from({ length: 101 }, () => ev()) },
      { events: [ev()], extra: "SECRET-INPUT-VALUE" },
    ];
    for (const b of bad) {
      const r = await handler(post(b));
      expect(r.status, JSON.stringify(b).slice(0, 60)).toBe(422);
      expect(JSON.stringify(await body(r))).not.toContain("SECRET-INPUT-VALUE");
    }
    expect(store.persist).not.toHaveBeenCalled();
  });
});

describe("POST /api/ingest: server faults", () => {
  const connectionFailure = () => Object.assign(new NeonDbError("Error connecting to database: fetch failed"), { sourceError: new TypeError("fetch failed") });

  it("503 with Retry-After 5 when the database is unreachable", async () => {
    const handler = build();
    store.persist.mockRejectedValueOnce(connectionFailure());
    const r = await handler(post({ events: [ev()] }));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect(await body(r)).toMatchObject({ error: "service_unavailable" });
  });

  it("503 also when reading usage fails", async () => {
    const handler = build({ quota: new UsageGate(async () => Promise.reject(connectionFailure()), { eventsPerDay: 10, requestsPerDay: 10 }) });
    expect((await handler(post({ events: [ev()] }))).status).toBe(503);
  });

  it("503 with Retry-After 60 and a clear error log for a missing events partition", async () => {
    const handler = build();
    store.persist.mockRejectedValueOnce(new MissingPartitionError());
    const r = await handler(post({ events: [ev()] }));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(await body(r)).toEqual({ error: "service_unavailable", requestId: r.headers.get("x-request-id") });
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.level === "error");
    expect(line.msg).toMatch(/partition missing/);
    expect(line.requestId).toBe(r.headers.get("x-request-id"));
  });

  it("500 with a generic body for anything else; the cause goes to the log only", async () => {
    const handler = build();
    store.persist.mockRejectedValueOnce(new Error("kaboom internal detail"));
    const r = await handler(post({ events: [ev()] }));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await body(r))).not.toContain("kaboom");
    expect(logs.join("\n")).toContain("kaboom internal detail");
  });
});

describe("POST /api/ingest: logs never contain payloads, keys or content", () => {
  it("logs counts and ids only", async () => {
    const handler = build();
    await handler(post({ events: [ev({ model: "claude-sonnet-5-5", error: "PAYLOAD-SENTINEL", name: "NAME-SENTINEL", content: { input: "PROMPT-SENTINEL" } })] }));
    store.persist.mockRejectedValueOnce(new Error("boom"));
    await handler(post({ events: [ev({ name: "NAME-SENTINEL-2" })] }));
    const all = logs.join("\n");
    for (const secret of [KEY, KEY.slice(3), "PAYLOAD-SENTINEL", "NAME-SENTINEL", "PROMPT-SENTINEL", "Bearer"]) expect(all, secret).not.toContain(secret);
    expect(all).toContain("ingest ok");
    expect(all).toContain(PID);
  });
});
