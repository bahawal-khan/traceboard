import type { TraceItemInput } from "@/lib/dashboard/traces-view";
import { buildTraceDetailView, parseTraceIdParam, type TraceDetailView } from "@/lib/dashboard/trace-detail-view";
import type { SpanInput } from "@/lib/dashboard/trace-tree";
import type { TraceDetail } from "@/lib/dashboard/types";
import { getDemoSnapshot } from "./index";

/**
 * The public demo's trace views, built from the committed snapshot only (no database, no session, no network). The
 * snapshot's own shape (offsets, status text) is adapted to the types the signed-in views use, so the demo renders through
 * the SAME components and cannot drift from them. Error text and argument hashes of the snapshot are never passed on:
 * a span carries only a failure flag, like the real page.
 *
 * Do not import lib/repo or lib/db from here; tests/demo-static.test.ts enforces it.
 */

/** Spans of one snapshot trace as the shared tree builder takes them. Start = trace start + offset (millisecond precision). */
export function demoSpans(t: TraceDetail): SpanInput[] {
  const startMs = Date.parse(t.summary.startedAt);
  return t.spans.map((s) => ({
    key: s.spanId,
    parentId: s.parentId,
    name: s.name,
    kind: s.kind,
    model: s.model,
    isError: s.status === "error",
    startUs: (startMs + s.offsetMs) * 1000,
    latencyMs: s.latencyMs,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cachedTokens: s.cachedTokens,
    costMicro: s.costMicro,
    // The list's rule: a model is named but the price is unknown.
    unpriced: s.model !== null && s.model !== "" && s.costMicro === null,
  }));
}

/** One row of the Traces list, from a snapshot trace (same fields and rules as the signed-in list). */
export function demoListItem(t: TraceDetail): TraceItemInput {
  const root = t.spans.find((s) => s.parentId === null);
  const unpriced = demoSpans(t).filter((s) => s.unpriced).length;
  return {
    traceId: t.summary.traceId,
    startedAtMs: Date.parse(t.summary.startedAt),
    durationMs: t.summary.durationMs,
    spanCount: t.spans.length,
    errorCount: t.spans.filter((s) => s.status === "error").length,
    totalTokens: t.summary.inputTokens + t.summary.outputTokens,
    costMicro: t.summary.costMicro,
    costLowerBound: unpriced > 0,
    rootName: root ? root.name : null,
    hasRoot: root !== undefined,
  };
}

/** Newest first, as the snapshot stores them. */
export function getDemoTraceList(): TraceItemInput[] {
  return getDemoSnapshot().traces.map(demoListItem);
}

export function getDemoTraceIds(): string[] {
  return getDemoSnapshot().traces.map((t) => t.summary.traceId);
}

/** null for an unknown or malformed id: the caller shows the not-found page. Nothing about the id is ever echoed. */
export function getDemoTraceView(rawId: string | string[] | undefined): TraceDetailView | null {
  const id = parseTraceIdParam(rawId);
  if (id === null) return null;
  const t = getDemoSnapshot().traces.find((x) => x.summary.traceId === id);
  return t ? buildTraceDetailView({ traceId: id, spans: demoSpans(t), truncated: false }) : null;
}
