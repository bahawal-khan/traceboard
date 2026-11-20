import { describe, expect, it } from "vitest";
import { eventIdForSpan, parseSpanId, parseTraceId, uuidV5 } from "@/lib/otlp/ids";
import { mapOtlpTraces, OTLP_LIMITS } from "@/lib/otlp/map";
import { otlpTraceRequest } from "@/lib/otlp/schema";
import { ingestEvent } from "@/lib/ingest/validate";

const TRACE = "5b8efff798038103d269b633813fc60c";
const SPAN = "eee19b7ec3c1b174";
const PARENT = "eee19b7ec3c1b173";
const T0 = "1763640000000000000"; // 2025-11-20T12:00:00Z in ns

type A = Record<string, string | number | boolean>;
const kv = (a: A) =>
  Object.entries(a).map(([key, v]) => ({
    key,
    value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
  }));
const span = (attrs: A = {}, over: Record<string, unknown> = {}) => ({
  traceId: TRACE, spanId: SPAN, name: "chat gpt-4o", kind: 3, startTimeUnixNano: T0, endTimeUnixNano: "1763640000850000000", attributes: kv(attrs), status: { code: 1 }, ...over,
});
const req = (spans: unknown[], resource: A = { "service.name": "my-agent" }) =>
  otlpTraceRequest.parse({ resourceSpans: [{ resource: { attributes: kv(resource) }, scopeSpans: [{ scope: { name: "x" }, spans }] }] });
const one = (attrs: A = {}, over: Record<string, unknown> = {}, resource?: A) => {
  const r = mapOtlpTraces(req([span(attrs, over)], resource));
  expect(r.rejected, JSON.stringify(r.rejected)).toEqual({ over_limit: 0, bad_ids: 0, bad_time: 0, invalid: 0 });
  return r.events[0]!;
};

