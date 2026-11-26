import { isValidIdText } from "@/lib/dashboard/route-id";
import { UNKNOWN, UNKNOWN_COST_TITLE, formatCostMicro, formatDuration, formatInt, formatTokens, formatUtcSeconds } from "@/lib/format";
import { traceCostView } from "@/lib/dashboard/traces-view";
import { MAX_TREE_DEPTH, buildTraceTree, type SpanInput, type TraceTree } from "@/lib/dashboard/trace-tree";

/**
 * The pure decisions of the trace detail page: the URL parameter, the summary, the notices, the waterfall geometry and the
 * text of the selected-span panel. Nothing here reads a database or any message content; the page passes in what
 * lib/repo returned (spans are metadata only). Shared with the dev fixtures, so it never imports lib/repo.
 */

/**
 * Validates a trace id AS IT IS (already decoded): same rule as `traceIdSchema` in lib/repo/trace-detail (1 to 128
 * characters, no control characters); a test keeps the two equal. It does NOT decode. A route segment must go through
 * `decodeRouteIdParam` (lib/dashboard/route-id.ts) first: Next hands pages the percent-encoded segment.
 */
export function parseTraceIdParam(raw: string | string[] | undefined): string | null {
  return typeof raw === "string" && isValidIdText(raw) ? raw : null;
}

/** Link to a trace from the list. The id is user data, so it is always encoded. */
export function traceDetailHref(tracesPath: string, traceId: string): string {
  return `${tracesPath}/${encodeURIComponent(traceId)}`;
}

// ---- waterfall geometry -----------------------------------------------------------------------------------------------

/** Narrowest bar, in percent of the trace length (the CSS adds a pixel minimum on top). */
export const MIN_BAR_PCT = 0.4;
/** Indentation stops growing after this many levels (the real depth stays in the label and the panel). */
export const MAX_VISUAL_INDENT_LEVELS = 10;
/** The table fallback shows at most this many spans. */
export const TABLE_ROW_LIMIT = 200;

