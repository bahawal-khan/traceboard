import { sanitizeError } from "@/lib/ingest/normalize";
import { ingestEvent, INGEST_LIMITS, type IngestEvent } from "@/lib/ingest/validate";
import { eventIdForSpan, parseSpanId, parseTraceId } from "./ids";
import type { OtlpKeyValue, OtlpSpan, OtlpTraceRequest } from "./schema";

/**
 * OTLP spans -> ingest events (docs/ARCHITECTURE.md section 5). Conventions understood, checked against their official
 * docs in P2.9 (docs/PHASES.md): OpenTelemetry GenAI (`gen_ai.*`; `gen_ai.system` and `gen_ai.usage.prompt_tokens` are
 * deprecated but still emitted by older instrumentors), OpenInference (`openinference.span.kind`, `llm.*`) and OpenLLMetry
 * (`traceloop.span.kind`, `gen_ai.*`). PRIVACY: prompt and completion text attributes (`gen_ai.input.messages`, `input.value`,
 * `llm.input_messages.*`, ...) are never read, so content cannot be stored through this route. Every produced event is
 * validated with the same strict schema as /api/ingest; a span that cannot be made valid is counted as rejected, never half-stored.
 */
export const OTLP_LIMITS = {
  /** The OpenTelemetry batch span processor sends at most 512 spans per export by default. */
  maxSpansPerRequest: 512,
  maxCompressedBytes: 1_000_000,
  /** Vercel's request body limit is 4.5 MB (verified); stay under it. */
  maxDecompressedBytes: 4_000_000,
} as const;

export type SpanReject = "over_limit" | "bad_ids" | "bad_time" | "invalid";
export type MapResult = { events: IngestEvent[]; rejected: Record<SpanReject, number> };

type Attrs = Map<string, string | number | boolean>;

function attrsOf(list: readonly OtlpKeyValue[] | undefined): Attrs {
  const out: Attrs = new Map();
  for (const kv of list ?? []) {
    const v = kv.value;
    if (!v) continue;
    const s = v.stringValue ?? v.string_value;
    const i = v.intValue ?? v.int_value;
    const d = v.doubleValue ?? v.double_value;
    const b = v.boolValue ?? v.bool_value;
    if (s !== undefined) out.set(kv.key, s);
    else if (i !== undefined) out.set(kv.key, typeof i === "number" ? i : Number(i));
    else if (d !== undefined) out.set(kv.key, d);
    else if (b !== undefined) out.set(kv.key, b);
  }
  return out;
}

const NO_CONTROL_G = /[\u0000-\u001f\u007f]/g;

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}
/** Free text (names, tags): control characters become spaces, then it is truncated. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = cut(v.replace(NO_CONTROL_G, " ").trim(), max).trim();
  return t || undefined;
}
/** Identifiers and model names: used as is or not at all (truncating could make two ids collide). */
function label(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(NO_CONTROL_G, " ").trim();
  return t && t.length <= max ? t : undefined;
}
function count(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= INGEST_LIMITS.maxTokens ? Math.round(n) : undefined;
}
const str = (a: Attrs, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = a.get(k);
    if (typeof v === "string" && v) return v;
  }
  return undefined;
};
const first = (a: Attrs, ...keys: string[]): number | undefined => {
  for (const k of keys) {
    const n = count(a.get(k));
    if (n !== undefined) return n;
  }
  return undefined;
};

const GENAI_KIND: Record<string, IngestEvent["kind"]> = {
  chat: "llm", text_completion: "llm", generate_content: "llm", embeddings: "llm",
  execute_tool: "tool", invoke_agent: "agent", create_agent: "agent", invoke_workflow: "agent", retrieval: "retrieval",
};
const OPENINFERENCE_KIND: Record<string, IngestEvent["kind"]> = {
  LLM: "llm", EMBEDDING: "llm", TOOL: "tool", AGENT: "agent", RETRIEVER: "retrieval", RERANKER: "retrieval",
};
const TRACELOOP_KIND: Record<string, IngestEvent["kind"]> = { tool: "tool", agent: "agent" };

function kindOf(a: Attrs, hasModel: boolean): IngestEvent["kind"] {
  const g = str(a, "gen_ai.operation.name");
  if (g && GENAI_KIND[g]) return GENAI_KIND[g]!;
  const o = str(a, "openinference.span.kind");
  if (o && OPENINFERENCE_KIND[o.toUpperCase()]) return OPENINFERENCE_KIND[o.toUpperCase()]!;
  const t = str(a, "traceloop.span.kind");
  if (t && TRACELOOP_KIND[t.toLowerCase()]) return TRACELOOP_KIND[t.toLowerCase()]!;
  return hasModel ? "llm" : "custom";
}

/** A nanosecond timestamp (string or number) -> BigInt, or null. */
function nanos(v: unknown): bigint | null {
  try {
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return BigInt(Math.trunc(v));
  } catch {
    /* fall through */
  }
  return null;
}

