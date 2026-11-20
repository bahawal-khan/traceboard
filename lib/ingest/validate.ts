import { z } from "zod";
import { QUOTAS } from "@/lib/quotas";

/**
 * Ingest contract (docs/ARCHITECTURE.md section 2). Strict: unknown keys are rejected, so a client
 * cannot smuggle a `cost_usd`, a `project_id` or any column we compute on the server.
 *
 * Token convention: `input_tokens` is the TOTAL prompt tokens, `cached_tokens` is the part of that
 * total served from the provider's cache (a subset, never added on top). OpenAI already reports it
 * this way; the Anthropic wrapper must send input + cache_read + cache_creation as the total.
 */
export const INGEST_LIMITS = {
  maxEventsPerBatch: 100,
  /** Compressed and decompressed body cap, enforced by the route before parsing (P2.5). */
  maxBodyBytes: 256_000,
  maxTokens: 10_000_000,
  maxLatencyMs: 24 * 60 * 60 * 1000,
  maxTags: 10,
} as const;

export const EVENT_KINDS = ["llm", "tool", "agent", "retrieval", "custom"] as const;
export const EVENT_STATUSES = ["ok", "error"] as const;

const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
/** Identifiers and labels: bounded, no control characters. */
const label = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL, "invalid characters");
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase sha256 hex");
const count = z.number().int().min(0).max(INGEST_LIMITS.maxTokens);
const millis = z.number().int().min(0).max(INGEST_LIMITS.maxLatencyMs);

/** Opt-in content capture: whether it is stored is decided by the project setting, not the client. */
const textBytes = z
  .string()
  .refine((s) => new TextEncoder().encode(s).length <= QUOTAS.contentCaptureBytesPerEvent, "content too long");

export const ingestEvent = z
  .object({
    event_id: z.uuid(),
    /** REQUIRED: needed for idempotency across partitions. ISO 8601 with an offset (or Z). */
    ts: z.iso.datetime({ offset: true }),
    trace_id: label(128).optional(),
    span_id: label(128).optional(),
    parent_id: label(128).optional(),
    thread_id: label(128).optional(),
    kind: z.enum(EVENT_KINDS).default("llm"),
    name: label(200).optional(),
    model: label(100).optional(),
    provider: label(50).optional(),
    input_tokens: count.optional(),
    output_tokens: count.optional(),
    cached_tokens: count.optional(),
    latency_ms: millis.optional(),
    ttft_ms: millis.optional(),
    status: z.enum(EVENT_STATUSES).default("ok"),
    error: z.string().max(500).regex(NO_CONTROL, "invalid characters").optional(),
    prompt_hash: sha256Hex.optional(),
    args_hash: sha256Hex.optional(),
    user_id_hash: sha256Hex.optional(),
    tags: z.array(label(40)).max(INGEST_LIMITS.maxTags).optional(),
    content: z.object({ input: textBytes.optional(), output: textBytes.optional() }).strict().optional(),
  })
  .strict();

export const ingestBody = z
  .object({
    events: z.array(ingestEvent).min(1).max(INGEST_LIMITS.maxEventsPerBatch),
  })
  .strict();

export type IngestEvent = z.infer<typeof ingestEvent>;
export type IngestBody = z.infer<typeof ingestBody>;
