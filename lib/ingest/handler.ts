import { isConnectionError } from "@/lib/errors/connection";
import { MissingPartitionError, type EventStore } from "@/lib/events/store";
import { budgetVerdict } from "@/lib/guard/verdict";
import type { ApiKeyAuthOutcome } from "@/lib/http/api-key-request";
import { json } from "@/lib/http/respond";
import { logger, type Logger } from "@/lib/logger";
import { requestIdFrom } from "@/lib/request-id";
import type { ApiKeyCtx } from "@/lib/repo/tenant";
import { BodyError, readIngestBody, type BodyLimits } from "./body";
import type { PriceBook } from "./cost";
import { flushHintMs } from "./hint";
import { normalizeEvents } from "./normalize";
import type { UsageGate } from "./quota";
import { ingestBody, INGEST_LIMITS } from "./validate";

export interface IngestDeps {
  /** Per-IP limiter, cached key auth, scope and per-key limiter (lib/http/api-key-request.ts). */
  authenticate: (request: Request) => Promise<ApiKeyAuthOutcome>;
  quota: UsageGate;
  prices: PriceBook;
  store: EventStore;
  /** Stamps api_keys.last_used_at; returns false on failure. Runs after the response. */
  touchKey: (ctx: ApiKeyCtx) => Promise<boolean>;
  /** Schedules work after the response is sent (Next `after`). */
  afterResponse: (work: () => Promise<void>) => void;
  now?: () => number;
  random?: () => number;
  limits?: BodyLimits;
  log?: Logger;
}

const DEFAULT_LIMITS: BodyLimits = {
  maxCompressedBytes: INGEST_LIMITS.maxBodyBytes,
  maxDecompressedBytes: INGEST_LIMITS.maxBodyBytes,
};

/**
 * POST /api/ingest (docs/ARCHITECTURE.md section 2). Every failure answers a generic body plus the request id;
 * details go to the log, never to the client, and never include payloads, headers or keys.
 *
 *  401 unauthorized | 403 forbidden (no ingest scope) | 429 rate_limited / quota_exceeded (Retry-After)
 *  413 payload_too_large | 415 unsupported | 400 invalid_json | 422 invalid_request (schema)
 *  503 service_unavailable (database unreachable or a missing events partition) | 500 internal
 *  202 { accepted, duplicates, rejected: [{event_id, reason}], guard, flush_hint_ms }
 * Rejected events (ts outside now +/- 24h) are final: the SDK must not resend them.
 */
export function createIngestHandler(deps: IngestDeps) {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? DEFAULT_LIMITS;

  return async function POST(request: Request): Promise<Response> {
    const requestId = requestIdFrom(request.headers);
    const log = (deps.log ?? logger).child({ requestId, route: "ingest" });
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

      const parsed = ingestBody.safeParse(raw);
      if (!parsed.success) return fail(422, "invalid_request");

      await deps.prices.ready();
      const { accepted, rejected } = normalizeEvents(parsed.data.events, deps.prices, now());

      let inserted = 0;
      let verdict = budgetVerdict([]);
      let signals = null;
      if (accepted.length > 0) {
        const result = await deps.store.persist(ctx, accepted);
        inserted = result.inserted;
        signals = result.signals;
        verdict = budgetVerdict(result.budgets);
        if (result.usage) deps.quota.record(projectId, result.usage);
        deps.afterResponse(async () => {
          if (!(await deps.touchKey(ctx))) log.warn("last_used_at update failed", { projectId });
        });
      }

      log.info("ingest ok", {
        projectId,
        received: parsed.data.events.length,
        accepted: accepted.length,
        inserted,
        rejected: rejected.length,
        ms: now() - started,
      });
      return json(
        { accepted: accepted.length, duplicates: accepted.length - inserted, rejected, guard: verdict, flush_hint_ms: flushHintMs(signals, now(), deps.random) },
        202,
        requestId,
      );
    } catch (err) {
      if (err instanceof MissingPartitionError) {
        // Operational fault, not a client error: the daily job did not create the partition in time.
        log.error("events partition missing: run ensure_event_partitions (daily job health check)", { requestId });
        return fail(503, "service_unavailable", { "Retry-After": "60" });
      }
      if (isConnectionError(err)) {
        log.warn("database unreachable", { requestId });
        return fail(503, "service_unavailable", { "Retry-After": "5" });
      }
      log.error("ingest failed", { err });
      return fail(500, "internal");
    }
  };
}
