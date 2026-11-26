import type { TurnInput } from "@/lib/dashboard/thread-detail-view";
import type { ThreadItemInput } from "@/lib/dashboard/threads-view";

/**
 * Dev-only sample rows for the Threads list (`/design/pages?view=threads...`, 404 in production). Shaped like lib/repo's
 * ThreadListItem. No real data. Shared with the unit tests.
 */
const NOW = Date.UTC(2026, 10, 21, 12, 30, 0);
const MIN = 60_000;

const t = (o: Partial<ThreadItemInput> & { threadId: string }): ThreadItemInput => ({
  startedAtMs: NOW - 40 * MIN,
  lastActiveAtMs: NOW - 5 * MIN,
  traceCount: 4,
  spanCount: 22,
  errorCount: 0,
  totalTokens: 12_450,
  costMicro: 18_200,
  costLowerBound: false,
  ...o,
});

/** Normal rows plus every cost case: known, lower bound, unknown, a real zero, and a thread without tokens. */
export const THREAD_FIXTURES: ThreadItemInput[] = [
  t({ threadId: "sess-7f3a9c", lastActiveAtMs: NOW - 1 * MIN, traceCount: 6, spanCount: 41, totalTokens: 48_900, costMicro: 91_500 }),
  t({ threadId: "sess-2b81d4", lastActiveAtMs: NOW - 9 * MIN, traceCount: 3, spanCount: 17, errorCount: 2, totalTokens: 9_800, costMicro: 12_400 }),
  t({ threadId: "sess-partial-cost", lastActiveAtMs: NOW - 14 * MIN, costMicro: 3_100, costLowerBound: true }),
  t({ threadId: "sess-unpriced-model", lastActiveAtMs: NOW - 22 * MIN, costMicro: null, costLowerBound: true }),
  t({ threadId: "sess-free-model", lastActiveAtMs: NOW - 31 * MIN, totalTokens: 800, costMicro: 0 }),
  t({ threadId: "sess-tools-only", lastActiveAtMs: NOW - 47 * MIN, traceCount: 1, spanCount: 3, totalTokens: 0, costMicro: 0 }),
  t({ threadId: "sess-no-trace-ids", lastActiveAtMs: NOW - 58 * MIN, traceCount: 0, spanCount: 5, totalTokens: 0, costMicro: 0 }),
  t({ threadId: "sess-long-running", startedAtMs: NOW - 13 * 24 * 60 * MIN, lastActiveAtMs: NOW - 70 * MIN, traceCount: 1_240, spanCount: 9_870, errorCount: 31, totalTokens: 2_400_000, costMicro: 12_400_000 }),
];

/** Thread ids are whatever the SDK sent (1 to 128 characters, no control characters): long, markup, reordering, emoji, URL syntax. */
export const HOSTILE_THREAD_IDS = [
  "x".repeat(128),
  "<script>alert(1)</script>",
  '"><img src=x onerror=alert(1)>',
  "abc‮def", // right-to-left override: would reverse what follows
  "zero​width‍joiner",
  "﻿bom-first",
  "💬 chat with emoji 🧵",
  "a/b?c=d#e%20f",
  "with spaces and ünïcödé",
  "../../etc/passwd",
  "1; drop table events; --",
  "w".repeat(60) + " " + "i".repeat(60),
] as const;

export const HOSTILE_THREAD_FIXTURES: ThreadItemInput[] = HOSTILE_THREAD_IDS.map((threadId, i) =>
  t({ threadId, lastActiveAtMs: NOW - (i + 1) * MIN, startedAtMs: NOW - (i + 30) * MIN, errorCount: i % 4 === 0 ? 1 : 0 }),
);

// ---- thread DETAIL fixtures (`/design/pages?view=thread-<name>`) ----

export const THREAD_DETAIL_NAMES = ["normal", "partial-cost", "truncated", "untraced", "no-traces", "hostile", "many"] as const;
export type ThreadDetailName = (typeof THREAD_DETAIL_NAMES)[number];

export interface ThreadDetailFixture {
  threadId: string;
  turns: TurnInput[];
  untracedEvents: number;
  truncated: boolean;
}

const turn = (i: number, o: Partial<TurnInput> = {}): TurnInput => ({
  traceId: `9f2c41d8e0a74b6c8d3e5f7a1b2c${String(i).padStart(4, "0")}`,
  startedAtMs: NOW - (60 - i * 3) * MIN,
  durationMs: 4_000 + i * 700,
  spanCount: 3 + (i % 5),
  errorCount: 0,
  totalTokens: 1_200 + i * 310,
  costMicro: 2_400 + i * 450,
  costLowerBound: false,
  rootName: "support.answer",
  hasRoot: true,
  ...o,
});

export function threadDetailFixture(name: ThreadDetailName): ThreadDetailFixture {
  const base = { threadId: "sess-7f3a9c", untracedEvents: 0, truncated: false };
  switch (name) {
    case "normal":
      return { ...base, turns: [turn(0), turn(1, { errorCount: 2, rootName: "support.answer (retry)" }), turn(2), turn(3, { totalTokens: 0, costMicro: 0, rootName: "tool-only turn" }), turn(4)] };
    case "partial-cost":
      return {
        ...base,
        threadId: "sess-partial-cost",
        turns: [turn(0, { costMicro: 3_100, costLowerBound: true }), turn(1, { costMicro: null, costLowerBound: true }), turn(2), turn(3, { costMicro: 0 }), turn(4, { hasRoot: false, rootName: null })],
      };
    case "truncated":
      return { ...base, threadId: "sess-long-running", turns: Array.from({ length: 12 }, (_, i) => turn(i)), truncated: true };
    case "untraced":
      return { ...base, threadId: "sess-mixed", turns: [turn(0), turn(1), turn(2)], untracedEvents: 7 };
    case "no-traces":
      return { ...base, threadId: "sess-no-trace-ids", turns: [], untracedEvents: 5 };
    case "hostile":
      return {
        ...base,
        threadId: HOSTILE_THREAD_IDS[0],
        turns: HOSTILE_THREAD_IDS.map((id, i) => turn(i, { traceId: id, rootName: i % 2 === 0 ? id : null, errorCount: i % 3 === 0 ? 1 : 0 })),
      };
    case "many":
      return { ...base, threadId: "sess-many-turns", turns: Array.from({ length: 200 }, (_, i) => turn(i, { startedAtMs: NOW - (400 - i) * MIN })) };
  }
}
