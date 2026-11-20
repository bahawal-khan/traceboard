import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GB, maxEventsPerDayPerProject, maxRowsPerDayPerProject, minuteRollupWorstCaseBytes, share } from "@/lib/capacity";
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

  it("worst-case minute rollups (bounded by the request quota) stay within 15 percent of the database", () => {
    const row = (report.rollups.metrics_minute.totalBytes / report.rollups.metrics_minute.rows) * 1.25;
    const perProject = minuteRollupWorstCaseBytes({ requestsPerDay: QUOTAS.ingestRequestsPerDayPerProject, modelsPerRequest: 3, hours: 48, bytesPerRow: row });
    expect(share(perProject * projects, SIZING.databaseBytes)).toBeLessThanOrEqual(0.15);
  });
});
