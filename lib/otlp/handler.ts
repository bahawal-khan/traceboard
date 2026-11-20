import { isConnectionError } from "@/lib/errors/connection";
import { MissingPartitionError } from "@/lib/events/store";
import { BodyError, readIngestBody, type BodyLimits } from "@/lib/ingest/body";
import type { IngestDeps } from "@/lib/ingest/handler";
import { normalizeEvents } from "@/lib/ingest/normalize";
import { json } from "@/lib/http/respond";
import { logger } from "@/lib/logger";
import { requestIdFrom } from "@/lib/request-id";
import { mapOtlpTraces, OTLP_LIMITS } from "./map";
import { otlpTraceRequest } from "./schema";

const DEFAULT_LIMITS: BodyLimits = { maxCompressedBytes: OTLP_LIMITS.maxCompressedBytes, maxDecompressedBytes: OTLP_LIMITS.maxDecompressedBytes };

/**
 * POST /api/otlp/v1/traces: OTLP/HTTP with a JSON body (`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`; the OpenTelemetry JS
 * `exporter-trace-otlp-http` class). The same API key, per-IP and per-key limiters, daily quota, price book and store as
 * /api/ingest (it takes the same deps). Protobuf bodies answer 415 until P2.10.
 *
 *  200 {}  or  200 { partialSuccess: { rejectedSpans: "<n>", errorMessage } }   (rejected spans are final: do not resend)
 *  400 invalid_json | invalid_request   413 payload_too_large   415 unsupported
 *  401 / 403 / 429 (Retry-After) as /api/ingest   503 service_unavailable (Retry-After)   500 internal
 * OTLP clients retry only 429 / 502 / 503 / 504, so permanent faults are 4xx and outages are 503.
 */
export function createOtlpTracesHandler(deps: IngestDeps) {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? DEFAULT_LIMITS;

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

      let raw: unknown;
      try {
        raw = await readIngestBody(request, limits);
      } catch (err) {
        if (err instanceof BodyError) {
          if (err.kind === "too_large") return fail(413, "payload_too_large");
          if (err.kind === "unsupported") return fail(415, "unsupported");
          return fail(400, "invalid_json");
        }
        throw err;
      }

      const parsed = otlpTraceRequest.safeParse(raw);
      if (!parsed.success) return fail(400, "invalid_request");

      const mapped = mapOtlpTraces(parsed.data);
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

      log.info("otlp ok", { projectId, accepted: accepted.length, inserted, rejected: rejectedSpans, reasons, ms: now() - started });
      if (rejectedSpans === 0) return json({}, 200, requestId);
      const detail = Object.entries(reasons).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(", ");
      return json({ partialSuccess: { rejectedSpans: String(rejectedSpans), errorMessage: `${rejectedSpans} spans rejected (${detail})` } }, 200, requestId);
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
