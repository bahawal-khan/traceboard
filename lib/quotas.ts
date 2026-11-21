/**
 * Free-tier quota constants (Vercel Hobby + Neon Free). A paid plan only
 * raises these numbers. The events/day figure is DERIVED from SIZING with lib/capacity.ts
 * (tests/quotas-capacity.test.ts fails if they drift apart); see docs/DEPLOYMENT.md "Storage budget".
 */
export const QUOTAS = {
  /** 1,900 = floor to 100 of 600 MB / (1,050 B x 15 days x 20 projects) = 1,904. Derived from SIZING. */
  eventsPerDayPerProject: 1_900,
  /**
   * Cap on stored (encrypted) content rows per project per day: 200 x 8,200 B x 4 days x 20 projects = 131 MB, 13% of
   * the database at the MAXIMUM row size (2 KB in + 2 KB out), inside SIZING.contentShare (15%). NOT ENFORCED YET:
   * the ingest statement must count and cap it (P2.11); until then do not offer content capture beyond the owner.
   */
  contentRowsPerDayPerProject: 200,
  ingestRequestsPerDayPerProject: 3_000,
  projectsPerUser: 2,
  keysPerProject: 5,
  contentCaptureBytesPerEvent: 2_048,
  experimentBudgetUsdMax: 2,
  dailyEvalSpendUsdPerProject: 5,
  replaySampleCap: 200,
  datasetItemsMax: 2_000,
  /** Default only; the deployed value comes from the MAX_USERS env var. */
  defaultMaxUsers: 10,
} as const;

export const RETENTION = {
  eventsDays: 14,
  contentDays: 3,
  jobsAndAlertsDays: 30,
  minuteRollupsHours: 48,
  /** Daily job (db/migrations/0011): hourly rollups, usage_daily rows and budget_usage keys are aged out of the database. */
  hourlyRollupsDays: 90,
  usageDailyDays: 400,
  budgetDayKeysDays: 7,
  budgetMonthKeysMonths: 2,
} as const;

/**
 * Per-instance request guards (lib/ratelimit.ts) and the API-key auth cache (lib/api-key-auth.ts).
 * Serverless instances do not share memory: these are burst limits, not exact global ones.
 * The IP limiter runs BEFORE any database lookup, so key guessing cannot reach Neon at full speed.
 */
export const RATE_LIMITS = {
  ipBurst: 120,
  ipRefillPerSec: 30,
  /**
   * Second, stricter per-IP budget spent ONLY by failed authentications (unknown, revoked or
   * wrong-scope key). Checked before the database lookup; successes never spend it. Stops an
   * attacker who sends a fresh random well-formed key each time (those miss the negative cache).
   */
  ipFailureBurst: 10,
  ipFailureRefillPerSec: 1,
  keyBurst: 20,
  keyRefillPerSec: 5,
  /** Positive cache: also the upper bound on how long a revoked key keeps working on one instance. */
  authCacheTtlMs: 60_000,
  /** Unknown/revoked key hashes: short, so a freshly created key is not locked out for long. */
  authNegativeTtlMs: 30_000,
  authCacheMaxEntries: 1_000,
  /** api_keys.last_used_at is written at most this often per key. */
  lastUsedWriteIntervalMs: 60_000,
} as const;

/**
 * `flush_hint_ms` returned by ingest (docs/ARCHITECTURE.md section 2). The SDK clamps it to its own 1-60 s
 * range. `live` applies while a dashboard viewer is watching the project (`projects.last_viewed_at` newer
 * than `liveWindowMs`); `conserve` wins over everything (app_state `conserve` flag).
 */
export const FLUSH_HINT_MS = {
  live: 1_000,
  idleMin: 10_000,
  idleMax: 15_000,
  conserve: 60_000,
  liveWindow: 15_000,
} as const;

/**
 * Storage guard (P2.11c2), as a fraction of the budget: the larger of events size / the 600 MB events budget and database
 * size / 1 GB. `warnAt`: conserve flag on (long flush_hint_ms). `pauseSignupsAt`: claim_user_slot refuses new users.
 * Hysteresis: a level is left only `releaseMargin` below its threshold. The SQL (migration 0012, storage_level_for) holds the
 * same numbers and tests/storage-guard-sql.test.ts keeps them equal.
 */
export const STORAGE_GUARD = { warnAt: 0.7, pauseSignupsAt: 0.85, releaseMargin: 0.05 } as const;

/**
 * Inputs of the storage math behind `QUOTAS.eventsPerDayPerProject` and `contentRowsPerDayPerProject`
 * (lib/capacity.ts). tests/quotas-capacity.test.ts ties them to db/measurements/event-row-size.json.
 *
 * RULE: a row size is the LARGER measured profile mean (heap + toast + every index) times 1.25 safety margin, rounded up.
 *  - `eventRowBytes`: heavy profile mean 839.7 B (measured 2026-11-20: lean 561.2, heavy 839.7; spread under 1%,
 *    no warnings) x 1.25 = 1,049.6 -> 1,050.
 *  - `contentRowBytes`: maximum-size encrypted content row 6,537.2 B x 1.25 = 8,171.5 -> 8,200.
 * `eventWindowDays` is 14 retention days + 1 day of purge lag, valid once P2.11 deletes expired rows inside live monthly
 * partitions (owner decision (b)); with whole-partition drops only, the real window is up to 45 days. `contentWindowDays`
 * is the 3-day content retention + 1 day of purge lag. The project count uses the default MAX_USERS: raising MAX_USERS
 * means lowering these quotas.
 */
export const SIZING = {
  databaseBytes: 1_000_000_000,
  eventsShare: 0.6,
  eventRowBytes: 1_050,
  eventWindowDays: 15,
  contentShare: 0.15,
  contentRowBytes: 8_200,
  contentWindowDays: 4,
  /** metrics_minute / metrics_hourly row: measured 227.3 B x 1.25 = 284.1 -> 290. */
  rollupRowBytes: 290,
  /** Distinct models one project is assumed to use in the worst case. */
  rollupModelsPerProject: 3,
  minuteRollupHours: 48,
  hourlyRollupDays: 90,
  /** Hourly rows use one shard (P2.6b). */
  hourlyRollupShards: 1,
} as const;

export type Quotas = typeof QUOTAS;
