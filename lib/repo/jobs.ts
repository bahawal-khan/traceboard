import { getJobSql } from "@/lib/db/job-client";
import type { JobStore, PartitionHealth, RollupPurge, StorageReport } from "@/lib/jobs/daily";

/**
 * The daily job's database access: calls the SECURITY DEFINER functions of migration 0011 as `app_job`. These functions
 * work across tenants by design (retention), so there is no tenant context here; app_job has no table privilege at all.
 * Counts come back as int / bigint text; every value stays far below 2^53, so Number() is exact.
 */
export function createJobStore(): JobStore {
  const sql = getJobSql;
  const int = (v: unknown) => Number(v ?? 0);
  return {
    async ensurePartitions() {
      const [r] = await sql()`select job_ensure_partitions() as n`;
      return int(r?.n);
    },
    async partitionHealth(): Promise<PartitionHealth> {
      const [r] = await sql()`select current_partition, current_exists, next_partition, next_exists, partition_count from events_partition_health()`;
      return {
        currentPartition: String(r?.current_partition ?? ""),
        currentExists: r?.current_exists === true,
        nextPartition: String(r?.next_partition ?? ""),
        nextExists: r?.next_exists === true,
        partitionCount: int(r?.partition_count),
      };
    },
    async purgeExpiredEvents(batch) {
      const [r] = await sql()`select purge_expired_events(${batch}::int) as n`;
      return int(r?.n);
    },
    async dropOldPartitions() {
      const [r] = await sql()`select drop_old_event_partitions() as n`;
      return int(r?.n);
    },
    async purgeExpiredContent(batch) {
      const [r] = await sql()`select purge_expired_content(${batch}::int) as n`;
      return int(r?.n);
    },
    async purgeOrphanedContent(batch) {
      const [r] = await sql()`select purge_orphaned_content(${batch}::int) as n`;
      return int(r?.n);
    },
    async purgeRollups(batch): Promise<RollupPurge> {
      const [r] = await sql()`select minute_rows, hourly_rows, budget_rows, usage_rows from purge_rollups(${batch}::int)`;
      return { minute: int(r?.minute_rows), hourly: int(r?.hourly_rows), budget: int(r?.budget_rows), usage: int(r?.usage_rows) };
    },
    async storageReport(): Promise<StorageReport> {
      const [r] = await sql()`select database_bytes::text, events_bytes::text, content_bytes::text, rollup_bytes::text, events_budget_bytes::text, events_ratio::text from storage_report()`;
      return {
        databaseBytes: int(r?.database_bytes),
        eventsBytes: int(r?.events_bytes),
        contentBytes: int(r?.content_bytes),
        rollupBytes: int(r?.rollup_bytes),
        eventsBudgetBytes: int(r?.events_budget_bytes),
        eventsRatio: Number(r?.events_ratio ?? 0),
      };
    },
  };
}
