import { UNKNOWN, UNKNOWN_COST_TITLE, formatCostMicro, formatDuration, formatInt, formatTokens, formatUtcSeconds } from "@/lib/format";
import { traceDetailHref } from "@/lib/dashboard/trace-detail-view";
import { displayThreadId, threadIdLabel } from "@/lib/dashboard/threads-view";
import type { TraceItemInput } from "@/lib/dashboard/traces-view";

/**
 * The pure decisions of the thread detail page: the URL parameter, the summary, the notices and the per-turn rows. Nothing
 * here reads a database or any message content; the page passes in what lib/repo returned (turns are metadata only).
 * Shared with the dev fixtures, so it never imports lib/repo.
 */

/** A turn as getThread returns it (the trace list's summary of one trace, counting only this thread's events). */
export type TurnInput = TraceItemInput;

const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

/**
 * The thread id from the URL. Next.js hands a page the segment PERCENT-ENCODED (checked in next 16.4.6:
 * shared/lib/router/utils/get-dynamic-param.js re-encodes it with encodeURIComponent), and `threadDetailHref` encodes with the
 * same function, so one decodeURIComponent restores the id exactly. A malformed escape, an empty id, more than 128
 * characters, or a control character gives null (the page then shows the one not-found page; no database call is made).
 * Same rule as ingest and `getThread`.
 */
export function parseThreadIdParam(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128 * 12) return null; // a 128-character id encodes to at most 12 x 128
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return decoded.length >= 1 && decoded.length <= 128 && NO_CONTROL.test(decoded) ? decoded : null;
}

export type ThreadNoticeId = "truncated" | "untraced" | "no-traces" | "scope";

export interface ThreadNotice {
  id: ThreadNoticeId;
  label: string;
  detail: string;
}

export interface ThreadSummaryView {
  /** The id as displayed: shortened, invisible characters made visible. */
  shortId: string;
  /** The whole id, display-safe. */
  fullId: string;
  /** True when `shortId` is not the whole id (the page then also prints `fullId`). */
  idShortened: boolean;
  turns: string;
  events: string;
  /** null when there is no failed event among the shown turns. */
  errorLabel: string | null;
  tokens: string;
  cost: string;
  costTitle: string | null;
  firstActivity: string;
  lastActivity: string;
  /** Something is missing (a cap was hit or events have no trace id): the numbers are lower bounds and say "≥". */
  partial: boolean;
}

export interface TurnRowView {
  key: string;
  /** 1-based position, oldest first. */
  n: number;
  traceId: string;
  /** Trace id as displayed (invisible characters made visible), whole. */
  traceIdTitle: string;
  rootLabel: string;
  orphan: boolean;
  started: string;
  duration: string;
  spans: string;
  errorLabel: string | null;
  tokens: string;
  cost: string;
  costTitle: string | null;
  /** The existing trace detail page for this turn; one encoded path segment. */
  href: string;
}

export interface ThreadDetailView {
  summary: ThreadSummaryView;
  notices: ThreadNotice[];
  turns: TurnRowView[];
}

const plural = (n: number, one: string, many: string) => `${formatInt(n)} ${n === 1 ? one : many}`;
const atLeast = (partial: boolean, text: string) => (partial ? `≥ ${text}` : text);

/**
 * Cost of the whole thread from its turns. A turn with an unknown cost adds nothing (and makes the sum a lower bound); when
 * nothing is known at all the result is unknown, never 0. Missing turns or events without a trace id also make it a lower bound.
 */
export function threadCostSummary(
  turns: readonly Pick<TurnInput, "costMicro" | "costLowerBound">[],
  incomplete: boolean,
): { text: string; title: string | null } {
  const known = turns.filter((t) => t.costMicro !== null);
  if (known.length === 0) return { text: UNKNOWN, title: UNKNOWN_COST_TITLE };
  const sum = known.reduce((a, t) => a + (t.costMicro as number), 0);
  const lower = incomplete || known.length < turns.length || turns.some((t) => t.costLowerBound);
  return lower
    ? { text: `≥ ${formatCostMicro(sum)}`, title: "At least this much: some calls have no price, or part of the thread is not shown" }
    : { text: formatCostMicro(sum), title: null };
}

