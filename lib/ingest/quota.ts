import type { UsageToday } from "@/lib/events/store";
import type { ApiKeyCtx } from "@/lib/repo/tenant";
import { TtlCache } from "@/lib/ttl-cache";

export interface UsageLimits {
  eventsPerDay: number;
  requestsPerDay: number;
}

export type QuotaResult = { ok: true } | { ok: false; reason: "events" | "requests"; retryAfterSec: number };

const DAY_MS = 86_400_000;
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Daily quota gate (events/day and ingest requests/day per project, docs/DATA_MODEL.md section 6).
 *
 * Reads are cached per instance for `ttlMs` (10 s) and refreshed for free from every successful write
 * (the ingest statement returns today's counters), so a busy instance almost never queries usage_daily.
 * The check is deliberately approximate: counters are per-instance-stale and concurrent requests pass
 * together, so a project can overshoot by up to one batch (100 events) plus a few in-flight requests.
 * The day is the UTC receipt day (the same day `usage_daily` uses).
 */
export class UsageGate {
  private readonly cache: TtlCache<UsageToday>;
  private readonly now: () => number;

  constructor(
    private readonly read: (ctx: ApiKeyCtx) => Promise<UsageToday | null>,
    private readonly limits: UsageLimits,
    opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.cache = new TtlCache(opts.maxEntries ?? 1_000, opts.ttlMs ?? 10_000, this.now);
  }

  private key(projectId: string): string {
    return `${projectId}|${utcDay(this.now())}`;
  }

  async check(ctx: ApiKeyCtx): Promise<QuotaResult> {
    const projectId = ctx.projectIds[0]!;
    const key = this.key(projectId);
    let usage = this.cache.get(key);
    if (!usage) {
      usage = (await this.read(ctx)) ?? { events: 0, requests: 0, costMicro: 0 };
      this.cache.set(key, usage);
    }
    const reason = usage.requests >= this.limits.requestsPerDay ? "requests" : usage.events >= this.limits.eventsPerDay ? "events" : null;
    if (!reason) return { ok: true };
    const t = this.now();
    const toMidnight = Math.ceil((Math.floor(t / DAY_MS) * DAY_MS + DAY_MS - t) / 1000);
    return { ok: false, reason, retryAfterSec: Math.max(1, toMidnight) };
  }

  /** Refresh the cache from the counters a successful write returned. */
  record(projectId: string, usage: UsageToday): void {
    this.cache.set(this.key(projectId), usage);
  }
}
