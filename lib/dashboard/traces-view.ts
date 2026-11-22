import { UNKNOWN, UNKNOWN_COST_TITLE, formatCostMicro, formatDuration, formatInt, formatTokens, formatUtcSeconds } from "@/lib/format";

/**
 * The pure decisions of the Traces list page: URL parameters, links, and the row view-model. Kept out of the page so they
 * are unit tested. Nothing here reads a database; the page passes in what lib/repo returned.
 */

export const TRACES_PAGE_SIZE = 50;

export const TRACE_RANGES = ["24h", "7d", "14d"] as const;
export type TraceRange = (typeof TRACE_RANGES)[number];
export const DEFAULT_TRACE_RANGE: TraceRange = "24h";
const HOUR = 3_600_000;
const RANGE_MS: Record<TraceRange, number> = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "14d": 14 * 24 * HOUR };

export const TRACE_STATUS_FILTERS = ["all", "errors"] as const;
export type TraceStatusFilter = (typeof TRACE_STATUS_FILTERS)[number];

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** `?range=` is user input: exactly 24h, 7d or 14d, otherwise 24h (never a wider window than asked, never an error). */
export function parseTraceRange(value: string | string[] | undefined): TraceRange {
  const v = first(value);
  return TRACE_RANGES.find((r) => r === v) ?? DEFAULT_TRACE_RANGE;
}

/** `?status=`: exactly "errors" means errors only; anything else is "all". */
export function parseTraceStatus(value: string | string[] | undefined): TraceStatusFilter {
  return first(value) === "errors" ? "errors" : "all";
}

/** What lib/repo's `status` option takes for a filter ("all" = no filter). */
export const repoStatus = (f: TraceStatusFilter): "error" | undefined => (f === "errors" ? "error" : undefined);

/**
 * `?cursor=` is opaque and user-controlled. Only a short base64url string gets as far as the repo (which validates it
 * strictly and is the authority); anything else is treated as "no cursor", i.e. the first page.
 */
export function parseCursorParam(value: string | string[] | undefined): string | undefined {
  const v = first(value);
  return typeof v === "string" && v.length > 0 && v.length <= 512 && /^[A-Za-z0-9_-]+$/.test(v) ? v : undefined;
}

/** The requested window; the repo clamps it again (hour alignment, 14-day cap, never the future). */
export function traceRangeWindow(range: TraceRange, nowMs: number = Date.now()): { fromMs: number; toMs: number } {
  return { fromMs: nowMs - RANGE_MS[range], toMs: nowMs };
}

/**
 * Link to a Traces page state. Defaults are left out of the URL (24h, all), so the canonical first page is the bare path.
 * `extra` carries fixed parameters of the host page (the dev fixtures need `view=traces`).
 */
export function buildTracesHref(
  basePath: string,
  s: { range: TraceRange; status: TraceStatusFilter; cursor?: string | null },
  extra: Record<string, string> = {},
): string {
  const q = new URLSearchParams(extra);
  if (s.range !== DEFAULT_TRACE_RANGE) q.set("range", s.range);
  if (s.status !== "all") q.set("status", s.status);
  if (s.cursor) q.set("cursor", s.cursor);
  const text = q.toString();
  return text ? `${basePath}?${text}` : basePath;
}

/**
 * The fields of one list item this module needs. Structurally the same as `TraceListItem` from lib/repo/traces (a type
 * check at the page proves it); declared here so this module, shared with static pages, never imports lib/repo.
 */
export interface TraceItemInput {
  traceId: string;
  startedAtMs: number;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  totalTokens: number;
  costMicro: number | null;
  costLowerBound: boolean;
  rootName: string | null;
  hasRoot: boolean;
}

export interface TraceRowView {
  key: string;
  traceId: string;
  /** "2026-11-21 14:05:09" (UTC; the column header says so). */
  started: string;
  /** Root span name, "(unnamed root)" when the root has no name, "(no root)" for an orphan trace. */
  rootLabel: string;
  rootTitle: string;
  orphan: boolean;
  duration: string;
  spans: string;
  /** null when the trace has no failed event. */
  errorLabel: string | null;
  tokens: string;
  cost: string;
  costTitle: string | null;
  costLowerBound: boolean;
}

/** Cost cell text: unknown = a dash, a lower bound = "≥ $x", a real zero = "$0.00". */
export function traceCostView(costMicro: number | null, lowerBound: boolean): { text: string; title: string | null } {
  if (costMicro === null) return { text: UNKNOWN, title: UNKNOWN_COST_TITLE };
  const amount = formatCostMicro(costMicro);
  return lowerBound ? { text: `≥ ${amount}`, title: "At least this much: some calls in this trace have no price" } : { text: amount, title: null };
}

export function toTraceRowView(t: TraceItemInput): TraceRowView {
  const cost = traceCostView(t.costMicro, t.costLowerBound);
  const rootLabel = t.rootName ?? (t.hasRoot ? "(unnamed root)" : "(no root)");
  return {
    key: t.traceId,
    traceId: t.traceId,
    started: formatUtcSeconds(t.startedAtMs),
    rootLabel,
    rootTitle: t.hasRoot ? rootLabel : "No root span was received for this trace",
    orphan: !t.hasRoot,
    duration: formatDuration(t.durationMs),
    spans: formatInt(t.spanCount),
    errorLabel: t.errorCount === 0 ? null : `${formatInt(t.errorCount)} ${t.errorCount === 1 ? "error" : "errors"}`,
    // A trace without any token count (tool-only) has nothing to total: a dash, not "0".
    tokens: t.totalTokens === 0 ? UNKNOWN : formatTokens(t.totalTokens),
    cost: cost.text,
    costTitle: cost.title,
    costLowerBound: t.costLowerBound,
  };
}
