/* eslint-disable @typescript-eslint/no-explicit-any -- these tests walk decoded protobuf JSON whose shape is exactly what is under test */
import { describe, expect, it } from "vitest";
import { HEAVY_FUZZ_TIMEOUT_MS } from "./helpers/timeouts";
import { decodeTraceRequest, encodeTraceResponse, PROTO_LIMITS } from "@/lib/otlp/proto";
import { mapOtlpTraces, OTLP_LIMITS } from "@/lib/otlp/map";
import { otlpTraceRequest } from "@/lib/otlp/schema";
import { attr, dbl, fix32, fix64, len, request, span, str, tag, varint, vint, type SpanSpec } from "./helpers/protobuf";

const TRACE = "5b8efff798038103d269b633813fc60c";
const SPAN = "eee19b7ec3c1b174";
const PARENT = "eee19b7ec3c1b173";
const T0 = BigInt("1763640000000000000");
const MAX = OTLP_LIMITS.maxSpansPerRequest;

const full: SpanSpec = {
  traceId: TRACE, spanId: SPAN, parent: PARENT, name: "chat gpt-4o", start: T0, end: T0 + BigInt(850_000_000),
  attrs: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-4o", "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 80, "gen_ai.usage.cache_read.input_tokens": 1024, "gen_ai.response.time_to_first_chunk": { double: 0.42 }, "gen_ai.request.stream": true },
  status: { code: 2, message: "boom" },
  events: [{ name: "exception", attrs: { "exception.type": "ValueError" } }],
};
/** `levels` nested length-delimited fields (field `no`) around `inner`, built in linear time (outer headers are written first). */
function nested(no: number, levels: number, inner: number[]): number[] {
  const sizes = [inner.length];
  for (let i = 0; i < levels; i++) sizes.push(sizes[i]! + tag(no, 2).length + varint(sizes[i]!).length);
  const out: number[] = [];
  for (let i = levels - 1; i >= 0; i--) out.push(...tag(no, 2), ...varint(sizes[i]!));
  for (const b of inner) out.push(b);
  return out;
}
const decode = (b: Uint8Array) => {
  const r = decodeTraceRequest(b, MAX);
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const first = (b: Uint8Array) => (decode(b).request.resourceSpans as any)[0].scopeSpans[0].spans[0];

describe("protobuf decoding: structure", () => {
  it("decodes every field the mapper reads", () => {
    const s = first(request([full]));
    expect(s).toMatchObject({
      traceId: TRACE, spanId: SPAN, parentSpanId: PARENT, name: "chat gpt-4o", startTimeUnixNano: T0.toString(), endTimeUnixNano: (T0 + BigInt(850_000_000)).toString(),
      status: { code: 2, message: "boom" },
    });
    expect(s.attributes).toContainEqual({ key: "gen_ai.usage.input_tokens", value: { intValue: "1200" } });
    expect(s.attributes).toContainEqual({ key: "gen_ai.operation.name", value: { stringValue: "chat" } });
    expect(s.attributes).toContainEqual({ key: "gen_ai.response.time_to_first_chunk", value: { doubleValue: 0.42 } });
    expect(s.attributes).toContainEqual({ key: "gen_ai.request.stream", value: { boolValue: true } });
    expect(s.events[0]).toMatchObject({ name: "exception", attributes: [{ key: "exception.type", value: { stringValue: "ValueError" } }] });
  });

  it("reads resource attributes and the span count; the request has the JSON route's shape", () => {
    const r = decode(request([full, { ...full, spanId: "0000000000000002" }], { "service.name": "svc" }));
    const rs = (r.request.resourceSpans as any)[0];
    expect(rs.resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "svc" } }]);
    expect(rs.scopeSpans[0].spans).toHaveLength(2);
    expect(otlpTraceRequest.safeParse(r.request).success).toBe(true);
  });

  it("int64 values: negative, huge and zero; UTF-8 text; invalid UTF-8 becomes a replacement character", () => {
    const attrs = { a: -5, b: BigInt("9223372036854775807"), c: 0, d: "héllo 😀" };
    const s = first(request([{ ...full, attrs }]));
    const get = (k: string) => s.attributes.find((x: any) => x.key === k).value;
    expect(get("a")).toEqual({ intValue: "-5" });
    expect(get("b")).toEqual({ intValue: "9223372036854775807" });
    expect(get("c")).toEqual({ intValue: "0" });
    expect(get("d")).toEqual({ stringValue: "héllo 😀" });
    const bad = request([span({ ...full, name: undefined, extra: len(5, [0x61, 0xff, 0xfe, 0x62]) })]);
    expect(first(bad).name).toBe("a��b");
  });

  it("an id of the wrong length decodes to an empty id (the mapper then rejects the span as bad_ids)", () => {
    const s = first(request([span({ ...full, traceId: "abcd" })]));
    expect(s.traceId).toBe("");
  });

  it("unknown fields of every wire type are skipped, including nested unknown messages", () => {
    const noise = [...vint(100, 7), ...fix64(101, BigInt(5)), ...len(102, [1, 2, 3]), ...fix32(103, 9), ...len(104, len(1, len(1, [9, 9, 9])))];
    const s = first(request([span({ ...full, extra: noise })]));
    expect(s.name).toBe("chat gpt-4o");
    // and in the containers above the span
    const req = Uint8Array.from([...noise, ...request([full])]);
    expect(decode(req).request.resourceSpans).toHaveLength(1);
  });

  it("a known field with the wrong wire type is skipped like an unknown one", () => {
    const s = first(request([span({ ...full, name: undefined, extra: [...vint(5, 99), ...len(7, [1, 2])] })])); // name as varint, start as bytes
    expect(s.name).toBeUndefined();
    expect(s.startTimeUnixNano).toBe(T0.toString());
  });

  it("array, kvlist and bytes attribute values are ignored without error", () => {
    const nested = len(9, [...str(1, "k"), ...len(2, len(5, len(1, str(1, "x"))))]);
    const s = first(request([span({ ...full, extra: nested })]));
    expect(s.attributes.some((a: any) => a.key === "k" && a.value === undefined)).toBe(true);
  });

  it("an empty request decodes to nothing", () => {
    expect(decode(new Uint8Array(0)).request.resourceSpans).toEqual([]);
  });
});

