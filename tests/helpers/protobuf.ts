/** A tiny protobuf ENCODER for tests: hand-built OTLP messages, so the decoder is checked against bytes it did not produce. */
export const varint = (n: number | bigint): number[] => {
  let v = BigInt(n);
  if (v < BigInt(0)) v = BigInt.asUintN(64, v);
  const out: number[] = [];
  while (v >= BigInt(0x80)) {
    out.push(Number(v & BigInt(0x7f)) | 0x80);
    v >>= BigInt(7);
  }
  out.push(Number(v));
  return out;
};
export const tag = (no: number, wire: number): number[] => varint(no * 8 + wire);
export const len = (no: number, body: ArrayLike<number>): number[] => [...tag(no, 2), ...varint(body.length), ...Array.from(body)];
export const str = (no: number, s: string): number[] => len(no, Buffer.from(s, "utf8"));
export const vint = (no: number, n: number | bigint): number[] => [...tag(no, 0), ...varint(n)];
export const fix64 = (no: number, n: bigint): number[] => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt.asUintN(64, n));
  return [...tag(no, 1), ...b];
};
export const dbl = (no: number, d: number): number[] => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(d);
  return [...tag(no, 1), ...b];
};
export const fix32 = (no: number, n: number): number[] => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return [...tag(no, 5), ...b];
};

export type Val = string | number | bigint | boolean | { double: number };
export const anyValue = (v: Val): number[] =>
  typeof v === "string" ? str(1, v) : typeof v === "boolean" ? vint(2, v ? 1 : 0) : typeof v === "number" || typeof v === "bigint" ? vint(3, v) : dbl(4, v.double);
export const keyValue = (key: string, v: Val): number[] => [...str(1, key), ...len(2, anyValue(v))];
export const attr = (fieldNo: number, key: string, v: Val): number[] => len(fieldNo, keyValue(key, v));

export interface SpanSpec {
  traceId?: string;
  spanId?: string;
  parent?: string;
  name?: string;
  start?: bigint;
  end?: bigint;
  attrs?: Record<string, Val>;
  status?: { code: number; message?: string };
  events?: Array<{ name: string; attrs?: Record<string, Val> }>;
  extra?: number[];
}
const hex = (h: string) => Array.from(Buffer.from(h, "hex"));
export function span(s: SpanSpec): number[] {
  return [
    ...(s.traceId ? len(1, hex(s.traceId)) : []),
    ...(s.spanId ? len(2, hex(s.spanId)) : []),
    ...(s.parent ? len(4, hex(s.parent)) : []),
    ...(s.name !== undefined ? str(5, s.name) : []),
    ...vint(6, 1), // kind
    ...(s.start !== undefined ? fix64(7, s.start) : []),
    ...(s.end !== undefined ? fix64(8, s.end) : []),
    ...Object.entries(s.attrs ?? {}).flatMap(([k, v]) => attr(9, k, v)),
    ...(s.events ?? []).flatMap((e) => len(11, [...fix64(1, BigInt(1)), ...str(2, e.name), ...Object.entries(e.attrs ?? {}).flatMap(([k, v]) => attr(3, k, v))])),
    ...(s.status ? len(15, [...(s.status.message ? str(2, s.status.message) : []), ...vint(3, s.status.code)]) : []),
    ...(s.extra ?? []),
  ];
}
/** ExportTraceServiceRequest with one ResourceSpans / ScopeSpans holding the spans. */
export function request(spans: SpanSpec[] | number[][], resource: Record<string, Val> = { "service.name": "agent" }): Uint8Array {
  const encoded = spans.map((s) => (Array.isArray(s) ? s : span(s as SpanSpec)));
  const scope = [...len(1, str(1, "scope")), ...encoded.flatMap((b) => len(2, b))];
  const rs = [...len(1, Object.entries(resource).flatMap(([k, v]) => attr(1, k, v))), ...len(2, scope)];
  return Uint8Array.from(len(1, rs));
}