describe("ids", () => {
  it("UUIDv5 matches the RFC 4122 / Python reference vector", () => {
    expect(uuidV5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });
  it("event ids are deterministic, versioned 5, and differ per span and per trace", () => {
    const a = eventIdForSpan(TRACE, SPAN);
    expect(eventIdForSpan(TRACE, SPAN)).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(eventIdForSpan(TRACE, PARENT)).not.toBe(a);
    expect(eventIdForSpan("a".repeat(32), SPAN)).not.toBe(a);
    expect(ingestEvent.shape.event_id.safeParse(a).success).toBe(true);
  });
  it("hex ids in any case, and base64 ids, are accepted; zero or wrong-length ids are not", () => {
    expect(parseTraceId(TRACE.toUpperCase())).toBe(TRACE);
    expect(parseTraceId(Buffer.from(TRACE, "hex").toString("base64"))).toBe(TRACE);
    expect(parseSpanId(Buffer.from(SPAN, "hex").toString("base64"))).toBe(SPAN);
    for (const bad of ["", "0".repeat(32), SPAN, TRACE.slice(1), "g".repeat(32), 5, null, undefined]) expect(parseTraceId(bad), String(bad)).toBeNull();
    expect(parseSpanId("0".repeat(16))).toBeNull();
    expect(parseSpanId(TRACE)).toBeNull();
  });
});

describe("OpenTelemetry GenAI spans", () => {
  it("maps a chat span: model, provider, tokens, cached, latency, ttft, ids, parent, thread, service tag", () => {
    const e = one(
      {
        "gen_ai.operation.name": "chat", "gen_ai.provider.name": "openai", "gen_ai.request.model": "gpt-4o", "gen_ai.response.model": "gpt-4o-2024-08-06",
        "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 80, "gen_ai.usage.cache_read.input_tokens": 1024,
        "gen_ai.response.time_to_first_chunk": 0.42, "gen_ai.conversation.id": "conv-9",
      },
      { parentSpanId: PARENT },
    );
    expect(e).toMatchObject({
      event_id: eventIdForSpan(TRACE, SPAN), ts: "2025-11-20T12:00:00.000Z", trace_id: TRACE, span_id: SPAN, parent_id: PARENT, thread_id: "conv-9",
      kind: "llm", name: "chat gpt-4o", model: "gpt-4o-2024-08-06", provider: "openai", input_tokens: 1200, output_tokens: 80, cached_tokens: 1024,
      latency_ms: 850, ttft_ms: 420, status: "ok", tags: ["otlp", "svc:my-agent"],
    });
  });
  it("falls back to the request model, and to the deprecated gen_ai.system / prompt_tokens names", () => {
    const e = one({ "gen_ai.request.model": "gpt-4o-mini", "gen_ai.system": "openai", "gen_ai.usage.prompt_tokens": 10, "gen_ai.usage.completion_tokens": 3 });
    expect(e).toMatchObject({ model: "gpt-4o-mini", provider: "openai", input_tokens: 10, output_tokens: 3, kind: "llm" });
  });
  it("a root span has no parent_id", () => {
    expect(one({}).parent_id).toBeUndefined();
    expect(one({}, { parentSpanId: "" }).parent_id).toBeUndefined();
    expect(one({}, { parentSpanId: "0".repeat(16) }).parent_id).toBeUndefined();
  });
  it("operation names choose the kind", () => {
    const k = (op: string) => one({ "gen_ai.operation.name": op }).kind;
    expect([k("chat"), k("embeddings"), k("execute_tool"), k("invoke_agent"), k("create_agent"), k("retrieval"), k("something_new")]).toEqual(["llm", "llm", "tool", "agent", "agent", "retrieval", "custom"]);
  });
  it("an unknown span with no AI attributes is stored as custom, a model alone makes it llm", () => {
    expect(one({ "http.method": "GET" }).kind).toBe("custom");
    expect(one({ "gen_ai.request.model": "m" }).kind).toBe("llm");
  });
});

describe("cache accounting", () => {
  it("follows the spec: input INCLUDES cached tokens, so nothing is added", () => {
    const e = one({ "gen_ai.usage.input_tokens": 1250, "gen_ai.usage.cache_read.input_tokens": 1000, "gen_ai.usage.cache_creation.input_tokens": 200 });
    expect([e.input_tokens, e.cached_tokens]).toEqual([1250, 1000]);
  });
  it("cached above the total is impossible under the spec: the instrumentor excluded cache, so the total is the sum", () => {
    const e = one({ "gen_ai.provider.name": "anthropic", "gen_ai.usage.input_tokens": 50, "gen_ai.usage.cache_read.input_tokens": 1000, "gen_ai.usage.cache_creation.input_tokens": 200 });
    expect([e.input_tokens, e.cached_tokens]).toEqual([1250, 1000]);
  });
  it("older cache attribute names are understood", () => {
    expect(one({ "gen_ai.usage.input_tokens": 100, "gen_ai.usage.cache_read_input_tokens": 40 }).cached_tokens).toBe(40);
  });
});

describe("OpenInference and OpenLLMetry spans", () => {
  it("OpenInference LLM span", () => {
    const e = one({ "openinference.span.kind": "LLM", "llm.model_name": "gpt-4o", "llm.provider": "openai", "llm.token_count.prompt": 30, "llm.token_count.completion": 7, "llm.token_count.prompt_details.cache_read": 10, "session.id": "s1" });
    expect(e).toMatchObject({ kind: "llm", model: "gpt-4o", provider: "openai", input_tokens: 30, output_tokens: 7, cached_tokens: 10, thread_id: "s1" });
  });
  it("OpenInference kinds", () => {
    const k = (v: string) => one({ "openinference.span.kind": v }).kind;
    expect([k("TOOL"), k("AGENT"), k("RETRIEVER"), k("RERANKER"), k("CHAIN"), k("EMBEDDING"), k("GUARDRAIL")]).toEqual(["tool", "agent", "retrieval", "retrieval", "custom", "llm", "custom"]);
  });
  it("OpenLLMetry kinds and gen_ai attributes", () => {
    expect(one({ "traceloop.span.kind": "tool" }).kind).toBe("tool");
    expect(one({ "traceloop.span.kind": "agent" }).kind).toBe("agent");
    expect(one({ "traceloop.span.kind": "workflow" }).kind).toBe("custom");
    expect(one({ "traceloop.span.kind": "task", "gen_ai.request.model": "m", "gen_ai.usage.input_tokens": 5 }).input_tokens).toBe(5);
  });
  it("the gen_ai operation wins over a framework kind", () => {
    expect(one({ "gen_ai.operation.name": "execute_tool", "openinference.span.kind": "LLM" }).kind).toBe("tool");
  });
});

describe("status and errors", () => {
  it("status ERROR (code 2, the string name too) becomes status=error with the message", () => {
    expect(one({}, { status: { code: 2, message: "rate limited" } })).toMatchObject({ status: "error", error: "rate limited" });
    expect(one({}, { status: { code: "STATUS_CODE_ERROR", message: "boom" } })).toMatchObject({ status: "error", error: "boom" });
    expect(one({}, { status: { code: 1 } }).status).toBe("ok");
    expect(one({}, { status: { code: 0 } }).status).toBe("ok");
    expect(one({}, { status: undefined }).status).toBe("ok");
  });
  it("redacts the error text before it is mapped (email, card, bearer token), then cuts to 500", () => {
    const e = one({}, { status: { code: 2, message: "user bob@example.com card 4111 1111 1111 1111 Bearer abcdefghijklmnopqrstuvwxyz0123" } });
    expect(e.error).toBe("user [redacted:email] card [redacted:card] [redacted:secret]");
    expect(one({}, { status: { code: 2, message: "x".repeat(490) + " alice.long@example.com" } }).error).not.toContain("alice");
  });
  it("falls back to the exception event, then to error.type", () => {
    const ev = [{ name: "exception", attributes: kv({ "exception.type": "ValueError", "exception.message": "bad input for jo@example.org" }) }];
    expect(one({}, { status: { code: 2 }, events: ev }).error).toBe("ValueError: bad input for [redacted:email]");
    expect(one({ "error.type": "TimeoutError" }, { status: { code: 2 } }).error).toBe("TimeoutError");
    expect(one({}, { status: { code: 2 } }).error).toBeUndefined();
  });
  it("an error message on a span that is not an error is ignored", () => {
    expect(one({}, { status: { code: 1, message: "fine" } }).error).toBeUndefined();
  });
});

describe("robustness", () => {
  it("control characters are cleaned and long names truncated, never rejected", () => {
    const e = one({}, { name: "line1\nline2\u0000" + "n".repeat(300) });
    expect(e.name).toMatch(/^line1 line2 n+$/);
    expect(e.name!.length).toBeLessThanOrEqual(200);
  });
  it("an over-long model or an id with control characters is dropped, not truncated", () => {
    expect(one({ "gen_ai.request.model": "m".repeat(101) }).model).toBeUndefined();
    expect(one({ "gen_ai.conversation.id": "c".repeat(129) }).thread_id).toBeUndefined();
  });
  it("accepts snake_case field names and numeric nanosecond timestamps", () => {
    const r = mapOtlpTraces(otlpTraceRequest.parse({ resource_spans: [{ scope_spans: [{ spans: [{ trace_id: TRACE, span_id: SPAN, name: "n", start_time_unix_nano: 1763640000000000000, end_time_unix_nano: 1763640000500000000 }] }] }] }));
    expect(r.events[0]).toMatchObject({ ts: "2025-11-20T12:00:00.000Z", latency_ms: 500 });
  });
  it("base64 ids map to the same event as hex ids", () => {
    const hex = one({});
    const b64 = mapOtlpTraces(req([span({}, { traceId: Buffer.from(TRACE, "hex").toString("base64"), spanId: Buffer.from(SPAN, "hex").toString("base64") })])).events[0]!;
    expect(b64.event_id).toBe(hex.event_id);
    expect(b64.trace_id).toBe(TRACE);
  });
  it("an end before the start gives no latency; a huge span is capped at 24 h", () => {
    expect(one({}, { endTimeUnixNano: "1763639999000000000" }).latency_ms).toBeUndefined();
    expect(one({}, { endTimeUnixNano: "1863640000000000000" }).latency_ms).toBe(24 * 3600 * 1000);
  });
  it("tokens that are negative, fractional strings, NaN or over the limit are dropped or rounded safely", () => {
    const e = one({ "gen_ai.usage.input_tokens": -5, "gen_ai.usage.output_tokens": 99_999_999 });
    expect([e.input_tokens, e.output_tokens]).toEqual([undefined, undefined]);
    expect(one({ "gen_ai.usage.input_tokens": 12.4 }).input_tokens).toBe(12);
  });
  it("spans with bad ids or no start time are counted as rejected, never stored", () => {
    const r = mapOtlpTraces(req([span({}, { traceId: "zz" }), span({}, { spanId: "" }), span({}, { startTimeUnixNano: "0" }), span({}, { startTimeUnixNano: undefined }), span({}, { startTimeUnixNano: "abc" }), span()]));
    expect(r.rejected).toEqual({ over_limit: 0, bad_ids: 2, bad_time: 3, invalid: 0 });
    expect(r.events).toHaveLength(1);
  });
  it("a start time beyond year 9999 (not representable as an ISO date the schema accepts) is rejected, not stored", () => {
    const r = mapOtlpTraces(req([span({}, { startTimeUnixNano: "253402300800000000000" })]));
    expect(r.events).toEqual([]);
    expect(r.rejected.invalid + r.rejected.bad_time).toBe(1);
  });
  it("caps the spans per request and counts the rest", () => {
    const spans = Array.from({ length: OTLP_LIMITS.maxSpansPerRequest + 8 }, (_, i) => span({}, { spanId: (i + 1).toString(16).padStart(16, "0") }));
    const r = mapOtlpTraces(req(spans));
    expect(r.events).toHaveLength(OTLP_LIMITS.maxSpansPerRequest);
    expect(r.rejected.over_limit).toBe(8);
  });
  it("a request with no spans maps to nothing", () => {
    expect(mapOtlpTraces(otlpTraceRequest.parse({}))).toEqual({ events: [], rejected: { over_limit: 0, bad_ids: 0, bad_time: 0, invalid: 0 } });
    expect(mapOtlpTraces(otlpTraceRequest.parse({ resourceSpans: [{ scopeSpans: [{}] }, {}] })).events).toEqual([]);
  });
  it("every mapped event is valid for the strict ingest schema", () => {
    const r = mapOtlpTraces(req([span({ "gen_ai.request.model": "m", "gen_ai.usage.input_tokens": 3 }), span({}, { spanId: PARENT, status: { code: 2, message: "e" } })]));
    for (const e of r.events) expect(ingestEvent.safeParse(e).success).toBe(true);
  });
  it("a long service name is shortened in the tag; a missing one adds no svc tag", () => {
    expect(one({}, {}, { "service.name": "s".repeat(100) }).tags!.every((t) => t.length <= 40)).toBe(true);
    expect(one({}, {}, {}).tags).toEqual(["otlp"]);
  });
});

describe("privacy", () => {
  it("never reads prompt or completion text: nothing of it can reach an event", () => {
    const secrets = ["PROMPT-SECRET-1", "COMPLETION-SECRET-2", "MSG-SECRET-3", "TOOLARG-SECRET-4", "INPUTVALUE-SECRET-5"];
    const e = one({
      "gen_ai.operation.name": "chat", "gen_ai.request.model": "m",
      "gen_ai.input.messages": secrets[0]!, "gen_ai.output.messages": secrets[1]!, "gen_ai.prompt": secrets[0]!, "gen_ai.completion": secrets[1]!,
      "llm.input_messages.0.message.content": secrets[2]!, "gen_ai.tool.call.arguments": secrets[3]!, "input.value": secrets[4]!, "output.value": secrets[4]!,
    });
    const text = JSON.stringify(e);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(e).not.toHaveProperty("content");
    expect(e).not.toHaveProperty("prompt_hash");
  });
});
