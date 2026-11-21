import { buildOverview } from "@/lib/dashboard/overview";
import { demoSnapshotSchema, type DemoSnapshot, type OverviewData, type OverviewRange, type TraceDetail } from "@/lib/dashboard/types";
import { QUOTAS } from "@/lib/quotas";
import raw from "./snapshot.json";

/**
 * The public demo project's data: a committed, generated JSON file (lib/demo/generate.ts), validated once on first use.
 * It is STATIC on purpose: no database, no tenant context, no network, so visitors cost no Neon compute and the demo
 * can never reach another user's data. (A database-backed demo, DEMO_SOURCE=db, is deferred.)
 *
 * Do not import lib/repo or lib/db from this folder; tests/demo-static.test.ts enforces it.
 */
let cached: DemoSnapshot | null = null;

export function getDemoSnapshot(): DemoSnapshot {
  if (!cached) cached = demoSnapshotSchema.parse(raw);
  return cached;
}

/** The demo's "now" is the moment the snapshot was generated, so the window always has data. */
export function getDemoOverview(range: OverviewRange): OverviewData {
  const s = getDemoSnapshot();
  return buildOverview({
    range,
    nowMs: Date.parse(s.generatedAt),
    rows: s.rollups,
    pricedModels: new Set(s.pricedModels),
    eventsToday: s.usage.eventsToday,
    eventsLimit: QUOTAS.eventsPerDayPerProject,
  });
}

export function getDemoTraces(): TraceDetail[] {
  return getDemoSnapshot().traces;
}
