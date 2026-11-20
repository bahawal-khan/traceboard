import { describe, expect, it } from "vitest";
import { eventsStorageBytes, GB, maxEventsPerDayPerProject, maxRowsPerDayPerProject, minuteRollupWorstCaseBytes, peakEventDays, share } from "@/lib/capacity";

describe("capacity math", () => {
  const base = { databaseBytes: GB, eventsShare: 0.6, bytesPerEvent: 500, windowDays: 14, projects: 20 };

  it("storage is events/day x days x projects x bytes", () => {
    expect(eventsStorageBytes({ eventsPerDay: 1000, windowDays: 14, projects: 20, bytesPerEvent: 500 })).toBe(140_000_000);
  });

  it("the largest quota that fits never exceeds the events budget, and one step more would", () => {
    const max = maxEventsPerDayPerProject(base);
    const budget = base.databaseBytes * base.eventsShare;
    expect(eventsStorageBytes({ ...base, eventsPerDay: max })).toBeLessThanOrEqual(budget);
    expect(eventsStorageBytes({ ...base, eventsPerDay: max + 100 })).toBeGreaterThan(budget);
    expect(max % 100).toBe(0);
    expect(max).toBe(4200); // 600 MB / (500 B x 14 d x 20 projects) = 4285 -> 4200
  });

  it("bigger rows, longer windows or more projects shrink the quota", () => {
    const max = maxEventsPerDayPerProject(base);
    expect(maxEventsPerDayPerProject({ ...base, bytesPerEvent: 1000 })).toBeLessThan(max);
    expect(maxEventsPerDayPerProject({ ...base, windowDays: 45 })).toBeLessThan(max);
    expect(maxEventsPerDayPerProject({ ...base, projects: 40 })).toBeLessThan(max);
  });

  it("monthly partitions keep rows up to a month longer than the policy unless rows are deleted inside live partitions", () => {
    expect(peakEventDays(14, false)).toBe(45);
    expect(peakEventDays(14, true)).toBe(14);
  });

  it("minute rollups are bounded by the request quota, not by the event count", () => {
    expect(minuteRollupWorstCaseBytes({ requestsPerDay: 3000, modelsPerRequest: 3, hours: 48, bytesPerRow: 250 })).toBe(4_500_000);
  });

  it("one formula serves every storage-derived quota", () => {
    const events = maxEventsPerDayPerProject({ ...base, bytesPerEvent: 1050, windowDays: 15 });
    expect(events).toBe(1900); // 600 MB / (1,050 B x 15 d x 20) = 1,904
    expect(maxRowsPerDayPerProject({ budgetBytes: 0.6 * GB, bytesPerRow: 1050, windowDays: 15, projects: 20 })).toBe(events);
    expect(maxRowsPerDayPerProject({ budgetBytes: 0.15 * GB, bytesPerRow: 8200, windowDays: 4, projects: 20 }, 50)).toBe(200); // 228 -> 200
    expect(maxRowsPerDayPerProject({ budgetBytes: 100, bytesPerRow: 1000, windowDays: 1, projects: 1 })).toBe(0); // never rounds up
  });

  it("share is a plain ratio", () => {
    expect(share(300_000_000, GB)).toBeCloseTo(0.3);
  });
});
