import { createHash } from "node:crypto";

/**
 * OTLP ids: the JSON mapping carries traceId / spanId as case-insensitive HEX strings (32 / 16 characters).
 * Base64 (24 / 12 characters, what an early draft of the JSON encoding used) is also accepted: the lengths
 * cannot be confused, so being liberal here costs nothing. An all-zero id is invalid per the OTLP spec.
 */
function toHex(value: unknown, bytes: number): string | null {
  if (typeof value !== "string") return null;
  let hex: string | null = null;
  if (value.length === bytes * 2 && /^[0-9a-fA-F]+$/.test(value)) hex = value.toLowerCase();
  else if (value.length === Math.ceil((bytes * 4) / 3 / 4) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const buf = Buffer.from(value, "base64");
    if (buf.length === bytes) hex = buf.toString("hex");
  }
  if (hex === null || /^0+$/.test(hex)) return null;
  return hex;
}

export const parseTraceId = (v: unknown): string | null => toHex(v, 16);
export const parseSpanId = (v: unknown): string | null => toHex(v, 8);

/** Fixed namespace for event ids derived from OTLP spans. Never change it: it would break idempotency of re-exports. */
export const OTLP_EVENT_NAMESPACE = "6f1d5c2e-8b3a-4e57-9a0c-2d4b7e91c3a8";

/** RFC 4122 / 9562 UUID version 5 (SHA-1 of namespace bytes + name). */
export function uuidV5(name: string, namespace: string = OTLP_EVENT_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(ns).update(name, "utf8").digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Deterministic: the same span (trace id + span id) always yields the same event id, so a re-export is a duplicate, not a new row. */
export const eventIdForSpan = (traceIdHex: string, spanIdHex: string): string => uuidV5(`${traceIdHex}:${spanIdHex}`);
