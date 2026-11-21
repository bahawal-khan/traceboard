import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventStore, PersistResult } from "@/lib/events/store";
import { PriceBook } from "@/lib/ingest/cost";
import { UsageGate } from "@/lib/ingest/quota";
import { createLogger } from "@/lib/logger";
import { otlpGenAiOnlyFromEnv } from "@/lib/otlp/default-deps";
import { createOtlpTracesHandler, type OtlpDeps } from "@/lib/otlp/handler";
import { eventIdForSpan } from "@/lib/otlp/ids";
import { mapOtlpTraces, OTLP_LIMITS, WantedSpanCache } from "@/lib/otlp/map";
import { otlpTraceRequest } from "@/lib/otlp/schema";
import { issueCtx, type ApiKeyCtx } from "@/lib/repo/tenant";
import { parseEnv } from "@/lib/env";
import { request as pbRequest, type SpanSpec } from "./helpers/protobuf";

const PID = "11111111-1111-4111-8111-111111111111";
const PID2 = "33333333-3333-4333-8333-333333333333";
const KEY = `lm_${"K".repeat(43)}`;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const mkCtx = (pid: string) => issueCtx<ApiKeyCtx>({ kind: "apiKey", ownerId: null, projectIds: [pid], keyId: "22222222-2222-4222-8222-222222222222", scopes: ["ingest"], readOnly: false });
const TRACE = "5b8efff798038103d269b633813fc60c";
const sid = (i: number) => (i + 1).toString(16).padStart(16, "0");
const T = BigInt(NOW - 60_000) * BigInt(1_000_000);

/** Spec of a span: id number, parent id number, and whether it carries a GenAI attribute. */
const S = (id: number, parent: number | null, ai: boolean, extra: Partial<SpanSpec> = {}): SpanSpec => ({
  traceId: TRACE, spanId: sid(id), ...(parent !== null ? { parent: sid(parent) } : {}), name: `s${id}`, start: T, end: T + BigInt(1_000_000),
  attrs: ai ? { "gen_ai.operation.name": "chat", "gen_ai.request.model": "m" } : { "http.method": "GET" }, ...extra,
});
const toJson = (spans: SpanSpec[]) => ({
  resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: spans.map((s) => ({
    traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parent, name: s.name, startTimeUnixNano: s.start!.toString(), endTimeUnixNano: s.end?.toString(), status: s.status,
    attributes: Object.entries(s.attrs ?? {}).map(([key, v]) => ({ key, value: { stringValue: String(v) } })),
  })) }] }],
});
const mapIds = (spans: SpanSpec[], opts: Parameters<typeof mapOtlpTraces>[1]) => {
  const r = mapOtlpTraces(otlpTraceRequest.parse(toJson(spans)), opts);
  return { names: r.events.map((e) => e.name), filtered: r.filtered, rejected: r.rejected };
};

describe("GenAI-only filter: which spans are kept", () => {
  it("keeps AI spans, drops the rest, and does not report the dropped ones as rejections", () => {
    const r = mapIds([S(1, null, true), S(2, null, false), S(3, null, false)], { genAiOnly: true });
    expect(r.names).toEqual(["s1"]);
    expect(r.filtered).toBe(2);
    expect(r.rejected).toEqual({ over_limit: 0, bad_ids: 0, bad_time: 0, invalid: 0 });
  });
  it("off (the mapper's default): everything is kept and nothing is filtered", () => {
    expect(mapIds([S(1, null, true), S(2, null, false)], {})).toMatchObject({ names: ["s1", "s2"], filtered: 0 });
    expect(mapIds([S(1, null, true), S(2, null, false)], { genAiOnly: false })).toMatchObject({ names: ["s1", "s2"], filtered: 0 });
  });
  it("keeps the ANCESTORS of a kept span so the tree stays intact, in any arrival order", () => {
    // root(plain) > mid(plain) > llm(AI); sibling(plain) of mid; child(plain) of llm
    const spans = [S(4, 3, false) /* child of llm */, S(3, 2, true) /* llm */, S(2, 1, false) /* mid */, S(1, null, false) /* root */, S(5, 1, false) /* sibling */];
    const r = mapIds(spans, { genAiOnly: true });
    expect(r.names.sort()).toEqual(["s1", "s2", "s3"]);
    expect(r.filtered).toBe(2); // the descendant and the sibling are not ancestors of anything kept
  });
  it("a parent cycle cannot hang the walk", () => {
    const r = mapIds([S(1, 2, true), S(2, 1, false)], { genAiOnly: true });
    expect(r.names.sort()).toEqual(["s1", "s2"]);
  });
  it("a long chain of ancestors is kept (no depth limit that could cut a tree)", () => {
    const chain = Array.from({ length: 300 }, (_, i) => S(i + 1, i === 0 ? null : i, i === 299));
    expect(mapIds(chain, { genAiOnly: true }).names).toHaveLength(300);
  });
  it("OpenInference, OpenLLMetry and llm.* attributes all count; look-alike prefixes do not", () => {
    const withAttr = (k: string): SpanSpec => S(1, null, false, { attrs: { [k]: "x" } });
    for (const k of ["openinference.span.kind", "traceloop.span.kind", "llm.model_name", "gen_ai.system"]) expect(mapIds([withAttr(k)], { genAiOnly: true }).names, k).toEqual(["s1"]);
    for (const k of ["gen_aix.foo", "llmx.foo", "my.llm.thing", "genai.x", "http.url"]) expect(mapIds([withAttr(k)], { genAiOnly: true }).names, k).toEqual([]);
  });
  it("spans that cannot be mapped: a plain one is filtered, an AI one is rejected", () => {
    const r = mapIds([S(1, null, false, { start: BigInt(0) }), S(2, null, true, { start: BigInt(0) }), S(3, null, true)], { genAiOnly: true });
    expect(r.names).toEqual(["s3"]);
    expect(r.filtered).toBe(1);
    expect(r.rejected.bad_time).toBe(1);
  });
});

