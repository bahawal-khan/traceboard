import { hashApiKey, looksLikeApiKey } from "@/lib/api-key";
import { RATE_LIMITS } from "@/lib/quotas";
import type { ApiKeyCtx } from "@/lib/repo/tenant";
import { TtlCache } from "@/lib/ttl-cache";

export type ResolveKey = (rawKey: string) => Promise<ApiKeyCtx | null>;

export interface AuthenticatorOptions {
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * Per-instance API-key auth cache on the ingest hot path.
 *
 *  - Positive entries (sha256 -> context) live `positiveTtlMs` (60 s): this is what makes "a revoked
 *    key stops working within 60 s" true. It is an upper bound per instance; a revoked key can be
 *    served from a warm cache until its entry expires.
 *  - Negative entries (unknown or revoked hashes) live `negativeTtlMs` (30 s) so a flood of the same
 *    wrong key costs one lookup, not one per request. Side effect: a key used within 30 s BEFORE it
 *    was created is refused until the entry expires.
 *  - Concurrent lookups of the same hash share one in-flight query.
 *  - Lookup errors are never cached (the caller turns them into 503); keys with the wrong shape are
 *    refused without touching the cache or the database, so garbage cannot fill the cache.
 * The raw key is only hashed here: it is never stored or logged.
 */
export class ApiKeyAuthenticator {
  private readonly positive: TtlCache<ApiKeyCtx>;
  private readonly negative: TtlCache<true>;
  private readonly inflight = new Map<string, Promise<ApiKeyCtx | null>>();

  constructor(
    private readonly resolve: ResolveKey,
    opts: AuthenticatorOptions = {},
  ) {
    const max = opts.maxEntries ?? RATE_LIMITS.authCacheMaxEntries;
    const now = opts.now ?? Date.now;
    this.positive = new TtlCache(max, opts.positiveTtlMs ?? RATE_LIMITS.authCacheTtlMs, now);
    this.negative = new TtlCache(max, opts.negativeTtlMs ?? RATE_LIMITS.authNegativeTtlMs, now);
  }

  /**
   * The cached context for a valid key, or undefined. Pure memory: never queries, never fills a cache.
   * The request guard uses it to tell which requests would need a database lookup.
   */
  cached(rawKey: string | null | undefined): ApiKeyCtx | undefined {
    if (!rawKey || !looksLikeApiKey(rawKey)) return undefined;
    return this.positive.get(hashApiKey(rawKey));
  }

  async authenticate(rawKey: string | null | undefined): Promise<ApiKeyCtx | null> {
    if (!rawKey || !looksLikeApiKey(rawKey)) return null;
    const hash = hashApiKey(rawKey);
    const hit = this.positive.get(hash);
    if (hit) return hit;
    if (this.negative.get(hash)) return null;

    let pending = this.inflight.get(hash);
    if (!pending) {
      pending = this.resolve(rawKey)
        .then((ctx) => {
          if (ctx) this.positive.set(hash, ctx);
          else this.negative.set(hash, true);
          return ctx;
        })
        .finally(() => {
          this.inflight.delete(hash);
        });
      this.inflight.set(hash, pending);
    }
    return pending;
  }

  /** Drop everything (tests). */
  clear(): void {
    this.positive.clear();
    this.negative.clear();
  }
}
