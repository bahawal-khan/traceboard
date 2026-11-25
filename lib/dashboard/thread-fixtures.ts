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