describe("GenAI-only filter: ancestors that arrive in a LATER request", () => {
  const opts = (wanted: WantedSpanCache, projectId = PID) => ({ genAiOnly: true, wanted, projectId });

  it("a kept span's missing parent is remembered and kept when it arrives, and so on up the chain", () => {
    const wanted = new WantedSpanCache();
    expect(mapIds([S(3, 2, true)], opts(wanted)).names).toEqual(["s3"]); // parent s2 not here yet
    expect(mapIds([S(2, 1, false)], opts(wanted)).names).toEqual(["s2"]); // kept because s3 pointed at it
    expect(mapIds([S(1, null, false)], opts(wanted)).names).toEqual(["s1"]); // and s2 pointed at s1
    expect(mapIds([S(9, null, false)], opts(wanted)).names).toEqual([]); // an unrelated plain span is still dropped
  });
  it("without the memory (a different instance) the late ancestor is simply dropped: a missing parent, not an error", () => {
    mapIds([S(3, 2, true)], opts(new WantedSpanCache()));
    expect(mapIds([S(2, 1, false)], opts(new WantedSpanCache())).names).toEqual([]);
  });
  it("the memory is per project", () => {
    const wanted = new WantedSpanCache();
    mapIds([S(3, 2, true)], opts(wanted, PID));
    expect(mapIds([S(2, 1, false)], opts(wanted, PID2)).names).toEqual([]);
    expect(mapIds([S(2, 1, false)], opts(wanted, PID)).names).toEqual(["s2"]);
  });
  it("entries expire and the memory is bounded", () => {
    let t = 0;
    const c = new WantedSpanCache(3, 1000, () => t);
    c.add("a"); c.add("b"); c.add("c"); c.add("d");
    expect([c.has("a"), c.has("b"), c.has("d"), c.size]).toEqual([false, true, true, 3]); // oldest evicted
    t = 1001;
    expect([c.has("b"), c.has("d"), c.size]).toEqual([false, false, 1]); // expired (c is still counted until it is looked at)
  });
  it("re-adding refreshes the position and the expiry", () => {
    let t = 0;
    const c = new WantedSpanCache(2, 1000, () => t);
    c.add("a"); c.add("b"); t = 500; c.add("a"); c.add("c"); // b is now the oldest
    expect([c.has("a"), c.has("b"), c.has("c")]).toEqual([true, false, true]);
    t = 1200;
    expect(c.has("a")).toBe(true); // refreshed at 500, expires at 1500
  });
});

// ---- the handler ----------------------------------------------------------------------------------------------------
const okResult = (o: Partial<PersistResult> = {}): PersistResult => ({ inserted: 1, contentStored: 0, contentDropped: 0, usage: { events: 1, requests: 1, costMicro: 0 }, signals: { lastViewedAt: null, conserve: false }, budgets: [], ...o });
let persisted: Array<Array<Record<string, unknown>>>;
let logs: string[];
let store: EventStore & { persist: ReturnType<typeof vi.fn> };
function build(over: Partial<OtlpDeps> = {}) {
  persisted = [];
  logs = [];
  store = {
    persist: vi.fn(async (_c: ApiKeyCtx, rows: readonly unknown[]) => {
      persisted.push([...rows] as Array<Record<string, unknown>>);
      return okResult({ inserted: rows.length });
    }),
  };
  const deps: OtlpDeps = {
    authenticate: vi.fn(async () => ({ ok: true as const, ctx: mkCtx(PID) })),
    quota: new UsageGate(async () => null, { eventsPerDay: 1000, requestsPerDay: 100 }, { now: () => NOW }),
    prices: new PriceBook(async () => [], 60_000, () => NOW),
    store,
    touchKey: vi.fn(async () => true),
    afterResponse: () => {},
    now: () => NOW,
    random: () => 0,
    log: createLogger({}, { minLevel: "debug", sink: (l) => void logs.push(l) }),
    ...over,
  };
  return createOtlpTracesHandler(deps);
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/otlp/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...headers },
    body: body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
  });
