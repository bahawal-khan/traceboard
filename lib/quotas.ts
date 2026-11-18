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

/** Database-size guard thresholds as a fraction of the 1 GB Neon Free cap. */
export const STORAGE_GUARD = { warnAt: 0.7, pauseSignupsAt: 0.85 } as const;

export type Quotas = typeof QUOTAS;