export function buildThreadDetailView(input: {
  threadId: string;
  turns: readonly TurnInput[];
  untracedEvents: number;
  truncated: boolean;
  /** Base path of the Traces pages (for the turn links). */
  tracesPath: string;
}): ThreadDetailView {
  const { threadId, turns, untracedEvents, truncated, tracesPath } = input;
  const events = turns.reduce((a, t) => a + t.spanCount, 0) + untracedEvents;
  const errors = turns.reduce((a, t) => a + t.errorCount, 0);
  const tokens = turns.reduce((a, t) => a + t.totalTokens, 0);
  const missing = truncated || untracedEvents > 0; // something that would add tokens, errors or cost is not in the turns
  const cost = threadCostSummary(turns, missing);
  const firstMs = turns.length ? Math.min(...turns.map((t) => t.startedAtMs)) : null;
  const lastMs = turns.length ? Math.max(...turns.map((t) => t.startedAtMs + t.durationMs)) : null;
  const shortId = threadIdLabel(threadId);
  const fullId = displayThreadId(threadId);

  const notices: ThreadNotice[] = [];
  if (truncated) {
    notices.push({
      id: "truncated",
      label: "Only part of this thread is shown",
      detail:
        "This thread is larger than one page load reads. When it has more events than the read limit, the oldest events are kept; when it has more turns than fit on the page, the earliest turns are kept. The newest turns may be missing, and the totals above are lower bounds.",
    });
  }
  if (untracedEvents > 0 && turns.length > 0) {
    notices.push({
      id: "untraced",
      label: `${plural(untracedEvents, "event has", "events have")} no trace id`,
      detail: `${plural(untracedEvents, "event is", "events are")} counted in the event total but not shown as turns, because there is no trace to open. Their tokens, errors and cost are not included.`,
    });
  }
  if (turns.length === 0) {
    notices.push({
      id: "no-traces",
      label: "No linkable traces",
      detail: `This thread has ${plural(untracedEvents, "event", "events")}, but none of them carries a trace id, so there is no turn to show or open. Send a trace id with each event (the SDK does this inside a trace) to see the turns.`,
    });
  } else {
    notices.push({
      id: "scope",
      label: "A turn counts only this thread's spans",
      detail: "A turn lists the spans of its trace that carry this thread id. If some spans of a trace were sent without it, the span count here can be lower than on the trace page.",
    });
  }

  return {
    summary: {
      shortId,
      fullId,
      idShortened: shortId !== fullId,
      turns: atLeast(truncated, formatInt(turns.length)),
      events: atLeast(truncated, formatInt(events)),
      errorLabel: errors === 0 ? null : atLeast(missing, `${formatInt(errors)} ${errors === 1 ? "error" : "errors"}`),
      // No token count on any shown event (tool-only): a dash, not "0".
      tokens: tokens === 0 ? UNKNOWN : atLeast(missing, formatTokens(tokens)),
      cost: cost.text,
      costTitle: cost.title,
      firstActivity: firstMs === null ? UNKNOWN : formatUtcSeconds(firstMs),
      lastActivity: lastMs === null ? UNKNOWN : formatUtcSeconds(lastMs),
      partial: missing,
    },
    notices,
    turns: turns.map((t, i) => toTurnRowView(t, i + 1, tracesPath)),
  };
}

export function toTurnRowView(t: TurnInput, n: number, tracesPath: string): TurnRowView {
  const cost =
    t.costMicro === null
      ? { text: UNKNOWN, title: UNKNOWN_COST_TITLE }
      : t.costLowerBound
        ? { text: `≥ ${formatCostMicro(t.costMicro)}`, title: "At least this much: some calls in this turn have no price" }
        : { text: formatCostMicro(t.costMicro), title: null };
  return {
    key: `${n}:${t.traceId}`,
    n,
    traceId: t.traceId,
    traceIdTitle: displayThreadId(t.traceId),
    rootLabel: t.rootName === null ? (t.hasRoot ? "(unnamed root)" : "No root span") : displayThreadId(t.rootName),
    orphan: !t.hasRoot,
    started: formatUtcSeconds(t.startedAtMs),
    duration: formatDuration(t.durationMs),
    spans: formatInt(t.spanCount),
    errorLabel: t.errorCount === 0 ? null : plural(t.errorCount, "error", "errors"),
    tokens: t.totalTokens === 0 ? UNKNOWN : formatTokens(t.totalTokens),
    cost: cost.text,
    costTitle: cost.title,
    href: traceDetailHref(tracesPath, t.traceId),
  };
}