export interface BarGeometry {
  leftPct: number;
  widthPct: number;
  /** Unknown latency: drawn as a thin marker instead of a bar. */
  marker: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Position of a span on the trace scale. Always inside 0..100 and never narrower than MIN_BAR_PCT, whatever the input. */
export function barGeometry(startOffsetMs: number, durationMs: number, durationKnown: boolean, totalMs: number): BarGeometry {
  const marker = !durationKnown;
  if (!(totalMs > 0) || !Number.isFinite(totalMs)) return { leftPct: 0, widthPct: MIN_BAR_PCT, marker };
  const left = clamp(Number.isFinite(startOffsetMs) ? (startOffsetMs / totalMs) * 100 : 0, 0, 100 - MIN_BAR_PCT);
  const raw = marker ? MIN_BAR_PCT : Number.isFinite(durationMs) ? (durationMs / totalMs) * 100 : MIN_BAR_PCT;
  return { leftPct: left, widthPct: clamp(raw, MIN_BAR_PCT, 100 - left), marker };
}

// ---- view model -------------------------------------------------------------------------------------------------------

/** One span as the client needs it: plain numbers and strings (it crosses into a client component), no formatting. */
export interface SpanView {
  key: string;
  parentKey: string | null;
  /** The name, or "(unnamed span)". */
  label: string;
  unnamed: boolean;
  kind: string | null;
  model: string | null;
  isError: boolean;
  depth: number;
  childCount: number;
  startUs: number;
  startOffsetMs: number;
  durationMs: number;
  durationKnown: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costMicro: number | null;
  unpriced: boolean;
  orphan: boolean;
  cycleBroken: boolean;
  depthCapped: boolean;
  startInvalid: boolean;
  leftPct: number;
  widthPct: number;
  marker: boolean;
}

export type NoticeId = "truncated" | "orphan" | "cycle" | "depth" | "duplicate";

export interface TraceNotice {
  id: NoticeId;
  /** Short, always shown with an icon. */
  label: string;
  detail: string;
}

export interface TraceSummaryView {
  traceId: string;
  /** For display; the full id is in `traceId` (copy button, title). */
  shortId: string;
  /** "2026-11-21 14:05:09" (UTC), or a dash. */
  started: string;
  duration: string;
  spans: string;
  errorCount: number;
  /** null when no span failed. */
  errorLabel: string | null;
  tokens: string;
  cost: string;
  costTitle: string | null;
  costLowerBound: boolean;
}

export interface TraceDetailView {
  summary: TraceSummaryView;
  notices: TraceNotice[];
  spans: SpanView[];
  totalMs: number;
}

const plural = (n: number, one: string, many: string) => `${formatInt(n)} ${n === 1 ? one : many}`;

/** "9f2c41d8…3d4e": the start and end are what people compare. Whole characters only. */
export function shortTraceId(id: string): string {
  const chars = Array.from(id);
  return chars.length <= 16 ? id : `${chars.slice(0, 8).join("")}…${chars.slice(-6).join("")}`;
}

export function toSpanViews(tree: TraceTree): SpanView[] {
  const total = tree.scale.totalMs;
  return tree.rows.map((r) => {
    const s = r.span;
    const g = barGeometry(r.startOffsetMs, r.durationMs, r.durationKnown, total);
    return {
      key: s.key,
      parentKey: s.parentId,
      label: s.name !== null && s.name !== "" ? s.name : "(unnamed span)",
      unnamed: s.name === null || s.name === "",
      kind: s.kind,
      model: s.model,
      isError: s.isError,
      depth: r.depth,
      childCount: r.childCount,
      startUs: s.startUs,
      startOffsetMs: r.startOffsetMs,
      durationMs: r.durationMs,
      durationKnown: r.durationKnown,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cachedTokens: s.cachedTokens,
      costMicro: s.costMicro,
      unpriced: s.unpriced,
      orphan: r.orphan,
      cycleBroken: r.cycleBroken,
      depthCapped: r.depthCapped,
      startInvalid: r.startInvalid,
      leftPct: g.leftPct,
      widthPct: g.widthPct,
      marker: g.marker,
    };
  });
}

export function traceNotices(tree: TraceTree, truncated: boolean): TraceNotice[] {
  const out: TraceNotice[] = [];
  if (truncated) {
    out.push({
      id: "truncated",
      label: "Partial trace",
      detail: "This trace has more spans than one page shows. The earliest spans are listed; later ones are missing, so totals are lower bounds.",
    });
  }
  if (tree.orphanCount > 0) {
    out.push({
      id: "orphan",
      label: `${plural(tree.orphanCount, "span has", "spans have")} a missing parent`,
      detail: "The parent was never received or is outside the retention window. These spans are shown as extra top-level spans.",
    });
  }
  if (tree.cycleCount > 0) {
    out.push({
      id: "cycle",
      label: `${plural(tree.cycleCount, "parent loop", "parent loops")} cut`,
      detail: "Some spans name each other as parent. Each loop was cut at its earliest span, which is shown as a top-level span.",
    });
  }
  if (tree.depthCappedCount > 0) {
    out.push({
      id: "depth",
      label: `${plural(tree.depthCappedCount, "span is", "spans are")} nested more than ${MAX_TREE_DEPTH} levels deep`,
      detail: `These spans are listed at level ${MAX_TREE_DEPTH + 1}, the deepest level drawn; their real nesting is not shown.`,
    });
  }
  if (tree.duplicates > 0) {
    out.push({
      id: "duplicate",
      label: `${plural(tree.duplicates, "duplicate span id", "duplicate span ids")} ignored`,
      detail: "Only the earliest span with each id is shown.",
    });
  }
  return out;
}

/**
 * Total cost: the sum of the priced spans. No priced span at all = unknown (a dash, never $0.00); some unpriced span or a
 * truncated trace = a lower bound ("≥ $x"). A real zero stays $0.00.
 */
export function traceTotals(spans: readonly SpanInput[], truncated: boolean) {
  let cost = 0;
  let anyCost = false;
  let anyUnpriced = false;
  let tokens = 0;
  let errors = 0;
  for (const s of spans) {
    if (s.costMicro !== null) {
      cost += s.costMicro;
      anyCost = true;
    }
    if (s.unpriced) anyUnpriced = true;
    tokens += (s.inputTokens ?? 0) + (s.outputTokens ?? 0);
    if (s.isError) errors += 1;
  }
  return { costMicro: anyCost ? cost : null, lowerBound: anyUnpriced || (truncated && anyCost), tokens, errors };
}

export function buildTraceDetailView(input: { traceId: string; spans: readonly SpanInput[]; truncated: boolean }): TraceDetailView {
  const tree = buildTraceTree(input.spans);
  const spans = toSpanViews(tree);
  const totals = traceTotals(
    tree.rows.map((r) => r.span),
    input.truncated,
  );
  const cost = traceCostView(totals.costMicro, totals.lowerBound);
  const hasRows = tree.rows.length > 0;
  return {
    summary: {
      traceId: input.traceId,
      shortId: shortTraceId(input.traceId),
      started: hasRows ? formatUtcSeconds(Math.floor(tree.scale.startUs / 1000)) : UNKNOWN,
      duration: hasRows ? formatDuration(tree.scale.totalMs) : UNKNOWN,
      spans: formatInt(tree.rows.length),
      errorCount: totals.errors,
      errorLabel: totals.errors === 0 ? null : plural(totals.errors, "error", "errors"),
      // No token count anywhere (tool-only trace) has nothing to total: a dash, not "0" (same rule as the list).
      tokens: totals.tokens === 0 ? UNKNOWN : formatTokens(totals.tokens),
      cost: cost.text,
      costTitle: cost.title,
      costLowerBound: totals.lowerBound,
    },
    notices: traceNotices(tree, input.truncated),
    spans,
    totalMs: tree.scale.totalMs,
  };
}

/**
 * The line under "Spans". A trace that lasts under a millisecond (it shows as "0 ms") has no scale to speak of, so it says
 * so instead of "on a 0 ms scale".
 */
export function scaleSubtitle(spanCount: number, totalMs: number): string {
  const spans = `${formatInt(spanCount)} ${spanCount === 1 ? "span" : "spans"}`;
  if (!(totalMs >= 0.5)) {
    return spanCount === 1 ? "1 span, which ran in under a millisecond." : `${spans}. All spans ran within the same millisecond.`;
  }
  return `${spans} on a ${formatDuration(totalMs)} scale. Bars show when each span ran.`;
}

// ---- selected span panel ----------------------------------------------------------------------------------------------

export interface SpanDescription {
  title: string;
  status: "Error" | "OK";
  kind: string;
  model: string;
  /** "2026-11-21 14:05:09.123" (UTC) */
  started: string;
  offset: string;
  duration: string;
  durationKnown: boolean;
  level: string;
  inputTokens: string;
  outputTokens: string;
  cachedTokens: string;
  cost: string;
  costTitle: string | null;
  children: string;
  /** Plain-language flags (empty for an ordinary span). */
  flags: string[];
}

const tokenText = (n: number | null) => (n === null ? UNKNOWN : formatInt(n));

export function describeSpan(s: SpanView): SpanDescription {
  const flags: string[] = [];
  if (s.orphan) flags.push("Parent missing: shown as a top-level span");
  if (s.cycleBroken) flags.push("Parent loop cut here");
  if (s.depthCapped) flags.push(`Nested more than ${MAX_TREE_DEPTH} levels deep (listed at level ${MAX_TREE_DEPTH + 1})`);
  if (s.startInvalid) flags.push("Start time unknown: placed at the trace start");
  if (!s.durationKnown) flags.push("Duration unknown");
  const ms = Math.floor(s.startUs / 1000);
  const frac = String(Math.floor(((s.startUs % 1_000_000) + 1_000_000) % 1_000_000 / 1000)).padStart(3, "0");
  const cost = s.costMicro === null ? { text: UNKNOWN, title: s.unpriced ? UNKNOWN_COST_TITLE : "No cost recorded for this span" } : { text: formatCostMicro(s.costMicro), title: null };
  return {
    title: s.label,
    status: s.isError ? "Error" : "OK",
    kind: s.kind ?? UNKNOWN,
    model: s.model !== null && s.model !== "" ? s.model : UNKNOWN,
    started: Number.isFinite(s.startUs) ? `${formatUtcSeconds(ms)}.${frac}` : UNKNOWN,
    offset: `+${formatDuration(s.startOffsetMs)}`,
    duration: s.durationKnown ? formatDuration(s.durationMs) : "Unknown",
    durationKnown: s.durationKnown,
    level: String(s.depth + 1),
    inputTokens: tokenText(s.inputTokens),
    outputTokens: tokenText(s.outputTokens),
    cachedTokens: tokenText(s.cachedTokens),
    cost: cost.text,
    costTitle: cost.title,
    children: formatInt(s.childCount),
    flags,
  };
}

/** The accessible name of a waterfall row: everything the bar shows, in words. */
export function spanAriaLabel(s: SpanView): string {
  const d = describeSpan(s);
  const parts = [s.label, `level ${d.level}`, s.isError ? "error" : "ok", s.durationKnown ? d.duration : "duration unknown"];
  if (s.childCount > 0) parts.push(`${d.children} ${s.childCount === 1 ? "child" : "children"}`);
  return parts.join(", ");
}

// ---- keyboard ---------------------------------------------------------------------------------------------------------

export const KEYBOARD_PAGE = 10;

/** The new active row for a key press, or null when the key is not a navigation key (the caller then leaves it alone). */
export function moveActive(current: number, key: string, count: number, page: number = KEYBOARD_PAGE): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const at = clamp(Number.isInteger(current) ? current : 0, 0, last);
  switch (key) {
    case "ArrowDown":
      return Math.min(last, at + 1);
    case "ArrowUp":
      return Math.max(0, at - 1);
    case "PageDown":
      return Math.min(last, at + page);
    case "PageUp":
      return Math.max(0, at - page);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

export function isSelectKey(key: string): boolean {
  return key === "Enter" || key === " ";
}
