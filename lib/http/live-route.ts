import { z, ZodError } from "zod";
import type { SessionRouteArgs } from "@/lib/http/api";
import { json } from "@/lib/http/respond";
import { TokenBucketLimiter, type RateLimiter } from "@/lib/ratelimit";
import { InvalidCursorError, NotFoundError } from "@/lib/repo/errors";
import { getLiveSince, type LiveResult } from "@/lib/repo/live";
import type { TraceListItem } from "@/lib/repo/traces";
import { projectId } from "@/lib/validation/projects";

/**
 * Handler of GET /api/dashboard/projects/[id]/live?cursor=...  (the route file is a thin `sessionRoute` export of it, because
 * a Next route file may export nothing but handlers and route config). Everything else (401 without a session, 404, 503, 500, the
 * request id, the log line) comes from `sessionRoute` in lib/http/api.ts, exactly like the other dashboard routes.
 *
 * The request can only choose the project (path) and the cursor (query). getLiveSince's test hooks (nowMs, scanCap, settleMs) are
 * never passed here; tests/live-route.test.ts checks that statically.
 */

/**
 * How often a client should poll when the stream (P3.9) is not available, in milliseconds. A HINT in every answer: the client hook
 * honours it and backs off further when nothing changes. 15 s is the polling fallback in docs/ARCHITECTURE.md (a Hobby function
 * invocation is the scarcest free-tier resource: 2 s polling would be about 1,800 invocations per open view and hour).
 */
export const LIVE_POLL_MS = 15_000;

/**
 * A real cursor is base64url of {"k":"lv","v":1,"s":"<27 chars>","i":"<36 chars>"}: about 130 characters. 200 leaves margin without
 * letting a request carry a megabyte in the query string. (lib/repo/live.ts caps at 256 itself.)
 */
export const LIVE_CURSOR_MAX_CHARS = 200;

/**
 * Per signed-in user, per server instance: a burst of 10 and 1 request per second sustained, so several open tabs polling every
 * 15 s (or a tab that reconnects) never trip it. On serverless every instance has its own memory, so this is a best-effort safety
 * net against a runaway client, NOT a global guarantee (same honesty as lib/ratelimit.ts). The quota and the DB limits are the
 * real bounds.
 */
export const LIVE_RATE = { burst: 10, refillPerSec: 1, maxKeys: 5_000 } as const;
export const liveLimiter: RateLimiter = new TokenBucketLimiter(LIVE_RATE);

const cursorParam = z
  .string()
  .min(1)
  .max(LIVE_CURSOR_MAX_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/);

type Query = { ok: true; cursor: string | undefined } | { ok: false };

/**
 * `cursor` may appear at most once and, when present, must be a non-empty base64url string of at most LIVE_CURSOR_MAX_CHARS.
 * Any other query parameter is IGNORED (the other dashboard routes have no query parameters; ignoring is what Next does by default).
 */
export function parseLiveQuery(url: string): Query {
  let all: string[];
  try {
    all = new URL(url).searchParams.getAll("cursor");
  } catch {
    return { ok: false };
  }
  if (all.length === 0) return { ok: true, cursor: undefined };
  if (all.length > 1) return { ok: false };
  const parsed = cursorParam.safeParse(all[0]);
  return parsed.success ? { ok: true, cursor: parsed.data } : { ok: false };
}

function traceFields(t: TraceListItem) {
  return {
    traceId: t.traceId,
    startedAtMs: t.startedAtMs,
    durationMs: t.durationMs,
    spanCount: t.spanCount,
    errorCount: t.errorCount,
    totalTokens: t.totalTokens,
    costMicro: t.costMicro,
    costLowerBound: t.costLowerBound,
    unpricedEvents: t.unpricedEvents,
    rootName: t.rootName,
    hasRoot: t.hasRoot,
  };
}

/** Field by field on purpose: nothing a repo object grows later can reach the client unnoticed. */
export function serializeLive(r: LiveResult) {
  return {
    cursor: r.cursor,
    baseline: r.baseline,
    reset: r.reset,
    truncated: r.truncated,
    newEvents: r.newEvents,
    newErrors: r.newErrors,
    newTraces: r.newTraces,
    traces: r.traces.map(traceFields),
    pollMs: LIVE_POLL_MS,
  };
}

const NOSNIFF = { "X-Content-Type-Options": "nosniff" } as const;

export function createLiveHandler(limiter: RateLimiter) {
  return async ({ request, ctx, params, log, requestId }: SessionRouteArgs<{ id: string }>): Promise<Response> => {
    const limit = limiter.check(ctx.ownerId);
    if (!limit.ok) {
      log.warn("live rate limited", { outcome: "rate_limited" });
      return json({ error: "rate_limited" }, 429, requestId, { ...NOSNIFF, "Retry-After": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))) });
    }

    // A malformed project id is "not found", the same body as a missing, deleted or foreign project; the repo is not called.
    const pid = projectId.safeParse(params.id);
    if (!pid.success) {
      log.debug("live not found", { outcome: "not_found" });
      return json({ error: "not_found" }, 404, requestId, NOSNIFF);
    }
    const query = parseLiveQuery(request.url);
    if (!query.ok) {
      log.debug("live invalid request", { outcome: "invalid" });
      return json({ error: "invalid_request" }, 400, requestId, NOSNIFF);
    }

    let result: LiveResult;
    try {
      result = await getLiveSince(ctx, pid.data, query.cursor);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        log.debug("live invalid cursor", { outcome: "invalid" });
        return json({ error: "invalid_request" }, 400, requestId, NOSNIFF);
      }
      if (err instanceof NotFoundError) log.debug("live not found", { outcome: "not_found" });
      // The repo's own result validation failing is OUR bug, not a bad request: sessionRoute would answer 422 for a ZodError.
      if (err instanceof ZodError) throw new Error("live result invalid");
      throw err;
    }
    log.debug("live ok", { outcome: "ok" });
    return json(serializeLive(result), 200, requestId, NOSNIFF);
  };
}

export const liveHandler = createLiveHandler(liveLimiter);