describe("protobuf and JSON give the same events (differential)", () => {
  it("the same logical request maps to identical events from both encodings", () => {
    const spans: SpanSpec[] = [
      full,
      { traceId: TRACE, spanId: "0000000000000009", name: "tool", start: T0, end: T0 + BigInt(5_000_000), attrs: { "gen_ai.operation.name": "execute_tool" }, status: { code: 1 } },
      { traceId: TRACE, spanId: "000000000000000a", name: "plain", start: T0, attrs: { "http.method": "GET" } },
    ];
    const fromProto = mapOtlpTraces(otlpTraceRequest.parse(decode(request(spans, { "service.name": "svc" })).request));
    const json = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
        scopeSpans: [{ spans: spans.map((s) => ({
          traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parent, name: s.name, startTimeUnixNano: s.start!.toString(), endTimeUnixNano: s.end?.toString(), status: s.status,
          events: (s.events ?? []).map((e) => ({ name: e.name, attributes: Object.entries(e.attrs ?? {}).map(([key, v]) => ({ key, value: { stringValue: v } })) })),
          attributes: Object.entries(s.attrs ?? {}).map(([key, v]) => ({
            key, value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : typeof v === "object" ? { doubleValue: v.double } : { intValue: String(v) },
          })),
        })) }],
      }],
    };
    expect(fromProto.events).toEqual(mapOtlpTraces(otlpTraceRequest.parse(json)).events);
    expect(fromProto.events).toHaveLength(3);
  });
});

describe("protobuf decoding: limits", { timeout: HEAVY_FUZZ_TIMEOUT_MS }, () => {
  it("spans beyond the cap are counted, not decoded", () => {
    const many = Array.from({ length: MAX + 40 }, (_, i) => span({ traceId: TRACE, spanId: (i + 1).toString(16).padStart(16, "0"), name: "s", start: T0 }));
    const r = decode(request(many));
    expect((r.request.resourceSpans as any)[0].scopeSpans[0].spans).toHaveLength(MAX);
    expect(r.overflowSpans).toBe(40);
  });

  it("100,000 tiny spans in one request stay fast and bounded (no work per span past the cap)", () => {
    const body = Uint8Array.from(len(1, len(2, Array.from({ length: 100_000 }, () => len(2, [0x28, 0x01])).flat()))); // span {field 5? no: unknown varint}
    const t = performance.now();
    const r = decode(body);
    expect(performance.now() - t).toBeLessThan(500);
    expect(r.overflowSpans).toBe(100_000 - MAX);
    expect((r.request.resourceSpans as any)[0].scopeSpans[0].spans).toHaveLength(MAX);
  });

  it("attributes and events are capped per span", () => {
    const attrs = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]));
    const events = Array.from({ length: 100 }, (_, i) => ({ name: `e${i}` }));
    const s = first(request([{ ...full, attrs, events }]));
    expect(s.attributes).toHaveLength(PROTO_LIMITS.attributes);
    expect(s.events).toHaveLength(PROTO_LIMITS.events);
  });

  it("too many resource or scope containers is an error, not a memory problem", () => {
    const one = len(1, len(2, len(2, span(full))));
    expect(decodeTraceRequest(Uint8Array.from(Array.from({ length: PROTO_LIMITS.resourceSpans + 1 }, () => one).flat()), MAX).ok).toBe(false);
    const scopes = Array.from({ length: PROTO_LIMITS.scopeSpansPerResource + 1 }, () => len(2, len(2, span(full)))).flat();
    expect(decodeTraceRequest(Uint8Array.from(len(1, scopes)), MAX).ok).toBe(false);
  });

  it("long strings are decoded only up to a bound", () => {
    const huge = "x".repeat(1_000_000);
    expect(first(request([{ ...full, name: huge }])).name.length).toBe(PROTO_LIMITS.stringBytes);
  });
});

