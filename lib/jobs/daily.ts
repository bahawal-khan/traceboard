import type { Logger } from "@/lib/logger";

/**
 * The daily maintenance job: partitions, retention purge, storage report and guard. Pure orchestration over a `JobStore` (the SQL
 * functions of migration 0011, see lib/repo/jobs.ts), so the batching, time budget and failure isolation are unit tested.
 *
 * Properties (Vercel Hobby runs the cron once a day, +-59 minutes, and a run may be retried or overlap a manual one):
 *  - Idempotent: every store call is idempotent and bounded; running twice, or late, changes nothing extra.
 *  - Bounded: each purge loops in batches of `batch` rows until a batch comes back short ("drained") or its time share is
 *    spent ("truncated": the next run continues). A purge never starts a call after its deadline.
 *  - Isolated: a failing step is recorded and the other steps still run; the job reports ok=false so the route answers 500
 *    (Vercel shows the cron run as failed). Error messages are NOT returned to the caller (generic code); details go to logs.
 */
export interface PartitionHealth {
  currentPartition: string;
  currentExists: boolean;
  nextPartition: string;
  nextExists: boolean;
  partitionCount: number;
}
export interface RollupPurge {
  minute: number;
  hourly: number;
  budget: number;
  usage: number;
}
export interface StorageReport {
  databaseBytes: number;
  eventsBytes: number;
  contentBytes: number;
  rollupBytes: number;
  eventsBudgetBytes: number;
  eventsRatio: number;
}
/** Result of apply_storage_guard(): the level after this run (with hysteresis) and the flags it implies. */
export interface StorageGuardResult {
  level: "ok" | "warn" | "critical";
  previousLevel: "ok" | "warn" | "critical";
  ratio: number;
  conserve: boolean;
  signupsPaused: boolean;
}
export interface JobStore {
  ensurePartitions(): Promise<number>;
  partitionHealth(): Promise<PartitionHealth>;
  purgeExpiredEvents(batch: number): Promise<number>;
  dropOldPartitions(): Promise<number>;
  purgeExpiredContent(batch: number): Promise<number>;
  purgeOrphanedContent(batch: number): Promise<number>;
  purgeRollups(batch: number): Promise<RollupPurge>;
  storageReport(): Promise<StorageReport>;
  /** Measures, decides the level (SQL holds the thresholds and the hysteresis) and records it in app_state. Idempotent. */
  applyStorageGuard(): Promise<StorageGuardResult>;
}

export const DAILY_JOB = {
  /** Rows per SQL call (the functions accept 1..50000). Small enough that one call stays well under a second. */
  batch: 5_000,
  /** Total time for the purge loops. The route's maxDuration is 60 s; the rest is for partitions, drop and the report. */
  purgeBudgetMs: 40_000,
  /** Hard cap on calls per loop, so a bug that never returns a short batch cannot spin until the deadline. */
  maxCallsPerLoop: 200,
  /** Share of the purge budget each loop may use (events first; rollups take what is left). */
  shares: { events: 0.5, content: 0.15, orphans: 0.1 },
} as const;

export type StepStatus = "ok" | "error";
export interface LoopResult {
  status: StepStatus;
  deleted: number;
  calls: number;
  /** true: the loop ended on a short batch (nothing left); false: it stopped on time or the call cap and work may remain. */
  drained: boolean;
  error?: "step_failed";
}
export interface DailyJobResult {
  ok: boolean;
  /** true when every purge loop drained; false means the next run continues the work (not a failure). */
  complete: boolean;
  startedAt: string;
  durationMs: number;
  partitions: { status: StepStatus; ensured?: number; health?: PartitionHealth; nextPartitionMissing?: boolean; error?: "step_failed" };
  purge: {
    events: LoopResult;
    content: LoopResult;
    orphanedContent: LoopResult;
    rollups: LoopResult & { byTable: RollupPurge };
  };
  droppedPartitions: { status: StepStatus; dropped?: number; error?: "step_failed" };
  storage: { status: StepStatus; report?: StorageReport; error?: "step_failed" };
  /** The storage guard: level ok/warn/critical, conserve flag (warn+), signups paused (critical). */
  guard: { status: StepStatus; result?: StorageGuardResult; changed?: boolean; error?: "step_failed" };
}

