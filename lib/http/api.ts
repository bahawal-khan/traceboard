import { ZodError } from "zod";
import { clientIp } from "@/lib/http/ip";
import { json } from "@/lib/http/respond";
import { isConnectionError } from "@/lib/errors/connection";
import { logger, type Logger } from "@/lib/logger";
import { requestIdFrom } from "@/lib/request-id";
import { isSameOrigin, SAFE_METHODS } from "@/lib/security/origin";
import { LimitReachedError, NotFoundError } from "@/lib/repo/errors";
import { ctxFromSession } from "@/lib/repo/ctx";
import type { SessionCtx } from "@/lib/repo/tenant";

const MAX_BODY_BYTES = 8 * 1024;

export { json };

export { clientIp };

class BadBodyError extends Error {}

/** Reads a small JSON body; anything oversized or malformed becomes a generic 400. */
export async function readJson(request: Request, opts: { optional?: boolean } = {}): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new BadBodyError();
  if (opts.optional && text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadBodyError();
  }
}

export interface SessionRouteArgs<P> {
  request: Request;
  ctx: SessionCtx;
  params: P;
  ip: string | null;
  log: Logger;
  requestId: string;
}

/**
 * Wrapper for dashboard API routes: same-origin check on mutations, session context (401 without it),
 * one place that maps errors to generic client bodies. Details go to the log with the request id.
 */
export function sessionRoute<P = Record<string, never>>(
  name: string,
  handler: (args: SessionRouteArgs<P>) => Promise<Response>,
) {
  return async (request: Request, routeCtx?: { params: Promise<P> }): Promise<Response> => {
    const requestId = requestIdFrom(request.headers);
    const log = logger.child({ requestId, route: name });
    try {
      if (!SAFE_METHODS.has(request.method) && !isSameOrigin(request)) return json({ error: "forbidden" }, 403, requestId);
      const ctx = await ctxFromSession();
      if (!ctx) return json({ error: "unauthorized" }, 401, requestId);
      const params = (routeCtx ? await routeCtx.params : {}) as P;
      return await handler({ request, ctx, params, ip: clientIp(request), log, requestId });
    } catch (err) {
      if (err instanceof ZodError) return json({ error: "invalid_request" }, 422, requestId);
      if (err instanceof BadBodyError) return json({ error: "invalid_request" }, 400, requestId);
      if (err instanceof NotFoundError) return json({ error: "not_found" }, 404, requestId);
      if (err instanceof LimitReachedError) return json({ error: "limit_reached", limit: err.limit }, 403, requestId);
      if (isConnectionError(err)) {
        // The database could not be reached (after the repo layer's one retry): transient, not a bug.
        log.warn("database unreachable", { requestId });
        return json({ error: "service_unavailable", requestId }, 503, requestId, { "Retry-After": "5" });
      }
      log.error("route failed", { err });
      return json({ error: "internal", requestId }, 500, requestId);
    }
  };
}