describe("protobuf decoding: hostile input never throws and never trusts a length", { timeout: HEAVY_FUZZ_TIMEOUT_MS }, () => {
  const rejects = (bytes: number[]) => {
    const r = decodeTraceRequest(Uint8Array.from(bytes), MAX);
    expect(r.ok).toBe(false);
  };

  it("truncated, overlong and impossible varints, tags and lengths are clean failures", () => {
    rejects([0x0a]); // tag, no length
    rejects([0x0a, 0x80]); // length varint cut off
    rejects([0x0a, ...Array(11).fill(0xff), 0x01]); // varint of 12 bytes
    rejects([0x0a, 0x05, 1, 2]); // length 5, 2 bytes left
    rejects([0x0a, ...varint(BigInt(2) ** BigInt(63))]); // length 2^63
    rejects([0x0a, ...varint(BigInt(2) ** BigInt(32)), 1]); // length 2^32 with one byte behind it
    rejects([0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]); // length near 2^63 as a 9-byte varint
    rejects([0x00, 0x01]); // field number 0
    rejects([0x0b]); // start group
    rejects([0x0c]); // end group
    rejects([0x0e]); // reserved wire type 6
    rejects([0x0f]); // reserved wire type 7
    rejects([...varint(BigInt(2) ** BigInt(40)), 0]); // tag above 32 bits
    rejects([0x09, 1, 2, 3]); // fixed64 with 3 bytes
    rejects([0x0d, 1, 2]); // fixed32 with 2 bytes
  });

  it("an UNKNOWN field that claims more bytes than remain is rejected at every level, not silently accepted", () => {
    rejects([0x3a, 0x7f, 1, 2]); // field 7, length 127, 2 bytes: top level
    rejects([...len(1, [0x3a, 0x7f, 1, 2])]); // inside ResourceSpans
    rejects([...len(1, len(2, len(2, [0x3a, 0x7f, 1, 2])))]); // inside a Span
    // a child that overclaims relative to its PARENT window while the bytes exist behind it
    rejects([...len(1, [0x3a, 0x10, 1]), ...Array(40).fill(1)]);
    rejects([...len(1, [0x3a, ...varint(BigInt(2) ** BigInt(62))])]);
  });

  it("over-long (zero-padded) varints are rejected even when their value is small", () => {
    rejects([0x0a, ...Array(10).fill(0x80), 0x00]); // an 11-byte length, value 0
    rejects([...Array(10).fill(0x80), 0x00, 0x00]); // an 11-byte tag
    rejects([0x38, ...Array(10).fill(0x80), 0x00]); // an unknown varint FIELD value of 11 bytes
    expect(decodeTraceRequest(Uint8Array.from([0x38, ...Array(9).fill(0x80), 0x00]), MAX).ok).toBe(true); // 10 bytes is the maximum and fine
  });

  it("a claimed length of 2^53-1 allocates nothing and fails at once", () => {
    const before = process.memoryUsage().arrayBuffers;
    const t = performance.now();
    rejects([0x0a, ...varint(Number.MAX_SAFE_INTEGER), 1, 2, 3]);
    expect(performance.now() - t).toBeLessThan(50);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(1_000_000);
  });

  it("a child cannot read past its parent's window even if the bytes exist behind it", () => {
    // ResourceSpans claims 4 bytes but its inner ScopeSpans claims 50: must fail, not read the trailing bytes
    const bytes = [...len(1, [0x12, 50, 0, 0]), ...Array(60).fill(7)];
    rejects(bytes);
  });

  it("extreme nesting of unknown messages is skipped by length, with no recursion", () => {
    const bytes = Uint8Array.from(nested(7, 700_000, [1, 2, 3])); // about 3.5 MB of nested unknown messages
    const t = performance.now();
    const r = decodeTraceRequest(bytes, MAX);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.ok).toBe(true);
  });

  it("deeply nested array attribute values are skipped without recursion", () => {
    const v = nested(5, 200_000, str(1, "x")); // array_value inside array_value inside ...
    const body = request([span({ ...full, extra: len(9, [...str(1, "k"), ...len(2, v)]) })]);
    expect(decodeTraceRequest(body, MAX).ok).toBe(true);
  });

  it("every prefix of a valid message is either decoded or cleanly rejected", () => {
    const valid = request([full, { ...full, spanId: "0000000000000002" }]);
    for (let n = 0; n <= valid.length; n++) {
      const r = decodeTraceRequest(valid.subarray(0, n), MAX);
      expect(typeof r.ok).toBe("boolean");
    }
  });

  it("flipping any single bit of a valid message never throws", () => {
    const valid = request([full, { ...full, spanId: "0000000000000002", status: { code: 1 } }]);
    for (let i = 0; i < valid.length; i++) {
      for (let bit = 0; bit < 8; bit++) {
        const copy = Uint8Array.from(valid);
        copy[i]! ^= 1 << bit;
        const r = decodeTraceRequest(copy, MAX);
        if (r.ok) mapOtlpTraces(otlpTraceRequest.parse(r.request)); // whatever decodes must also map without throwing
      }
    }
  });

  it("random bytes, random lengths: 20,000 inputs, no throw, bounded time", () => {
    let seed = 0x9e3779b9;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const t = performance.now();
    for (let i = 0; i < 20_000; i++) {
      const n = Math.floor(rnd() * 600);
      const b = new Uint8Array(n);
      for (let j = 0; j < n; j++) b[j] = rnd() < 0.3 ? [0x0a, 0x12, 0x1a, 0x2a, 0x7f, 0x80, 0xff][Math.floor(rnd() * 7)]! : Math.floor(rnd() * 256);
      const r = decodeTraceRequest(b, MAX);
      if (r.ok) mapOtlpTraces(otlpTraceRequest.parse(r.request));
    }
    expect(performance.now() - t).toBeLessThan(15_000);
  });

  it("random STRUCTURED messages (valid wire format, random field numbers and types) never throw", () => {
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const msg = (depth: number): number[] => {
      const out: number[] = [];
      for (let i = 0, n = 1 + Math.floor(rnd() * 5); i < n; i++) {
        const no = 1 + Math.floor(rnd() * 16);
        const wire = [0, 1, 2, 5][Math.floor(rnd() * 4)]!;
        if (wire === 0) out.push(...vint(no, Math.floor(rnd() * 2 ** 40)));
        else if (wire === 1) out.push(...dbl(no, rnd()));
        else if (wire === 5) out.push(...fix32(no, Math.floor(rnd() * 2 ** 32)));
        else out.push(...len(no, depth > 0 && rnd() < 0.7 ? msg(depth - 1) : Array.from({ length: Math.floor(rnd() * 20) }, () => Math.floor(rnd() * 256))));
      }
      return out;
    };
    for (let i = 0; i < 5000; i++) {
      const r = decodeTraceRequest(Uint8Array.from(msg(6)), MAX);
      if (r.ok) mapOtlpTraces(otlpTraceRequest.parse(r.request));
    }
  });
});