export interface RunOptions {
  now?: () => number;
  batch?: number;
  purgeBudgetMs?: number;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

async function loop(
  step: string,
  call: () => Promise<number>,
  batch: number,
  deadline: number,
  now: () => number,
  log: NonNullable<RunOptions["log"]>,
): Promise<LoopResult> {
  const r: LoopResult = { status: "ok", deleted: 0, calls: 0, drained: false };
  try {
    while (r.calls < DAILY_JOB.maxCallsPerLoop && now() < deadline) {
      const n = await call();
      r.calls += 1;
      r.deleted += n;
      if (n < batch) {
        r.drained = true;
        break;
      }
    }
  } catch (err) {
    r.status = "error";
    r.error = "step_failed";
    log.error("daily job step failed", { step, err });
  }
  return r;
}

export async function runDailyJob(store: JobStore, opts: RunOptions = {}): Promise<DailyJobResult> {
  const now = opts.now ?? Date.now;
  const batch = opts.batch ?? DAILY_JOB.batch;
  const budget = opts.purgeBudgetMs ?? DAILY_JOB.purgeBudgetMs;
  const log = opts.log ?? { info() {}, warn() {}, error() {} };
  const t0 = now();
  const purgeEnd = t0 + budget;
  const share = (f: number, from: number) => Math.min(purgeEnd, from + budget * f);

  // 1. Partitions: create current + next month, then verify; a missing next partition would make ingest fail on the 1st.
  const partitions: DailyJobResult["partitions"] = { status: "ok" };
  try {
    partitions.ensured = await store.ensurePartitions();
    partitions.health = await store.partitionHealth();
    partitions.nextPartitionMissing = !partitions.health.nextExists || !partitions.health.currentExists;
    if (partitions.nextPartitionMissing) {
      partitions.status = "error";
      partitions.error = "step_failed";
      log.error("daily job: event partition missing after ensure", { health: partitions.health });
    }
  } catch (err) {
    partitions.status = "error";
    partitions.error = "step_failed";
    log.error("daily job step failed", { step: "partitions", err });
  }

  // 2. Purges, sharing one time budget.
  const events = await loop("purge_events", () => store.purgeExpiredEvents(batch), batch, share(DAILY_JOB.shares.events, now()), now, log);
  const content = await loop("purge_content", () => store.purgeExpiredContent(batch), batch, share(DAILY_JOB.shares.content, now()), now, log);
  const orphanedContent = await loop("purge_orphans", () => store.purgeOrphanedContent(batch), batch, share(DAILY_JOB.shares.orphans, now()), now, log);
  const byTable: RollupPurge = { minute: 0, hourly: 0, budget: 0, usage: 0 };
  const rollupsBase = await loop(
    "purge_rollups",
    async () => {
      const r = await store.purgeRollups(batch);
      byTable.minute += r.minute;
      byTable.hourly += r.hourly;
      byTable.budget += r.budget;
      byTable.usage += r.usage;
      // The function deletes up to `batch` per table; the loop is done when no table returned a full batch.
      return Math.max(r.minute, r.hourly, r.budget, r.usage);
    },
    batch,
    purgeEnd,
    now,
    log,
  );
  // `deleted` for rollups is the sum over tables (the loop counted the max per call).
  const rollups = { ...rollupsBase, deleted: byTable.minute + byTable.hourly + byTable.budget + byTable.usage, byTable };

  // 3. Drop fully-expired partitions (never the current or next month; enforced in SQL). Cheap, so no time share.
  const droppedPartitions: DailyJobResult["droppedPartitions"] = { status: "ok" };
  try {
    droppedPartitions.dropped = await store.dropOldPartitions();
  } catch (err) {
    droppedPartitions.status = "error";
    droppedPartitions.error = "step_failed";
    log.error("daily job step failed", { step: "drop_partitions", err });
  }

  // 4. Storage report (measure only), then the guard: the SQL function decides the level from its own measurement and the
  //    previous level (thresholds and hysteresis live in migration 0012 and lib/quotas.ts STORAGE_GUARD) and sets the flags.
  const storage: DailyJobResult["storage"] = { status: "ok" };
  try {
    storage.report = await store.storageReport();
  } catch (err) {
    storage.status = "error";
    storage.error = "step_failed";
    log.error("daily job step failed", { step: "storage_report", err });
  }
  const guard: DailyJobResult["guard"] = { status: "ok" };
  try {
    guard.result = await store.applyStorageGuard();
    guard.changed = guard.result.level !== guard.result.previousLevel;
    if (guard.result.level !== "ok") log.warn("daily job: storage over threshold", { level: guard.result.level, ratio: guard.result.ratio });
    if (guard.changed) log.warn("daily job: storage level changed", { from: guard.result.previousLevel, to: guard.result.level });
  } catch (err) {
    guard.status = "error";
    guard.error = "step_failed";
    log.error("daily job step failed", { step: "storage_guard", err });
  }

  const loops = [events, content, orphanedContent, rollups];
  const ok = partitions.status === "ok" && droppedPartitions.status === "ok" && storage.status === "ok" && guard.status === "ok" && loops.every((l) => l.status === "ok");
  const result: DailyJobResult = {
    ok,
    complete: loops.every((l) => l.status === "ok" && l.drained),
    startedAt: new Date(t0).toISOString(),
    durationMs: now() - t0,
    partitions,
    purge: { events, content, orphanedContent, rollups },
    droppedPartitions,
    storage,
    guard,
  };
  log.info("daily job finished", { ok: result.ok, complete: result.complete, durationMs: result.durationMs });
  return result;
}