const postPb = (spans: SpanSpec[], headers: Record<string, string> = {}) => post(pbRequest(spans), { "content-type": "application/x-protobuf", ...headers });
beforeEach(() => vi.restoreAllMocks());

describe("GenAI-only filter in the route (default ON)", () => {
  it("is ON unless switched off: plain spans are dropped, the answer is a clean 200 {} and nothing is rejected", async () => {
    const handler = build(); // genAiOnly not given -> default true
    const r = await handler(post(toJson([S(1, null, true), S(2, null, false), S(3, null, false)])));
    expect([r.status, await r.json()]).toEqual([200, {}]); // filtered spans are NOT in rejectedSpans
    expect(persisted[0]!.map((x) => x.name)).toEqual(["s1"]);
    expect(logs.join("\n")).toMatch(/"filtered":2/);
  });
  it("a request whose spans are all filtered writes nothing at all", async () => {
    const handler = build();
    const r = await handler(post(toJson([S(1, null, false), S(2, null, false)])));
    expect([r.status, await r.json()]).toEqual([200, {}]);
    expect(store.persist).not.toHaveBeenCalled();
  });
  it("switched off, every span is stored", async () => {
    const handler = build({ genAiOnly: false });
    await handler(post(toJson([S(1, null, true), S(2, null, false)])));
    expect(persisted[0]).toHaveLength(2);
  });
  it("real rejections are still reported next to filtered spans", async () => {
    const handler = build();
    const r = await handler(post(toJson([S(1, null, true), S(2, null, false), S(3, null, true, { traceId: "zz" })])));
    expect(await r.json()).toMatchObject({ partialSuccess: { rejectedSpans: "1" } });
  });
  it("the memory lives across requests of one handler (late ancestors)", async () => {
    const handler = build();
    await handler(post(toJson([S(3, 2, true)])));
    await handler(post(toJson([S(2, 1, false)])));
    expect(persisted.flat().map((x) => x.name)).toEqual(["s3", "s2"]);
  });
  it("kept ancestors have their deterministic ids", async () => {
    const handler = build();
    await handler(post(toJson([S(2, 1, true), S(1, null, false)]))); // AI child, plain parent
    expect(persisted[0]!.map((x) => x.eventId).sort()).toEqual([eventIdForSpan(TRACE, sid(1)), eventIdForSpan(TRACE, sid(2))].sort());
  });
});

describe("OTLP_GENAI_ONLY configuration", () => {
  it("only the literal false turns the filter off; unset or a typo keeps it on (protects the quota)", () => {
    expect([undefined, "", "true", "TRUE", "flase", "0", "off"].map((v) => otlpGenAiOnlyFromEnv({ OTLP_GENAI_ONLY: v }))).toEqual([true, true, true, true, true, true, true]);
    expect([otlpGenAiOnlyFromEnv({ OTLP_GENAI_ONLY: "false" }), otlpGenAiOnlyFromEnv({ OTLP_GENAI_ONLY: " False " })]).toEqual([false, false]);
  });
  it("the env schema accepts true/false, defaults to true and rejects typos at boot", () => {
    const base = {
      DATABASE_URL: "postgres://x", CLERK_SECRET_KEY: "k", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "p", CRON_SECRET: "c".repeat(16), JOB_HMAC_SECRET: "j".repeat(32),
      PROVIDER_KEY_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    };
    expect(parseEnv(base).OTLP_GENAI_ONLY).toBe("true");
    expect(parseEnv({ ...base, OTLP_GENAI_ONLY: "false" }).OTLP_GENAI_ONLY).toBe("false");
    expect(() => parseEnv({ ...base, OTLP_GENAI_ONLY: "flase" })).toThrow(/OTLP_GENAI_ONLY/);
  });
});

