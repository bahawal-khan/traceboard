import { beforeEach, describe, expect, it, vi } from "vitest";

/** lib/repo/jobs.ts maps what the job functions return (driver values, often strings) to typed results. The driver is mocked. */
const rows = vi.hoisted(() => ({ queue: [] as unknown[][], seen: [] as string[] }));
vi.mock("@/lib/db/job-client", () => ({
  getJobSql: () => (strings: TemplateStringsArray) => {
    rows.seen.push(strings.join("?").replace(/\s+/g, " ").trim());
    return Promise.resolve(rows.queue.shift() ?? []);
  },
}));

import { createJobStore } from "@/lib/repo/jobs";

beforeEach(() => {
  rows.queue = [];
  rows.seen = [];
});

describe("createJobStore: applyStorageGuard", () => {
  const guardRow = (o: Record<string, unknown> = {}) => ({ level: "warn", previous_level: "ok", ratio: "0.7312", conserve: true, signups_paused: false, ...o });

  it("maps the row and calls exactly apply_storage_guard() (no argument)", async () => {
    rows.queue = [[guardRow()]];
    expect(await createJobStore().applyStorageGuard()).toEqual({ level: "warn", previousLevel: "ok", ratio: 0.7312, conserve: true, signupsPaused: false });
    expect(rows.seen).toEqual(["select level, previous_level, ratio::text as ratio, conserve, signups_paused from apply_storage_guard()"]);
  });

  it("carries signups_paused and conserve through for every level", async () => {
    rows.queue = [[guardRow({ level: "critical", previous_level: "warn", conserve: true, signups_paused: true })]];
    expect(await createJobStore().applyStorageGuard()).toMatchObject({ level: "critical", previousLevel: "warn", conserve: true, signupsPaused: true });
    rows.queue = [[guardRow({ level: "ok", previous_level: "critical", conserve: false, signups_paused: false })]];
    expect(await createJobStore().applyStorageGuard()).toMatchObject({ level: "ok", previousLevel: "critical", conserve: false, signupsPaused: false });
  });

  it("treats anything but true as false, and an unknown or missing previous level as ok", async () => {
    rows.queue = [[guardRow({ conserve: "true", signups_paused: 1, previous_level: "weird" })]];
    expect(await createJobStore().applyStorageGuard()).toMatchObject({ conserve: false, signupsPaused: false, previousLevel: "ok" });
    rows.queue = [[guardRow({ previous_level: null })]];
    expect((await createJobStore().applyStorageGuard()).previousLevel).toBe("ok");
  });

  it("refuses a level it does not know (a wrong answer must fail the job step, not be recorded)", async () => {
    for (const bad of ["panic", "OK", "", null, undefined, 3]) {
      rows.queue = [[guardRow({ level: bad })]];
      await expect(createJobStore().applyStorageGuard()).rejects.toThrow("unexpected apply_storage_guard result");
    }
    rows.queue = [[]];
    await expect(createJobStore().applyStorageGuard()).rejects.toThrow("unexpected apply_storage_guard result");
  });
});

describe("createJobStore: the other job functions", () => {
  it("maps counts to numbers (bigints and numerics arrive as strings) and calls the right function with a bound batch", async () => {
    const s = createJobStore();
    rows.queue = [[{ n: "3" }], [{ n: 5 }], [{ n: "0" }], [{ n: "7" }], [{ n: "2" }], [{ n: "1" }]];
    expect(await s.ensurePartitions()).toBe(3);
    expect(await s.purgeExpiredEvents(500)).toBe(5);
    expect(await s.dropOldPartitions()).toBe(0);
    expect(await s.purgeExpiredContent(500)).toBe(7);
    expect(await s.purgeOrphanedContent(500)).toBe(2);
    rows.queue = [[{ minute_rows: "4", hourly_rows: 3, budget_rows: "2", usage_rows: 1 }]];
    expect(await s.purgeRollups(500)).toEqual({ minute: 4, hourly: 3, budget: 2, usage: 1 });
    expect(rows.seen.join("|")).toMatch(/job_ensure_partitions.*purge_expired_events.*drop_old_event_partitions.*purge_expired_content.*purge_orphaned_content.*purge_rollups/);
    rows.queue = [[{ current_partition: "events_y2026m11", current_exists: true, next_partition: "events_y2026m12", next_exists: false, partition_count: "3" }]];
    expect(await s.partitionHealth()).toEqual({ currentPartition: "events_y2026m11", currentExists: true, nextPartition: "events_y2026m12", nextExists: false, partitionCount: 3 });
    rows.queue = [[{ database_bytes: "100", events_bytes: "50", content_bytes: "5", rollup_bytes: "9", events_budget_bytes: "600000000", events_ratio: "0.1234" }]];
    expect(await s.storageReport()).toEqual({ databaseBytes: 100, eventsBytes: 50, contentBytes: 5, rollupBytes: 9, eventsBudgetBytes: 600000000, eventsRatio: 0.1234 });
  });

  it("a missing partition (false) is never read as present", async () => {
    rows.queue = [[{ current_partition: "a", current_exists: "true", next_partition: "b", next_exists: null, partition_count: 1 }]];
    expect(await createJobStore().partitionHealth()).toMatchObject({ currentExists: false, nextExists: false });
  });
});
