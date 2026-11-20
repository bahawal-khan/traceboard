import type { PriceBook } from "./cost";
import { microToUsdString } from "./cost";
import { redactText } from "./redact";
import type { IngestEvent } from "./validate";

/**
 * `ts` must be within now +/- 24h (docs/DATA_MODEL.md section 2). Events outside the window are
 * REJECTED individually, never clamped: the idempotency key is unique(project_id, event_id,
 * occurred_at), and a clamped `ts` would change on every retry and could insert the same event twice.
 */
export const TS_WINDOW_MS = 24 * 60 * 60 * 1000;

export const REJECT_REASONS = ["ts_too_old", "ts_in_future"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export type RejectedEvent = { event_id: string; reason: RejectReason };

export type NormalizedEvent = {
  eventId: string;
  occurredAt: Date;
  traceId: string | null;
  spanId: string | null;
  parentId: string | null;
  threadId: string | null;
  kind: string;
  name: string | null;
  model: string | null;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  latencyMs: number | null;
  ttftMs: number | null;
  /** Integer micro-USD for rollups; null (never 0) when the model is unknown or has no token counts. */
  costMicro: number | null;
  /** numeric(12,6) text for `events.cost_usd`. */
  costUsd: string | null;
  status: string;
  error: string | null;
  promptHash: string | null;
  argsHash: string | null;
  userIdHash: string | null;
  tags: string[] | null;
  /** Passed through; the persist step stores it only if the project enabled capture. */
  content: { input?: string; output?: string } | null;
};

export type NormalizeResult = { accepted: NormalizedEvent[]; rejected: RejectedEvent[] };

/** Same bounds as the Python SDK: the redaction patterns are quadratic on long digit runs, so the input is capped first. */
export const ERROR_MAX_CHARS = 500;
export const ERROR_REDACT_INPUT_CHARS = 4_096;

/**
 * The free-text error (usually an exception message) is redacted before it is stored, whichever client
 * sent it. Order: cap the input, redact, THEN cut to 500 (a secret cut in half by the limit must not
 * survive as a prefix). Pure and deterministic, so a retried event is stored identically.
 */
export function sanitizeError(error: string | undefined): string | null {
  if (error === undefined) return null;
  let out = redactText(error.slice(0, ERROR_REDACT_INPUT_CHARS)).text;
  if (out.length > ERROR_MAX_CHARS) {
    out = out.slice(0, ERROR_MAX_CHARS);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1); // never end on half a surrogate pair
  }
  return out;
}

/** Null when `ts` is inside the window, else the reason. The window edges are inclusive. */
export function checkTs(ts: Date, now: number): RejectReason | null {
  const t = ts.getTime();
  if (t < now - TS_WINDOW_MS) return "ts_too_old";
  if (t > now + TS_WINDOW_MS) return "ts_in_future";
  return null;
}

/**
 * Validated events -> rows ready for persistEvents, plus a per-event rejection list (the route
 * answers 202 { accepted, rejected }; the SDK must not resend rejected events). Pure apart from the
 * price lookup: the caller awaits `prices.ready()` first. Cost is computed here, never by the client.
 */
export function normalizeEvents(events: readonly IngestEvent[], prices: PriceBook, now: number = Date.now()): NormalizeResult {
  const accepted: NormalizedEvent[] = [];
  const rejected: RejectedEvent[] = [];
  for (const e of events) {
    const occurredAt = new Date(e.ts);
    const reason = checkTs(occurredAt, now);
    if (reason) {
      rejected.push({ event_id: e.event_id, reason });
      continue;
    }
    // Cached is a subset of the input total. If the total is missing, or cached exceeds it,
    // the result is deterministic: no total -> null; cached above total -> capped at the total.
    const cached = e.cached_tokens === undefined || e.input_tokens === undefined ? null : Math.min(e.cached_tokens, e.input_tokens);
    const micro = prices.cost(e.model, e.input_tokens, e.output_tokens, cached ?? 0);
    accepted.push({
      eventId: e.event_id,
      occurredAt,
      traceId: e.trace_id ?? null,
      spanId: e.span_id ?? null,
      parentId: e.parent_id ?? null,
      threadId: e.thread_id ?? null,
      kind: e.kind,
      name: e.name ?? null,
      model: e.model ?? null,
      provider: e.provider ?? null,
      inputTokens: e.input_tokens ?? null,
      outputTokens: e.output_tokens ?? null,
      cachedTokens: cached,
      latencyMs: e.latency_ms ?? null,
      ttftMs: e.ttft_ms ?? null,
      costMicro: micro,
      costUsd: micro === null ? null : microToUsdString(micro),
      status: e.status,
      error: sanitizeError(e.error),
      promptHash: e.prompt_hash ?? null,
      argsHash: e.args_hash ?? null,
      userIdHash: e.user_id_hash ?? null,
      tags: e.tags ?? null,
      content: e.content ?? null,
    });
  }
  return { accepted, rejected };
}
