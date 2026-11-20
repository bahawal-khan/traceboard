import type { NormalizedEvent } from "@/lib/ingest/normalize";
import type { ApiKeyCtx } from "@/lib/repo/tenant";

/**
 * The write seam (CLAUDE.md "keep the seams"). Everything that persists ingested events goes through
 * an `EventStore`, so a later columnar or queued backend replaces one module. The project is taken
 * from the authenticated context, never from the rows.
 */
export interface PersistResult {
  /** Rows actually inserted; the batch size minus this is the number of duplicates skipped. */
  inserted: number;
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
