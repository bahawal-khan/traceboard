import type { OtlpTraceRequest } from "./schema";

/**
 * A minimal protobuf reader for OTLP traces (ExportTraceServiceRequest, opentelemetry-proto v1). It decodes ONLY the
 * fields the mapper reads and skips everything else by wire type, so it cannot be tricked by unknown or future fields.
 *
 * Safety by construction (the input is untrusted):
 *  - it never allocates from a declared length: a length-delimited field is a `subarray` VIEW of the input, checked
 *    against the bytes that are really left before it is used, and strings are decoded from at most STRING_BYTES of it;
 *  - nesting is fixed by the schema (request > resource spans > scope spans > span > event / attribute > value), unknown
 *    nested messages are skipped by length without recursion, so deep nesting cannot overflow the stack;
 *  - varints are at most 10 bytes, tags are at most 32 bits, groups and reserved wire types are errors;
 *  - counts are capped (containers, attributes, events) and spans beyond `maxSpans` are counted, not decoded;
 *  - every error is a `ProtoError`; `decodeTraceRequest` never throws.
 *
 * Field numbers (opentelemetry/proto/trace/v1/trace.proto, common/v1/common.proto, resource/v1/resource.proto):
 *  ExportTraceServiceRequest{resource_spans=1}  ResourceSpans{resource=1, scope_spans=2}  Resource{attributes=1}
 *  ScopeSpans{spans=2}  Span{trace_id=1, span_id=2, parent_span_id=4, name=5, start_time_unix_nano=7 (fixed64),
 *  end_time_unix_nano=8 (fixed64), attributes=9, events=11, status=15}  Span.Event{name=2, attributes=3}
 *  Status{message=2, code=3}  KeyValue{key=1, value=2}  AnyValue{string=1, bool=2, int=3, double=4, array=5, kvlist=6, bytes=7}
 * The response is ExportTraceServiceResponse{partial_success=1}{rejected_spans=1, error_message=2}.
 */
export class ProtoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtoError";
  }
}

export const PROTO_LIMITS = {
  resourceSpans: 256,
  scopeSpansPerResource: 256,
  scopeSpansTotal: 1024,
  attributes: 128,
  events: 32,
  /** Bytes of any string that are decoded; the mapper cuts every field shorter than this anyway. */
  stringBytes: 16_384,
} as const;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

/** A cursor over a window [pos, end) of a buffer. Reads outside the window throw. */
class Reader {
  constructor(
    readonly buf: Uint8Array,
    public pos: number,
    readonly end: number,
  ) {}

  get done(): boolean {
    return this.pos >= this.end;
  }

  /** A varint as a safe integer (tags, lengths, enums). */
  uint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new ProtoError("truncated varint");
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * mul;
      if (!Number.isSafeInteger(result)) throw new ProtoError("varint too large");
      if ((b & 0x80) === 0) return result;
      mul *= 128;
    }
    throw new ProtoError("varint too long");
  }

  /** A full 64-bit varint (int64 values). Exactly the first 10 bytes are allowed. */
  big(): bigint {
    let result = BigInt(0);
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new ProtoError("truncated varint");
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << BigInt(7 * i);
      if ((b & 0x80) === 0) return BigInt.asUintN(64, result);
    }
    throw new ProtoError("varint too long");
  }

  fixed64(): bigint {
    if (this.end - this.pos < 8) throw new ProtoError("truncated fixed64");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getBigUint64(0, true);
    this.pos += 8;
    return v;
  }

  double(): number {
    if (this.end - this.pos < 8) throw new ProtoError("truncated double");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  /** The payload of a length-delimited field as a view (no copy). The length is checked against the bytes really left. */
  bytes(): Reader {
    const len = this.uint();
    if (len > this.end - this.pos) throw new ProtoError("length exceeds the remaining bytes");
    const r = new Reader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.big();
        return;
      case WIRE_FIXED64:
        if (this.end - this.pos < 8) throw new ProtoError("truncated fixed64");
        this.pos += 8;
        return;
      case WIRE_LEN:
        this.bytes();
        return;
      case WIRE_FIXED32:
        if (this.end - this.pos < 4) throw new ProtoError("truncated fixed32");
        this.pos += 4;
        return;
      default:
        throw new ProtoError("unsupported wire type"); // groups (3, 4) and the reserved 6, 7
    }
  }

  /** The next field header, or null at the end of the window. */
  field(): { no: number; wire: number } | null {
    if (this.done) return null;
    const tag = this.uint();
    if (tag > 0xffffffff) throw new ProtoError("tag too large");
    const no = Math.floor(tag / 8);
    if (no === 0) throw new ProtoError("field number 0");
    return { no, wire: tag % 8 };
  }

  text(): string {
    const slice = this.buf.subarray(this.pos, Math.min(this.end, this.pos + PROTO_LIMITS.stringBytes));
    this.pos = this.end;
    return UTF8.decode(slice);
  }

  hex(expectedBytes: number): string {
    const out = this.end - this.pos === expectedBytes ? Buffer.from(this.buf.subarray(this.pos, this.end)).toString("hex") : "";
    this.pos = this.end;
    return out;
  }
}

