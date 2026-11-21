import type { NormalizedEvent } from "@/lib/ingest/normalize";
import type { ApiKeyCtx } from "@/lib/repo/tenant";

/**
 * The write seam (CLAUDE.md "keep the seams"). Everything that persists ingested events goes through
 * an `EventStore`, so a later columnar or queued backend replaces one module. The project is taken
 * from the authenticated context, never from the rows.
 */
/** Today's (UTC) counters for the project, after this write. `requests` counts ingest requests. */
export interface UsageToday {
  events: number;
  requests: number;
  costMicro: number;
}

/** A budget touched by this write: its config plus the cumulative spend for the affected period. */
export interface BudgetUsageRow {
  budgetId: string;
  scope: "project" | "trace";
  period: "day" | "month" | "run";
  /** numeric(…) as text; the Guard compares it in integer micro-USD. */
  limitUsd: string;
  action: "alert" | "block";
  /** '2026-11-20' (day), '2026-11' (month) or the trace id (per-run budgets). */
  periodKey: string;
  spentMicro: number;
}

/** What the same write learned about the project, for the response: no extra round trip. */
export interface ProjectSignals {
  /** `projects.last_viewed_at` (set by the live view); null when nobody has watched yet. */
  lastViewedAt: Date | null;
  /** app_state `conserve` flag (free-tier protection); false when unset. */
  conserve: boolean;
}

export interface PersistResult {
  /** Rows actually inserted; the batch size minus this is the number of duplicates skipped. */
  inserted: number;
  /** Content rows stored (encrypted) for newly inserted events; 0 when capture is off, no key is set, or all were duplicates. */
  contentStored: number;
  /** Content rows NOT stored because the project reached its daily content cap (`QUOTAS.contentRowsPerDayPerProject`); 0 otherwise. */
  contentDropped: number;
  /** null only for an empty batch, which does not touch the database. */
  usage: UsageToday | null;
  /** null only for an empty batch. */
  signals: ProjectSignals | null;
  /** Budgets whose spend changed in this write; empty for a batch of duplicates or zero cost. */
  budgets: BudgetUsageRow[];
}

export interface EventStore {
  persist(ctx: ApiKeyCtx, events: readonly NormalizedEvent[]): Promise<PersistResult>;
}

/**
 * An event's `occurred_at` fell outside every existing partition. This is an operational fault (the
 * daily job is late), not a client error: the route answers a generic 503 and logs it clearly.
 * The store never creates partitions itself (app_rw has no DDL path).
 */
export class MissingPartitionError extends Error {
  constructor() {
    super("no events partition for occurred_at");
    this.name = "MissingPartitionError";
  }
}

/** SQLSTATE 23514 with Postgres' "no partition of relation ... found for row" message. */
export function isMissingPartitionError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  return e.code === "23514" && typeof e.message === "string" && /no partition of relation/i.test(e.message);
}