function errorTextOf(span: OtlpSpan, a: Attrs): string | undefined {
  let raw = span.status?.message;
  if (!raw) {
    for (const ev of span.events ?? []) {
      if (ev.name !== "exception") continue;
      const ea = attrsOf(ev.attributes);
      const type = str(ea, "exception.type");
      const msg = str(ea, "exception.message");
      raw = [type, msg].filter(Boolean).join(": ") || undefined;
      if (raw) break;
    }
  }
  raw ??= str(a, "error.type");
  // Same order as /api/ingest: cap the input, redact, THEN cut (a secret must not survive as a prefix of a cut).
  return raw ? (sanitizeError(raw.replace(NO_CONTROL_G, " ")) ?? undefined) : undefined;
}

const isErrorStatus = (code: unknown) => code === 2 || code === "2" || code === "STATUS_CODE_ERROR";

function mapSpan(span: OtlpSpan, service: string | undefined): { event: IngestEvent } | { reject: SpanReject } {
  const traceId = parseTraceId(span.traceId ?? span.trace_id);
  const spanId = parseSpanId(span.spanId ?? span.span_id);
  if (!traceId || !spanId) return { reject: "bad_ids" };
  const parent = parseSpanId(span.parentSpanId ?? span.parent_span_id);

  const start = nanos(span.startTimeUnixNano ?? span.start_time_unix_nano);
  if (start === null || start === BigInt(0)) return { reject: "bad_time" };
  const startMs = Number(start / BigInt(1_000_000));
  const ts = new Date(startMs);
  if (Number.isNaN(ts.getTime())) return { reject: "bad_time" };
  const end = nanos(span.endTimeUnixNano ?? span.end_time_unix_nano);
  let latencyMs: number | undefined;
  if (end !== null && end >= start) latencyMs = Math.min(Number((end - start) / BigInt(1_000_000)), INGEST_LIMITS.maxLatencyMs);

  const a = attrsOf(span.attributes);
  const model = label(str(a, "gen_ai.response.model", "gen_ai.request.model", "llm.model_name"), 100);
  const provider = label(str(a, "gen_ai.provider.name", "gen_ai.system", "llm.provider", "llm.system"), 50);

  let input = first(a, "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "llm.token_count.prompt");
  const output = first(a, "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "llm.token_count.completion");
  const cacheRead = first(a, "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_read_input_tokens", "llm.token_count.prompt_details.cache_read");
  const cacheWrite = first(a, "gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.cache_creation_input_tokens", "llm.token_count.prompt_details.cache_write");
  // The OTel convention says input tokens INCLUDE cached ones, so cached can never exceed the total. When it does, the
  // instrumentor reported Anthropic-style input (excluding cache), and the total prompt is the sum of the three.
  if (input !== undefined && cacheRead !== undefined && cacheRead > input) input = Math.min(input + cacheRead + (cacheWrite ?? 0), INGEST_LIMITS.maxTokens);

  const ttftS = a.get("gen_ai.response.time_to_first_chunk");
  const ttftMs = typeof ttftS === "number" && Number.isFinite(ttftS) && ttftS >= 0 ? Math.min(Math.round(ttftS * 1000), INGEST_LIMITS.maxLatencyMs) : undefined;

  const isError = isErrorStatus(span.status?.code);
  const thread = label(str(a, "gen_ai.conversation.id", "session.id"), 128);
  const name = text(span.name, 200);
  const error = isError ? errorTextOf(span, a) : undefined;
  const tags = ["otlp"];
  const svc = text(service, 36);
  if (svc) tags.push(`svc:${svc}`);

  const candidate = {
    event_id: eventIdForSpan(traceId, spanId),
    ts: ts.toISOString(),
    trace_id: traceId,
    span_id: spanId,
    ...(parent ? { parent_id: parent } : {}),
    ...(thread ? { thread_id: thread } : {}),
    kind: kindOf(a, model !== undefined),
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(input !== undefined ? { input_tokens: input } : {}),
    ...(output !== undefined ? { output_tokens: output } : {}),
    ...(cacheRead !== undefined ? { cached_tokens: cacheRead } : {}),
    ...(latencyMs !== undefined ? { latency_ms: latencyMs } : {}),
    ...(ttftMs !== undefined ? { ttft_ms: ttftMs } : {}),
    status: isError ? "error" : "ok",
    ...(error ? { error } : {}),
    tags,
  };
  const parsed = ingestEvent.safeParse(candidate);
  return parsed.success ? { event: parsed.data } : { reject: "invalid" };
}

export function mapOtlpTraces(req: OtlpTraceRequest): MapResult {
  const events: IngestEvent[] = [];
  const rejected: Record<SpanReject, number> = { over_limit: 0, bad_ids: 0, bad_time: 0, invalid: 0 };
  let seen = 0;
  for (const rs of req.resourceSpans ?? req.resource_spans ?? []) {
    const service = str(attrsOf(rs.resource?.attributes), "service.name");
    for (const ss of rs.scopeSpans ?? rs.scope_spans ?? []) {
      for (const sp of ss.spans ?? []) {
        if (seen++ >= OTLP_LIMITS.maxSpansPerRequest) {
          rejected.over_limit++;
          continue;
        }
        const r = mapSpan(sp, service);
        if ("event" in r) events.push(r.event);
        else rejected[r.reject]++;
      }
    }
  }
  return { events, rejected };
}
