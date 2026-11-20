import { ApiKeyAuthenticator } from "@/lib/api-key-auth";
import { looksLikeApiKey, type ApiKeyScope } from "@/lib/api-key";
import { clientIp } from "@/lib/http/ip";
import { RATE_LIMITS } from "@/lib/quotas";
import { TokenBucketLimiter, type FailureBudget, type RateLimiter } from "@/lib/ratelimit";
import { ctxFromApiKey } from "@/lib/repo/ctx";
import type { ApiKeyCtx } from "@/lib/repo/tenant";

export type ApiKeyAuthOutcome =
  | { ok: true; ctx: ApiKeyCtx }
  | { ok: false; status: 401 | 403 | 429; error: "unauthorized" | "forbidden" | "rate_limited"; retryAfterSec?: number };

export interface ApiKeyAuthDeps {
  ipLimiter: RateLimiter;
  keyLimiter: RateLimiter;
  /** Per-IP budget spent only by failed authentications. */
  failureBudget: FailureBudget;
  authenticator: Pick<ApiKeyAuthenticator, "authenticate" | "cached">;
}

let defaults: ApiKeyAuthDeps | undefined;
function defaultDeps(): ApiKeyAuthDeps {
  defaults ??= {
    ipLimiter: new TokenBucketLimiter({ burst: RATE_LIMITS.ipBurst, refillPerSec: RATE_LIMITS.ipRefillPerSec }),
    keyLimiter: new TokenBucketLimiter({ burst: RATE_LIMITS.keyBurst, refillPerSec: RATE_LIMITS.keyRefillPerSec }),
    failureBudget: new TokenBucketLimiter({ burst: RATE_LIMITS.ipFailureBurst, refillPerSec: RATE_LIMITS.ipFailureRefillPerSec }),
    authenticator: new ApiKeyAuthenticator(ctxFromApiKey),
  };
  return defaults;
}

const BEARER = /^Bearer[ \t]+(\S+)$/i;

export function bearerToken(request: Pick<Request, "headers">): string | null {
  const m = BEARER.exec(request.headers.get("authorization") ?? "");
  return m ? m[1]! : null;
}

const retryAfter = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * Order matters:
 *  1. per-IP limiter, BEFORE any key hashing or database lookup (key guessing cannot reach Neon);
 *  2. per-IP FAILURE budget, peeked (not spent), but ONLY for requests that could need a database
 *     lookup: a well-formed key that is not a positive-cache hit (a cache miss or a negative-cache
 *     hit). A valid cached key causes no database access, so it skips this check entirely; otherwise
 *     one bad actor on a shared egress IP could block other customers' valid traffic. Missing or
 *     malformed keys need no lookup either and simply get 401;
 *  3. Bearer token, then the cached authenticator (401 for missing, malformed, unknown, revoked);
 *  4. required scope (403);
 *  5. per-key limiter (429), for every authenticated request, cached or not.
 * The failure budget is spent only by a well-formed key that needed a lookup and is unknown, revoked or
 * lacks the scope (a cached wrong-scope key causes no lookup, so it spends nothing). Successes, a per-key 429 and malformed keys never spend it.
 * A database failure is not turned into a 401: it propagates so the route can answer 503.
 * Requests without a usable IP share one "unknown" bucket (Vercel always sets the header).
 */
export async function authenticateApiKeyRequest(
  request: Request,
  scope: ApiKeyScope,
  deps: ApiKeyAuthDeps = defaultDeps(),
): Promise<ApiKeyAuthOutcome> {
  const ipKey = clientIp(request) ?? "unknown";
  const ip = deps.ipLimiter.check(ipKey);
  if (!ip.ok) return { ok: false, status: 429, error: "rate_limited", retryAfterSec: retryAfter(ip.retryAfterMs) };

  const token = bearerToken(request);
  const wellFormed = token !== null && looksLikeApiKey(token);
  const wasCached = wellFormed && deps.authenticator.cached(token) !== undefined;
  if (wellFormed && !wasCached) {
    const blocked = deps.failureBudget.peek(ipKey);
    if (!blocked.ok) return { ok: false, status: 429, error: "rate_limited", retryAfterSec: retryAfter(blocked.retryAfterMs) };
  }

  const ctx = await deps.authenticator.authenticate(token);
  if (!ctx) {
    if (wellFormed) deps.failureBudget.consume(ipKey);
    return { ok: false, status: 401, error: "unauthorized" };
  }
  if (!ctx.scopes.includes(scope)) {
    // Only a wrong-scope key that needed a lookup spends the budget; a cached one costs nothing.
    if (!wasCached) deps.failureBudget.consume(ipKey);
    return { ok: false, status: 403, error: "forbidden" };
  }

  const key = deps.keyLimiter.check(ctx.keyId);
  if (!key.ok) return { ok: false, status: 429, error: "rate_limited", retryAfterSec: retryAfter(key.retryAfterMs) };
  return { ok: true, ctx };
}