type Json = Record<string, unknown>;

const UTF8 = new TextDecoder("utf-8", { fatal: false });

function anyValue(r: Reader): Json | undefined {
  let out: Json | undefined;
  for (let f = r.field(); f; f = r.field()) {
    if (f.no === 1 && f.wire === WIRE_LEN) out = { stringValue: r.bytes().text() };
    else if (f.no === 2 && f.wire === WIRE_VARINT) out = { boolValue: r.big() !== BigInt(0) };
    else if (f.no === 3 && f.wire === WIRE_VARINT) out = { intValue: BigInt.asIntN(64, r.big()).toString() };
    else if (f.no === 4 && f.wire === WIRE_FIXED64) out = { doubleValue: r.double() };
    else r.skip(f.wire); // array, kvlist and bytes values are not used
  }
  return out;
}

function keyValue(r: Reader): Json | null {
  let key = "";
  let value: Json | undefined;
  for (let f = r.field(); f; f = r.field()) {
    if (f.no === 1 && f.wire === WIRE_LEN) key = r.bytes().text();
    else if (f.no === 2 && f.wire === WIRE_LEN) value = anyValue(r.bytes());
    else r.skip(f.wire);
  }
  return key ? { key, value } : null;
}

/** Appends a decoded attribute to `into` while fewer than the cap are kept; the rest are skipped. */
function addAttribute(into: Json[], r: Reader): void {
  if (into.length >= PROTO_LIMITS.attributes) return;
  const kv = keyValue(r);
  if (kv) into.push(kv);
}

function event(r: Reader): Json {
  const out: Json = {};
  const attributes: Json[] = [];
  for (let f = r.field(); f; f = r.field()) {
    if (f.no === 2 && f.wire === WIRE_LEN) out.name = r.bytes().text();
    else if (f.no === 3 && f.wire === WIRE_LEN) addAttribute(attributes, r.bytes());
    else r.skip(f.wire);
  }
  out.attributes = attributes;
  return out;
}

function status(r: Reader): Json {
  const out: Json = {};
  for (let f = r.field(); f; f = r.field()) {
    if (f.no === 2 && f.wire === WIRE_LEN) out.message = r.bytes().text();
    else if (f.no === 3 && f.wire === WIRE_VARINT) out.code = Number(r.big() & BigInt(0xffff));
    else r.skip(f.wire);
  }
  return out;
}

function span(r: Reader): Json {
  const out: Json = {};
  const attributes: Json[] = [];
  const events: Json[] = [];
  for (let f = r.field(); f; f = r.field()) {
    if (f.no === 1 && f.wire === WIRE_LEN) out.traceId = r.bytes().hex(16);
    else if (f.no === 2 && f.wire === WIRE_LEN) out.spanId = r.bytes().hex(8);
    else if (f.no === 4 && f.wire === WIRE_LEN) out.parentSpanId = r.bytes().hex(8);
    else if (f.no === 5 && f.wire === WIRE_LEN) out.name = r.bytes().text();
    else if (f.no === 7 && f.wire === WIRE_FIXED64) out.startTimeUnixNano = r.fixed64().toString();
    else if (f.no === 8 && f.wire === WIRE_FIXED64) out.endTimeUnixNano = r.fixed64().toString();
    else if (f.no === 9 && f.wire === WIRE_LEN) addAttribute(attributes, r.bytes());
    else if (f.no === 11 && f.wire === WIRE_LEN) {
      const e = r.bytes();
      if (events.length < PROTO_LIMITS.events) events.push(event(e));
    } else if (f.no === 15 && f.wire === WIRE_LEN) out.status = status(r.bytes());
    else r.skip(f.wire);
  }
  out.attributes = attributes;
  out.events = events;
  return out;
}

