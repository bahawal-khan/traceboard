/**
 * Storage capacity math for the free tier (Neon Free: 1 GB per project; verified 2026-11-20).
 * Pure functions, no I/O: the inputs come from `lib/quotas.ts` and from the measured row sizes in
 * db/measurements/event-row-size.json (scripts/measure-event-size.mjs). A test keeps QUOTAS honest:
 * if someone raises a quota or a retention without re-measuring, it fails.
 */
export const GB = 1_000_000_000; // conservative: the plan says "1 GB"; we never assume the 7% larger GiB.

export interface EventCapacityInputs {
  /** Whole-database cap in bytes. */
  databaseBytes: number;
  /** Fraction of the database the events table may use (docs/DEPLOYMENT.md: 0.6). */
  eventsShare: number;
  /** Measured bytes per event row including all indexes. */
  bytesPerEvent: number;
  /** Days of events physically on disk at the peak (see `peakEventDays`). */
  windowDays: number;
  /** Projects that can exist at once (MAX_USERS x projects per user). */
  projects: number;
}

/** Bytes the events table needs if every project ingests `eventsPerDay` for `windowDays`. */
export function eventsStorageBytes(i: Pick<EventCapacityInputs, "bytesPerEvent" | "windowDays" | "projects"> & { eventsPerDay: number }): number {
  return Math.ceil(i.eventsPerDay * i.windowDays * i.projects * i.bytesPerEvent);
}

/**
 * Largest per-project rows/day that still fit a byte budget, rounded DOWN to a multiple of `step`.
 * One formula for every storage-derived quota: budget / (bytes per row x days on disk x projects).
 */
export function maxRowsPerDayPerProject(i: { budgetBytes: number; bytesPerRow: number; windowDays: number; projects: number }, step = 100): number {
  const raw = i.budgetBytes / (i.bytesPerRow * i.windowDays * i.projects);
  return Math.floor(raw / step) * step;
}

/** Largest per-project events/day that still fits the events budget. */
export function maxEventsPerDayPerProject(i: EventCapacityInputs, step = 100): number {
  return maxRowsPerDayPerProject({ budgetBytes: i.databaseBytes * i.eventsShare, bytesPerRow: i.bytesPerEvent, windowDays: i.windowDays, projects: i.projects }, step);
}

/**
 * Days of events on disk at the peak. Events live in MONTHLY partitions and a partition is dropped only
 * when its end is older than `policyDays` (drop_old_event_partitions), so the oldest rows survive for
 * `policyDays` plus up to one full month. Unless old rows are also deleted inside live partitions, the
 * peak window is policyDays + 31, not policyDays.
 */
export function peakEventDays(policyDays: number, deletesInsideLivePartition: boolean): number {
  return deletesInsideLivePartition ? policyDays : policyDays + 31;
}

/**
 * Worst-case minute-rollup bytes per project: every request can write one row per (model, shard) and
 * rows are kept `hours`. Bounded by the requests/day quota, not by the event count.
 */
export function minuteRollupWorstCaseBytes(i: { requestsPerDay: number; modelsPerRequest: number; hours: number; bytesPerRow: number }): number {
  const rows = i.requestsPerDay * (i.hours / 24) * i.modelsPerRequest;
  return Math.ceil(rows * i.bytesPerRow);
}

/**
 * Worst-case hourly-rollup bytes per project over `days`: one row per (hour, model, shard). Hourly rows are written with
 * ONE shard (shards = 1), so this is days x 24 x models x row size; with 8 shards it was 8x larger (29% of the database).
 */
export function hourlyRollupWorstCaseBytes(i: { days: number; modelsPerProject: number; shards: number; bytesPerRow: number }): number {
  return Math.ceil(i.days * 24 * i.modelsPerProject * i.shards * i.bytesPerRow);
}

/** Share of the database used by a given number of bytes. */
export const share = (bytes: number, databaseBytes: number): number => bytes / databaseBytes;