describe("protobuf requests in the route", () => {
  const llm = (id: number, extra: Partial<SpanSpec> = {}): SpanSpec => S(id, null, true, { attrs: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "m", "gen_ai.usage.input_tokens": 100 }, ...extra });

  it("200 with the protobuf content type and an EMPTY body on full success; the rows equal the JSON route's", async () => {
    const spans = [llm(1), llm(2, { status: { code: 2, message: "bad bob@example.com" } })];
    const rp = await build({ genAiOnly: false })(postPb(spans));
    expect([rp.status, rp.headers.get("content-type"), (await rp.arrayBuffer()).byteLength]).toEqual([200, "application/x-protobuf", 0]);
    const protoRows = persisted[0]!;
    await build({ genAiOnly: false })(post(toJson(spans)));
    const jsonRows = persisted[0]!;
    // the JSON helper above has no status: compare the parts both carry
    expect(protoRows.map((x) => [x.eventId, x.name, x.inputTokens, x.status])).toEqual([[jsonRows[0]!.eventId, "s1", 100, "ok"], [jsonRows[1]!.eventId, "s2", 100, "error"]]);
    expect(protoRows[1]!.error).toBe("bad [redacted:email]");
  });

  it("partial success is answered in protobuf: partial_success{rejected_spans, error_message}", async () => {
    const r = await build({ genAiOnly: false })(postPb([llm(1), llm(2, { traceId: "abcd" })]));
    expect([r.status, r.headers.get("content-type")]).toEqual([200, "application/x-protobuf"]);
    const b = Buffer.from(await r.arrayBuffer());
    expect([b[0], b[2], b[3]]).toEqual([0x0a, 0x08, 1]); // partial_success { rejected_spans = 1 ...
    expect(b.toString("utf8")).toContain("bad_ids=1");
  });

  it("gzip-compressed protobuf (what exporters send with compression on)", async () => {
    const r = await build({ genAiOnly: false })(post(gzipSync(pbRequest([llm(1)])), { "content-type": "application/x-protobuf", "content-encoding": "gzip" }));
    expect(r.status).toBe(200);
    expect(persisted[0]).toHaveLength(1);
  });

  it("malformed protobuf is a 400 with a generic body and persists nothing", async () => {
    const handler = build();
    for (const bytes of [[0x0a, 0x05, 1], [0x0b], [0x00], [0x0a, ...Array(12).fill(0xff)]]) {
      const r = await handler(post(Uint8Array.from(bytes), { "content-type": "application/x-protobuf" }));
      expect(r.status, String(bytes)).toBe(400);
      expect(await r.json()).toMatchObject({ error: "invalid_request" });
    }
    expect(store.persist).not.toHaveBeenCalled();
  });

  it("an empty protobuf body is a 400 (malformed), like an empty JSON body", async () => {
    expect((await build()(post(new Uint8Array(0), { "content-type": "application/x-protobuf" }))).status).toBe(400);
  });

  it("the same size caps apply: 413 over the wire limit, and gzip bombs stop at the inflated limit", async () => {
    const handler = build({ limits: { maxCompressedBytes: 300, maxDecompressedBytes: 600 } });
    const big = pbRequest(Array.from({ length: 40 }, (_, i) => llm(i + 1)));
    expect((await handler(post(big, { "content-type": "application/x-protobuf" }))).status).toBe(413);
    const bomb = gzipSync(Buffer.alloc(100_000, 0x0a));
    expect(bomb.length).toBeLessThan(300);
    expect((await handler(post(bomb, { "content-type": "application/x-protobuf", "content-encoding": "gzip" }))).status).toBe(413);
  });

  it("the span cap applies: spans past 512 are counted as rejected, the first 512 are stored", async () => {
    const handler = build({ genAiOnly: false });
    const many = Array.from({ length: OTLP_LIMITS.maxSpansPerRequest + 5 }, (_, i) => llm(i + 1));
    const r = await handler(postPb(many));
    expect(persisted[0]).toHaveLength(OTLP_LIMITS.maxSpansPerRequest);
    expect(Buffer.from(await r.arrayBuffer()).toString("utf8")).toContain("over_limit=5");
  });

  it("the filter applies to protobuf too", async () => {
    const handler = build();
    const r = await handler(postPb([llm(1), S(2, null, false)]));
    expect([r.status, (await r.arrayBuffer()).byteLength]).toEqual([200, 0]); // filtered: no partial success
    expect(persisted[0]!.map((x) => x.name)).toEqual(["s1"]);
  });

  it("errors stay JSON even for protobuf requests, and carry Retry-After", async () => {
    const handler = build({ authenticate: async () => ({ ok: false, status: 429, error: "rate_limited", retryAfterSec: 3 }) });
    const r = await handler(postPb([llm(1)]));
    expect([r.status, r.headers.get("retry-after"), r.headers.get("content-type")]).toEqual([429, "3", expect.stringContaining("application/json")]);
  });

  it("fuzz through the whole route: hostile protobuf bodies only ever answer 400 or 200", async () => {
    const handler = build();
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 300; i++) {
      const b = Uint8Array.from({ length: 1 + Math.floor(rnd() * 200) }, () => Math.floor(rnd() * 256));
      const r = await handler(post(b, { "content-type": "application/x-protobuf" }));
      expect([200, 400]).toContain(r.status);
    }
  });
});
