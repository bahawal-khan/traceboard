import { isConnectionError } from "@/lib/errors/connection";
import { MissingPartitionError } from "@/lib/events/store";
import { BodyError, readBodyBytes, type BodyLimits } from "@/lib/ingest/body";
import type { IngestDeps } from "@/lib/ingest/handler";
import { normalizeEvents } from "@/lib/ingest/normalize";
import { json } from "@/lib/http/respond";
import { logger } from "@/lib/logger";
import { requestIdFrom } from "@/lib/request-id";
import { mapOtlpTraces, OTLP_LIMITS, WantedSpanCache } from "./map";
import { decodeTraceRequest, encodeTraceResponse } from "./proto";
import { otlpTraceRequest } from "./schema";

export interface OtlpDeps extends IngestDeps {
  /** Keep only GenAI / OpenInference / OpenLLMetry spans and their ancestors. Default TRUE (protects the free-tier event quota). */
  genAiOnly?: boolean;
  /** Memory of ancestors still to arrive (per instance). Default: a new one per handler. */
  wanted?: WantedSpanCache;
}

const PROTOBUF = "application/x-protobuf";

const DEFAULT_LIMITS: BodyLimits = { maxCompressedBytes: OTLP_LIMITS.maxCompressedBytes, maxDecompressedBytes: OTLP_LIMITS.maxDecompressedBytes };

/**
 * POST /api/otlp/v1/traces: OTLP/HTTP, protobuf (`application/x-protobuf`, what the Python exporter and the default
 * OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf send) or JSON (`http/json`). The same API key, per-IP and per-key limiters,
 * daily quota, price book and store as /api/ingest (it takes the same deps). The response uses the request's content type.
 *
 *  200 empty / {}  or  partial success { rejected_spans, error_message } / { partialSuccess: { rejectedSpans: "<n>", errorMessage } }
 *      (rejected spans are final: do not resend; spans left out by the GenAI-only filter are NOT rejections)
 *  400 invalid_json | invalid_request   413 payload_too_large   415 unsupported
 *  401 / 403 / 429 (Retry-After) as /api/ingest   503 service_unavailable (Retry-After)   500 internal
 * Error bodies are JSON for both encodings (exporters read only the status code and Retry-After).
 * OTLP clients retry only 429 / 502 / 503 / 504, so permanent faults are 4xx and outages are 503.
 */
export function createOtlpTracesHandler(deps: OtlpDeps) {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const genAiOnly = deps.genAiOnly ?? true;
  const wanted = deps.wanted ?? new WantedSpanCache();
  return async function POST(request: Request): Promise<Response> {
    const requestId = requestIdFrom(request.headers);
    const log = (deps.log ?? logger).child({ requestId, route: "otlp-traces" });
    const started = now();
    const fail = (status: number, error: string, headers: Record<string, string> = {}) => json({ error, requestId }, status, requestId, headers);

    try {
      const auth = await deps.authenticate(request);
      if (!auth.ok) {
        const headers: Record<string, string> = {};
        if (auth.retryAfterSec) headers["Retry-After"] = String(auth.retryAfterSec);
        if (auth.status === 401) headers["WWW-Authenticate"] = "Bearer";
        return fail(auth.status, auth.error, headers);
      }
      const ctx = auth.ctx;
      const projectId = ctx.projectIds[0]!;

      const quota = await deps.quota.check(ctx);
      if (!quota.ok) {
        log.info("quota exceeded", { projectId, quota: quota.reason });
        return json({ error: "quota_exceeded", limit: quota.reason, requestId }, 429, requestId, { "Retry-After": String(quota.retryAfterSec) });
      }

      let body: { type: string; bytes: Buffer };
      try {
        body = await readBodyBytes(request, limits, ["application/json", PROTOBUF]);
      } catch (err) {
        if (err instanceof BodyError) {
          if (err.kind === "too_large") return fail(413, "payload_too_large");
          if (err.kind === "unsupported") return fail(415, "unsupported");
          return fail(400, "invalid_json");
        }
        throw err;
      }
      const protobuf = body.type === PROTOBUF;

      let overflow = 0;
      let candidate: unknown;
      if (protobuf) {
        const decoded = decodeTraceRequest(body.bytes, OTLP_LIMITS.maxSpansPerRequest);
        if (!decoded.ok) {
          log.info("protobuf rejected", { projectId, reason: decoded.reason });
          return fail(400, "invalid_request");
        }
        candidate = decoded.request;
        overflow = decoded.overflowSpans;
      } else {
        try {
          candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
        } catch {
          return fail(400, "invalid_json");
        }
      }

      const parsed = otlpTraceRequest.safeParse(candidate);
      if (!parsed.success) return fail(400, "invalid_request");

      const mapped = mapOtlpTraces(parsed.data, { genAiOnly, wanted, projectId });
      mapped.rejected.over_limit += overflow;
      await deps.prices.ready();
      const { accepted, rejected: late } = normalizeEvents(mapped.events, deps.prices, now());
      const reasons: Record<string, number> = { ...mapped.rejected };
      for (const r of late) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
      const rejectedSpans = Object.values(reasons).reduce((a, b) => a + b, 0);

      let inserted = 0;
      if (accepted.length > 0) {
        // One statement for the whole request (the store takes any batch size): it counts as ONE ingest request in usage_daily.
        const result = await deps.store.persist(ctx, accepted);
        inserted = result.inserted;
        if (result.usage) deps.quota.record(projectId, result.usage);
        deps.afterResponse(async () => {
          if (!(await deps.touchKey(ctx))) log.warn("last_used_at update failed", { projectId });
        });
      }

      log.info("otlp ok", { projectId, encoding: protobuf ? "protobuf" : "json", accepted: accepted.length, inserted, rejected: rejectedSpans, filtered: mapped.filtered, reasons, ms: now() - started });
      const detail = Object.entries(reasons).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(", ");
      const message = rejectedSpans === 0 ? "" : `${rejectedSpans} spans rejected (${detail})`;
      if (protobuf) {
        return new Response(Buffer.from(encodeTraceResponse(rejectedSpans, message)), {
          status: 200,
          headers: { "Content-Type": PROTOBUF, "Cache-Control": "private, no-store", "x-request-id": requestId },
        });
      }
      if (rejectedSpans === 0) return json({}, 200, requestId);
      return json({ partialSuccess: { rejectedSpans: String(rejectedSpans), errorMessage: message } }, 200, requestId);
    } catch (err) {
      if (err instanceof MissingPartitionError) {
        log.error("events partition missing: run ensure_event_partitions (daily job health check)", { requestId });
        return fail(503, "service_unavailable", { "Retry-After": "60" });
      }
      if (isConnectionError(err)) {
        log.warn("database unreachable", { requestId });
        return fail(503, "service_unavailable", { "Retry-After": "5" });
      }
      log.error("otlp ingest failed", { err });
      return fail(500, "internal");
    }
  };
}