interface Budget {
  spansLeft: number;
  overflow: number;
  scopeSpans: number;
}

function scopeSpans(r: Reader, b: Budget): Json {
  const spans: Json[] = [];
  for (let f = r.field(); f; f = r.field()) {
    if (f.no === 2 && f.wire === WIRE_LEN) {
      const s = r.bytes();
      if (b.spansLeft > 0) {
        b.spansLeft--;
        spans.push(span(s));
      } else {
        b.overflow++; // counted, never decoded
      }
    } else r.skip(f.wire);
  }
  return { spans };
}

function resourceSpans(r: Reader, b: Budget): Json {
  const attributes: Json[] = [];
  const scopes: Json[] = [];
  for (let f = r.field(); f; f = r.field()) {
    if (f.no === 1 && f.wire === WIRE_LEN) {
      const res = r.bytes();
      for (let g = res.field(); g; g = res.field()) {
        if (g.no === 1 && g.wire === WIRE_LEN) addAttribute(attributes, res.bytes());
        else res.skip(g.wire);
      }
    } else if (f.no === 2 && f.wire === WIRE_LEN) {
      const s = r.bytes();
      if (scopes.length >= PROTO_LIMITS.scopeSpansPerResource || ++b.scopeSpans > PROTO_LIMITS.scopeSpansTotal) throw new ProtoError("too many scope spans");
      scopes.push(scopeSpans(s, b));
    } else r.skip(f.wire);
  }
  return { resource: { attributes }, scopeSpans: scopes };
}

export type DecodeResult = { ok: true; request: OtlpTraceRequest; overflowSpans: number } | { ok: false; reason: string };

/**
 * Bytes -> the same JSON-shaped request the JSON route parses, so one mapper serves both encodings. Never throws.
 * Spans beyond `maxSpans` are not decoded; they are returned as `overflowSpans`.
 */
export function decodeTraceRequest(bytes: Uint8Array, maxSpans: number): DecodeResult {
  try {
    const r = new Reader(bytes, 0, bytes.length);
    const budget: Budget = { spansLeft: maxSpans, overflow: 0, scopeSpans: 0 };
    const groups: Json[] = [];
    for (let f = r.field(); f; f = r.field()) {
      if (f.no === 1 && f.wire === WIRE_LEN) {
        const rs = r.bytes();
        if (groups.length >= PROTO_LIMITS.resourceSpans) throw new ProtoError("too many resource spans");
        groups.push(resourceSpans(rs, budget));
      } else r.skip(f.wire);
    }
    return { ok: true, request: { resourceSpans: groups } as OtlpTraceRequest, overflowSpans: budget.overflow };
  } catch (err) {
    // ProtoError is the expected failure; anything else (a RangeError from an impossible view, say) is also just "bad data".
    return { ok: false, reason: err instanceof ProtoError ? err.message : "undecodable" };
  }
}

function varintBytes(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

/**
 * ExportTraceServiceResponse. Full success is the empty message. A partial success carries rejected_spans and an English
 * message (the spec: the response uses the request's content type, and a client must not retry a populated partial_success).
 */
export function encodeTraceResponse(rejectedSpans: number, errorMessage: string): Uint8Array {
  if (rejectedSpans <= 0 && !errorMessage) return new Uint8Array(0);
  const msg = Buffer.from(errorMessage.slice(0, 1000), "utf8");
  const inner = [...(rejectedSpans > 0 ? [0x08, ...varintBytes(rejectedSpans)] : []), ...(msg.length > 0 ? [0x12, ...varintBytes(msg.length), ...msg] : [])];
  return Uint8Array.from([0x0a, ...varintBytes(inner.length), ...inner]);
}
