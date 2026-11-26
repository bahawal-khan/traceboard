import { buildThreadDetailView, parseThreadIdParam, type ThreadDetailView } from "@/lib/dashboard/thread-detail-view";
import type { ThreadItemInput } from "@/lib/dashboard/threads-view";
import { demoListItem } from "./traces";
import { getDemoSnapshot } from "./index";

/**
 * The public demo's thread views, built from the committed snapshot only (no database, no session, no network). A thread is a
 * list of sample traces (snapshot.threads); each trace becomes one turn through the SAME row builder the Traces list uses, and
 * the thread's totals follow the signed-in rules: a trace with no known cost adds nothing, never 0 (a real 0 only when nothing
 * needed a price), and any unpriced call makes the sum a lower bound.
 *
 * Do not import lib/repo or lib/db from here; tests/demo-static.test.ts enforces it.
 */

function turnsOf(traceIds: readonly string[]) {
  const byId = new Map(getDemoSnapshot().traces.map((t) => [t.summary.traceId, t]));
  return traceIds
    .map((id) => byId.get(id))
    .filter((t): t is NonNullable<typeof t> => t !== undefined)
    .map((t) => ({ trace: t, item: demoListItem(t) }))
    .sort((a, b) => a.item.startedAtMs - b.item.startedAtMs || (a.item.traceId < b.item.traceId ? -1 : 1));
}

/** One row of the Threads list from the traces of one snapshot thread. */
export function demoThreadItem(threadId: string, traceIds: readonly string[]): ThreadItemInput {
  const turns = turnsOf(traceIds);
  const items = turns.map((t) => t.item);
  const known = items.filter((i) => i.costMicro !== null);
  const lowerBound = items.some((i) => i.costLowerBound);
  const sum = known.reduce((a, i) => a + (i.costMicro as number), 0);
  const lastMs = Math.max(...turns.map(({ trace, item }) => item.startedAtMs + Math.max(...trace.spans.map((s) => s.offsetMs))));
  return {
    threadId,
    startedAtMs: Math.min(...items.map((i) => i.startedAtMs)),
    lastActiveAtMs: lastMs,
    traceCount: items.length,
    spanCount: items.reduce((a, i) => a + i.spanCount, 0),
    errorCount: items.reduce((a, i) => a + i.errorCount, 0),
    totalTokens: items.reduce((a, i) => a + i.totalTokens, 0),
    costMicro: known.length > 0 ? sum : lowerBound ? null : 0,
    costLowerBound: lowerBound,
  };
}

/** Most recently active first, ties by id, like the signed-in list. */
export function getDemoThreadList(): ThreadItemInput[] {
  return getDemoSnapshot()
    .threads.map((t) => demoThreadItem(t.threadId, t.traceIds))
    .sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs || (a.threadId < b.threadId ? -1 : 1));
}

export function getDemoThreadIds(): string[] {
  return getDemoSnapshot().threads.map((t) => t.threadId);
}

/** null for an unknown or malformed id: the caller shows the not-found page. Nothing about the id is ever echoed. */
export function getDemoThreadView(rawId: string | string[] | undefined): ThreadDetailView | null {
  const id = parseThreadIdParam(rawId);
  if (id === null) return null;
  const t = getDemoSnapshot().threads.find((x) => x.threadId === id);
  if (!t) return null;
  return buildThreadDetailView({
    threadId: id,
    turns: turnsOf(t.traceIds).map((x) => x.item),
    untracedEvents: 0,
    truncated: false,
    tracesPath: "/demo/traces",
  });
}