describe("protobuf response", () => {
  it("full success is the empty message", () => {
    expect(encodeTraceResponse(0, "")).toHaveLength(0);
  });
  it("partial success: partial_success{rejected_spans, error_message}", () => {
    const b = Buffer.from(encodeTraceResponse(3, "3 spans rejected (bad_ids=3)"));
    const msg = Buffer.from("3 spans rejected (bad_ids=3)");
    expect([...b]).toEqual([0x0a, 2 + 1 + 1 + msg.length, 0x08, 3, 0x12, msg.length, ...msg]);
  });
  it("a warning only (zero rejected, a message) is allowed by the spec", () => {
    expect([...encodeTraceResponse(0, "hi")]).toEqual([0x0a, 4, 0x12, 2, 0x68, 0x69]);
  });
  it("large counts use multi-byte varints", () => {
    const b = encodeTraceResponse(300, "x");
    expect([...b].slice(0, 5)).toEqual([0x0a, 6, 0x08, 0xac, 0x02]);
  });
  it("round-trips through the decoder's own reader rules (tag/len structure is well-formed)", () => {
    const b = encodeTraceResponse(2, "some message");
    // outer: field 1, wire 2
    expect(b[0]).toBe(tag(1, 2)[0]);
    expect(b[1]).toBe(b.length - 2);
  });
});

describe("attr helper sanity", () => {
  it("helper encodes a key/value the decoder reads back", () => {
    const body = Uint8Array.from(len(1, len(1, attr(1, "service.name", "x"))));
    expect(((decode(body).request.resourceSpans as any)[0].resource.attributes)[0]).toEqual({ key: "service.name", value: { stringValue: "x" } });
  });
});
