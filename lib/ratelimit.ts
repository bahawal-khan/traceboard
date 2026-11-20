/**
 * Rate limiting seam (CLAUDE.md "keep the seams"). The only implementation is a per-instance token
 * bucket: free-tier serverless instances do not share memory, so this is a burst guard, not an
 * exact global limit. The Vercel WAF rule per IP and the DB quotas are the other layers.
 */
export type RateLimitResult = { ok: true } | { ok: false; retryAfterMs: number };

export interface RateLimiter {
  check(key: string): RateLimitResult;
}

/**
 * A budget that is only spent on failures (for example failed authentications). `peek` never spends,
 * so successes cost nothing; `consume` spends one token after a failure.
 */
export interface FailureBudget {
  peek(key: string): RateLimitResult;
  consume(key: string): void;
}

export interface TokenBucketOptions {
  /** Bucket size: the burst a caller may send at once. */
  burst: number;
  /** Tokens added per second. */
  refillPerSec: number;
  /** Bound on tracked callers; the least recently seen is dropped first. */
  maxKeys?: number;
  now?: () => number;
}

export class TokenBucketLimiter implements RateLimiter, FailureBudget {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly burst: number;
  private readonly perMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOptions) {
    if (opts.burst < 1 || opts.refillPerSec <= 0) throw new Error("TokenBucketLimiter: burst >= 1 and refillPerSec > 0 required");
    this.burst = opts.burst;
    this.perMs = opts.refillPerSec / 1000;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /** Current tokens for a key after refill (a full bucket for an unseen key). */
  private tokensAt(key: string, t: number): number {
    const prev = this.buckets.get(key);
    return prev ? Math.min(this.burst, prev.tokens + (t - prev.at) * this.perMs) : this.burst;
  }

  /** Would a token be available? Does not spend one and does not create or touch an entry. */
  peek(key: string): RateLimitResult {
    const tokens = this.tokensAt(key, this.now());
    return tokens >= 1 ? { ok: true } : { ok: false, retryAfterMs: Math.ceil((1 - tokens) / this.perMs) };
  }

  /** Spend one token if one is available; an empty bucket stays empty. */
  consume(key: string): void {
    this.check(key);
  }

  check(key: string): RateLimitResult {
    const t = this.now();
    const tokens = this.tokensAt(key, t);
    this.buckets.delete(key); // re-insert: keeps recency order for eviction
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: t });
      this.evict();
      return { ok: false, retryAfterMs: Math.ceil((1 - tokens) / this.perMs) };
    }
    this.buckets.set(key, { tokens: tokens - 1, at: t });
    this.evict();
    return { ok: true };
  }

  private evict(): void {
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
