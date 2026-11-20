import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GB, hourlyRollupWorstCaseBytes, maxEventsPerDayPerProject, maxRowsPerDayPerProject, minuteRollupWorstCaseBytes, share } from "@/lib/capacity";
import { QUOTAS, SIZING } from "@/lib/quotas";

interface EventRun {
  profile: "lean" | "heavy";
  rows: number;
  bytes: { total: number };
}
interface Report {
  consistent: boolean;
  warnings: string[];
  rowsPerRun: number;
  events: { runs: EventRun[] };
  rollups: { metrics_minute: { totalBytes: number; rows: number } };
  event_content: { totalBytes: number; rows: number };
}
const report = JSON.parse(readFileSync("db/measurements/event-row-size.json", "utf8")) as Report;

/**
 * Everything below is derived from the raw byte TOTALS and the number of rows INSERTED per run, never from the
 * stored per-row convenience fields (the first report divided "heavy" by the wrong row count; this keeps any such
 * slip from reaching the quotas).
 */
const mean = (profile: "lean" | "heavy"): number => {
  const v = report.events.runs.filter((r) => r.profile === profile).map((r) => r.bytes.total / report.rowsPerRun);
  return v.reduce((a, b) => a + b, 0) / v.length;
};

describe("the measurement report", () => {
  it("is the consistent four-run format: lean, heavy, heavy, lean, every run with the inserted row count", () => {
    expect(report.events.runs.map((r) => r.profile)).toEqual(["lean", "heavy", "heavy", "lean"]);
    for (const r of report.events.runs) expect(r.rows).toBe(report.rowsPerRun);
    expect(report.consistent).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("heavy is larger than lean, and each profile's two runs agree within 10 percent", () => {
    expect(mean("heavy")).toBeGreaterThan(mean("lean"));
    for (const profile of ["lean", "heavy"] as const) {
      const v = report.events.runs.filter((r) => r.profile === profile).map((r) => r.bytes.total / report.rowsPerRun);
      expect((Math.max(...v) - Math.min(...v)) / mean(profile)).toBeLessThan(0.1);
    }
  });
});

describe("quotas are consistent with the measured row sizes", () => {
  const projects = QUOTAS.defaultMaxUsers * QUOTAS.projectsPerUser;
  const inputs = { databaseBytes: SIZING.databaseBytes, eventsShare: SIZING.eventsShare, bytesPerEvent: SIZING.eventRowBytes, windowDays: SIZING.eventWindowDays, projects };

  it("the sizing assumes the 1 GB Neon Free project, never more", () => {
    expect(SIZING.databaseBytes).toBeLessThanOrEqual(GB);
  });

  it("SIZING.eventRowBytes is the larger profile mean x 1.25, rounded up (and not silently inflated)", () => {
    const basis = Math.max(mean("lean"), mean("heavy")) * 1.25;
    expect(basis).toBeGreaterThan(1000); // the report is plausible
    expect(SIZING.eventRowBytes).toBeGreaterThanOrEqual(basis);
    expect(SIZING.eventRowBytes).toBeLessThan(basis + 10);
  });

  it("SIZING.contentRowBytes is the measured maximum-size content row x 1.25, rounded up to 100", () => {
    const measured = report.event_content.totalBytes / report.event_content.rows;
    expect(SIZING.contentRowBytes).toBeGreaterThanOrEqual(measured * 1.25);
    expect(SIZING.contentRowBytes).toBeLessThan(measured * 1.25 + 100);
  });

  it("QUOTAS.eventsPerDayPerProject equals the derived maximum (not hand-edited away from the math)", () => {
    expect(QUOTAS.eventsPerDayPerProject).toBe(maxEventsPerDayPerProject(inputs));
  });

  it("a full house of projects at the events quota stays inside the events share of the database", () => {
    const bytes = QUOTAS.eventsPerDayPerProject * SIZING.eventWindowDays * projects * SIZING.eventRowBytes;
    expect(share(bytes, SIZING.databaseBytes)).toBeLessThanOrEqual(SIZING.eventsShare);
  });

  it("QUOTAS.contentRowsPerDayPerProject fits the content share at the maximum row size", () => {
    const max = maxRowsPerDayPerProject({ budgetBytes: SIZING.databaseBytes * SIZING.contentShare, bytesPerRow: SIZING.contentRowBytes, windowDays: SIZING.contentWindowDays, projects }, 50);
    expect(QUOTAS.contentRowsPerDayPerProject).toBeLessThanOrEqual(max);
    const bytes = QUOTAS.contentRowsPerDayPerProject * SIZING.contentWindowDays * projects * SIZING.contentRowBytes;
    expect(share(bytes, SIZING.databaseBytes)).toBeLessThanOrEqual(SIZING.contentShare);
  });

  it("the content window is the content retention plus one day of purge lag", () => {
    expect(SIZING.contentWindowDays).toBe(3 + 1);
  });

  it("SIZING.rollupRowBytes is the measured rollup row x 1.25, rounded up to 10", () => {
    const measured = report.rollups.metrics_minute.totalBytes / report.rollups.metrics_minute.rows;
    expect(SIZING.rollupRowBytes).toBeGreaterThanOrEqual(measured * 1.25);
    expect(SIZING.rollupRowBytes).toBeLessThan(measured * 1.25 + 10);
  });

  const minuteBytes = () =>
    minuteRollupWorstCaseBytes({ requestsPerDay: QUOTAS.ingestRequestsPerDayPerProject, modelsPerRequest: SIZING.rollupModelsPerProject, hours: SIZING.minuteRollupHours, bytesPerRow: SIZING.rollupRowBytes }) * projects;
  const hourlyBytes = () =>
    hourlyRollupWorstCaseBytes({ days: SIZING.hourlyRollupDays, modelsPerProject: SIZING.rollupModelsPerProject, shards: SIZING.hourlyRollupShards, bytesPerRow: SIZING.rollupRowBytes }) * projects;

  it("worst-case minute rollups (bounded by the request quota) stay within 15 percent of the database", () => {
    expect(share(minuteBytes(), SIZING.databaseBytes)).toBeLessThanOrEqual(0.15);
  });

  it("hourly rollups use ONE shard, and their worst case is small (it was 29 percent with eight shards)", () => {
    expect(SIZING.hourlyRollupShards).toBe(1);
    expect(share(hourlyBytes(), SIZING.databaseBytes)).toBeLessThan(0.05);
    const eightShards = hourlyRollupWorstCaseBytes({ days: SIZING.hourlyRollupDays, modelsPerProject: SIZING.rollupModelsPerProject, shards: 8, bytesPerRow: SIZING.rollupRowBytes }) * projects;
    expect(share(eightShards, SIZING.databaseBytes)).toBeGreaterThan(0.25);
  });

  it("the worst case of everything we meter, all at its quota at once, no longer exceeds the database (at least 10 percent headroom)", () => {
    const events = QUOTAS.eventsPerDayPerProject * SIZING.eventWindowDays * projects * SIZING.eventRowBytes;
    const content = QUOTAS.contentRowsPerDayPerProject * SIZING.contentWindowDays * projects * SIZING.contentRowBytes;
    const total = share(events + content + minuteBytes() + hourlyBytes(), SIZING.databaseBytes);
    expect(total).toBeLessThan(0.9); // the rest is control-plane, evals, jobs, alerts, audit log and WAL headroom
    expect(total).toBeGreaterThan(0.5); // and the budget is not absurdly slack either
  });
});
