import { UNKNOWN, UNKNOWN_COST_TITLE, formatCostMicro, formatInt, formatTokens, formatUtcSeconds } from "@/lib/format";
import { DEFAULT_TRACE_RANGE, type TraceRange } from "@/lib/dashboard/traces-view";

/**
 * The pure decisions of the Threads list page: links and the row view-model. The range, cursor and cost rules are the
 * Traces page's (same functions, same wording), re-exported so the Threads page has one import. Nothing here reads a
 * database; the page passes in what lib/repo returned. Never imports lib/repo (shared with static pages).
 */

export { TRACE_RANGES, parseCursorParam, parseTraceRange, traceRangeWindow } from "@/lib/dashboard/traces-view";

export const THREADS_PAGE_SIZE = 50;

/** Longest id shown in a row; the full id stays in `title` and in the link label. */
export const THREAD_ID_LABEL_CHARS = 40;

/**
 * Link to a Threads page state. Defaults (24h, first page) stay out of the URL.
 * `extra` carries fixed parameters of the host page (the dev fixtures need `view=threads`).
 */
export function buildThreadsHref(basePath: string, s: { range: TraceRange; cursor?: string | null }, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (s.range !== DEFAULT_TRACE_RANGE) q.set("range", s.range);
  if (s.cursor) q.set("cursor", s.cursor);
  const text = q.toString();
  return text ? `${basePath}?${text}` : basePath;
}

/** Link to a thread (the detail page comes in P3.7d). The id is user data, so it is always encoded: one path segment, nothing else. */
export function threadDetailHref(threadsPath: string, threadId: string): string {
  return `${threadsPath}/${encodeURIComponent(threadId)}`;
}

// Characters that change how text is ordered or hide it: bidi embeddings/overrides/isolates, zero-width characters, the BOM.
// A hostile id could use them to look like another id. They are shown as a visible middle dot (display only: links use the real id).
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;

/** The id as it is DISPLAYED: invisible/reordering characters made visible. Not truncated (used for title and labels). */
export function displayThreadId(threadId: string): string {
  return threadId.replace(INVISIBLE, "·");
}

/** The id for a row: at most THREAD_ID_LABEL_CHARS characters (whole code points), then an ellipsis. */
export function threadIdLabel(threadId: string): string {
  const chars = Array.from(displayThreadId(threadId));
  return chars.length <= THREAD_ID_LABEL_CHARS ? chars.join("") : `${chars.slice(0, THREAD_ID_LABEL_CHARS).join("")}…`;
}

/**
 * The fields of one list item this module needs. Structurally the same as `ThreadListItem` from lib/repo/threads (a type
 * check at the page proves it); declared here so this module never imports lib/repo.
 */
export interface ThreadItemInput {
  threadId: string;
  startedAtMs: number;
  lastActiveAtMs: number;
  traceCount: number;
  spanCount: number;
  errorCount: number;
  totalTokens: number;
  costMicro: number | null;
  costLowerBound: boolean;
}

export interface ThreadRowView {
  key: string;
  /** The real id: only for links (encoded by `threadDetailHref`). Never rendered as HTML. */
  threadId: string;
  /** Shortened for the row. */
  idLabel: string;
  /** Full id, for `title` and screen readers. */
  idTitle: string;
  /** "2026-11-21 14:05:09" (UTC; the column header says so). */
  lastActive: string;
  started: string;
  /** Number of turns (traces); a dash when the thread has events but no trace ids. */
  turns: string;
  turnsTitle: string | null;
  events: string;
  /** null when no event failed. */
  errorLabel: string | null;
  tokens: string;
  cost: string;
  costTitle: string | null;
  costLowerBound: boolean;
}

/** Cost cell text, same rules as a trace's: unknown = a dash, a lower bound = "≥ $x", a real zero = "$0.00". Worded for a thread. */
export function threadCostView(costMicro: number | null, lowerBound: boolean): { text: string; title: string | null } {
  if (costMicro === null) return { text: UNKNOWN, title: UNKNOWN_COST_TITLE };
  const amount = formatCostMicro(costMicro);
  return lowerBound ? { text: `≥ ${amount}`, title: "At least this much: some calls in this thread have no price" } : { text: amount, title: null };
}

export function toThreadRowView(t: ThreadItemInput): ThreadRowView {
  const cost = threadCostView(t.costMicro, t.costLowerBound);
  return {
    key: t.threadId,
    threadId: t.threadId,
    idLabel: threadIdLabel(t.threadId),
    idTitle: displayThreadId(t.threadId),
    lastActive: formatUtcSeconds(t.lastActiveAtMs),
    started: formatUtcSeconds(t.startedAtMs),
    turns: t.traceCount === 0 ? UNKNOWN : formatInt(t.traceCount),
    turnsTitle: t.traceCount === 0 ? "These events carry no trace id, so there is no turn to open" : null,
    events: formatInt(t.spanCount),
    errorLabel: t.errorCount === 0 ? null : `${formatInt(t.errorCount)} ${t.errorCount === 1 ? "error" : "errors"}`,
    // No token count on any event (tool-only): a dash, not "0".
    tokens: t.totalTokens === 0 ? UNKNOWN : formatTokens(t.totalTokens),
    cost: cost.text,
    costTitle: cost.title,
    costLowerBound: t.costLowerBound,
  };
}
