/**
 * Free-tier quota constants (Vercel Hobby + Neon Free). A paid plan only
 * raises these numbers. Recompute the event/storage figures after the P2
 * row-size measurement (docs/DATA_MODEL.md section 6, docs/DEPLOYMENT.md).
 */
export const QUOTAS = {
  eventsPerDayPerProject: 10_000,
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

/** Database-size guard thresholds as a fraction of the 1 GB Neon Free cap. */
export const STORAGE_GUARD = { warnAt: 0.7, pauseSignupsAt: 0.85 } as const;

export type Quotas = typeof QUOTAS;
