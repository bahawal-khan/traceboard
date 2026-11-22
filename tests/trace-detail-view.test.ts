import { describe, expect, it } from "vitest";
import {
  MAX_VISUAL_INDENT_LEVELS, MIN_BAR_PCT, barGeometry, buildTraceDetailView, describeSpan, isSelectKey, moveActive, parseTraceIdParam, shortTraceId,
  scaleSubtitle, spanAriaLabel, traceDetailHref, traceTotals, type SpanView,
} from "@/lib/dashboard/trace-detail-view";
import { TRACE_FIXTURE_NAMES, traceFixture } from "@/lib/dashboard/trace-fixtures";
import { MAX_TREE_DEPTH, type SpanInput } from "@/lib/dashboard/trace-tree";
import { traceIdSchema } from "@/lib/repo/trace-detail";

const sp = (o: Partial<SpanInput> = {}): SpanInput => ({
  key: "a", parentId: null, name: "n", kind: "llm", model: "gpt-4o", isError: false, startUs: 1_000_000_000, latencyMs: 100,
  inputTokens: 10, outputTokens: 5, cachedTokens: null, costMicro: 100, unpriced: false, ...o,
});

describe("the trace id parameter", () => {
  const samples = ["", "a", "tr-ok", "x".repeat(128), "x".repeat(129), "a\u0000b", "a\nb", "a\tb", "a\u007fb", "a b", "é☃", "😀", "../etc/passwd", "a/b", "%00", "<script>"];
  it("accepts exactly what the repo accepts (the two rules cannot drift)", () => {
    for (const s of samples) expect(parseTraceIdParam(s) !== null, JSON.stringify(s)).toBe(traceIdSchema.safeParse(s).success);
  });
  it("returns the id unchanged, and null for anything that is not a single string", () => {
    expect(parseTraceIdParam("tr-ok")).toBe("tr-ok");
    for (const bad of [undefined, ["a", "b"], [], ""] as const) expect(parseTraceIdParam(bad as never)).toBeNull();
    expect(parseTraceIdParam("x".repeat(129))).toBeNull();
  });
  it("detail links encode the id, so it can never break out of the path or add a query", () => {
    expect(traceDetailHref("/t", "a/b?c#d e")).toBe("/t/a%2Fb%3Fc%23d%20e");
    expect(traceDetailHref("/t", "tr-ok")).toBe("/t/tr-ok");
  });
  it("short ids keep the start and the end, whole characters only", () => {
    expect(shortTraceId("short-id")).toBe("short-id");
    expect(shortTraceId("0123456789abcdef")).toBe("0123456789abcdef");
    expect(shortTraceId("9f2c41d8e0a74b6c8d3e5f7a1b2c3d4e")).toBe("9f2c41d8…3d4e".replace("3d4e", "2c3d4e"));
    expect(shortTraceId("😀".repeat(40))).toBe(`${"😀".repeat(8)}…${"😀".repeat(6)}`);
  });
});

describe("bar geometry", () => {
  it("places a span on the scale and keeps a minimum width", () => {
    expect(barGeometry(0, 500, true, 1000)).toEqual({ leftPct: 0, widthPct: 50, marker: false });
    expect(barGeometry(250, 250, true, 1000)).toEqual({ leftPct: 25, widthPct: 25, marker: false });
    expect(barGeometry(500, 0, true, 1000).widthPct).toBe(MIN_BAR_PCT);
  });
  it("an unknown duration is a marker, never a bar", () => {
    expect(barGeometry(100, 0, false, 1000)).toMatchObject({ leftPct: 10, marker: true, widthPct: MIN_BAR_PCT });
  });
  it("a zero or broken scale cannot divide by zero", () => {
    for (const total of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const g = barGeometry(10, 10, true, total);
      expect(g.leftPct).toBe(0);
      expect(g.widthPct).toBe(MIN_BAR_PCT);
    }
  });
  it("whatever the numbers, the bar stays inside 0..100 (seeded fuzz)", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const odd = [0, -1, 1e-9, 1e12, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (let i = 0; i < 5000; i++) {
      const pick = () => (rnd() < 0.2 ? odd[Math.floor(rnd() * odd.length)]! : rnd() * 10 ** Math.floor(rnd() * 8));
      const g = barGeometry(pick(), pick(), rnd() < 0.8, pick());
      expect(g.leftPct).toBeGreaterThanOrEqual(0);
      expect(g.widthPct).toBeGreaterThanOrEqual(MIN_BAR_PCT);
      expect(g.leftPct + g.widthPct).toBeLessThanOrEqual(100 + 1e-9);
      expect(Number.isFinite(g.leftPct) && Number.isFinite(g.widthPct)).toBe(true);
    }
  });
});

describe("summary: cost rules", () => {
  it("sums the priced spans", () => {
    const t = traceTotals([sp({ costMicro: 100 }), sp({ key: "b", costMicro: 250 })], false);
    expect(t).toMatchObject({ costMicro: 350, lowerBound: false });
  });
  it("no priced span: unknown (null), never 0", () => {
    expect(traceTotals([sp({ costMicro: null, unpriced: true })], false).costMicro).toBeNull();
    expect(traceTotals([sp({ costMicro: null, model: null })], false).costMicro).toBeNull();
  });
  it("an unpriced span among priced ones makes the total a lower bound; so does a truncated trace", () => {
    expect(traceTotals([sp(), sp({ key: "b", costMicro: null, unpriced: true })], false)).toMatchObject({ costMicro: 100, lowerBound: true });
    expect(traceTotals([sp()], true).lowerBound).toBe(true);
    expect(traceTotals([sp({ costMicro: null })], true).lowerBound).toBe(false); // nothing to bound
  });
  it("a real zero stays zero", () => {
    expect(traceTotals([sp({ costMicro: 0 })], false)).toMatchObject({ costMicro: 0, lowerBound: false });
    const v = buildTraceDetailView({ traceId: "t", spans: [sp({ costMicro: 0 })], truncated: false });
    expect(v.summary.cost).toBe("$0.00");
  });
  it("renders a dash for unknown and '≥ $x' for a lower bound", () => {
    const unknown = buildTraceDetailView({ traceId: "t", spans: [sp({ costMicro: null, unpriced: true })], truncated: false }).summary;
    expect(unknown.cost).toBe("—");
    expect(unknown.costTitle).toContain("Unknown");
    const lower = buildTraceDetailView({ traceId: "t", spans: [sp({ costMicro: 3100 }), sp({ key: "b", costMicro: null, unpriced: true })], truncated: false }).summary;
    expect(lower.cost).toBe("≥ $0.0031");
    expect(lower.costLowerBound).toBe(true);
  });
  it("tokens: a trace without any count shows a dash, not 0", () => {
    expect(buildTraceDetailView({ traceId: "t", spans: [sp({ inputTokens: null, outputTokens: null })], truncated: false }).summary.tokens).toBe("—");
    expect(buildTraceDetailView({ traceId: "t", spans: [sp({ inputTokens: 1200, outputTokens: 300 })], truncated: false }).summary.tokens).toBe("1.5k");
  });
  it("counts errors with words, and says nothing when there are none", () => {
    const v = (n: number) => buildTraceDetailView({ traceId: "t", spans: Array.from({ length: 3 }, (_, i) => sp({ key: `k${i}`, isError: i < n })), truncated: false }).summary;
    expect(v(0).errorLabel).toBeNull();
    expect(v(1).errorLabel).toBe("1 error");
    expect(v(2).errorLabel).toBe("2 errors");
  });
  it("start is UTC with the deterministic formatter; duration is the trace scale", () => {
    const v = buildTraceDetailView({ traceId: "t", spans: [sp({ startUs: Date.UTC(2026, 10, 21, 14, 5, 9, 999) * 1000, latencyMs: 1500 })], truncated: false });
    expect(v.summary.started).toBe("2026-11-21 14:05:09");
    expect(v.summary.duration).toBe("1.5 s");
  });
  it("an empty span list cannot happen (the repo throws not-found) but cannot crash the view either", () => {
    const v = buildTraceDetailView({ traceId: "t", spans: [], truncated: false });
    expect(v.spans).toEqual([]);
    expect(v.summary.started).toBe("—");
  });
});

describe("notices", () => {
  const ids = (spans: SpanInput[], truncated = false) => buildTraceDetailView({ traceId: "t", spans, truncated }).notices.map((n) => n.id);
  it("none for a clean trace", () => expect(ids([sp(), sp({ key: "b", parentId: "a" })])).toEqual([]));
  it("truncated, orphan, cycle, depth and duplicate each get their own labelled notice", () => {
    expect(ids([sp()], true)).toEqual(["truncated"]);
    expect(ids([sp({ parentId: "ghost" })])).toEqual(["orphan"]);
    expect(ids([sp({ key: "a", parentId: "b" }), sp({ key: "b", parentId: "a" })])).toEqual(["cycle"]);
    expect(ids([sp(), sp({ latencyMs: 5 })])).toEqual(["duplicate"]);
    const chain = Array.from({ length: MAX_TREE_DEPTH + 5 }, (_, i) => sp({ key: `c${i}`, parentId: i === 0 ? null : `c${i - 1}`, startUs: 1e12 + i }));
    expect(ids(chain)).toEqual(["depth"]);
  });
  it("every notice has words and counts are exact", () => {
    const v = buildTraceDetailView({ traceId: "t", spans: [sp({ key: "a", parentId: "x" }), sp({ key: "b", parentId: "y" }), sp({ key: "b", parentId: "y" })], truncated: true });
    expect(v.notices.map((n) => n.label)).toEqual(["Partial trace", "2 spans have a missing parent", "1 duplicate span id ignored"]);
    for (const n of v.notices) expect(n.detail.length).toBeGreaterThan(20);
  });
});

describe("the selected-span description", () => {
  const view = (o: Partial<SpanInput> = {}): SpanView => buildTraceDetailView({ traceId: "t", spans: [sp(o)], truncated: false }).spans[0]!;
  it("shows tokens, cost, status and the UTC start with milliseconds", () => {
    const d = describeSpan(view({ startUs: Date.UTC(2026, 10, 21, 14, 5, 9, 123) * 1000 + 456, cachedTokens: 7, costMicro: 4200, isError: true }));
    expect(d).toMatchObject({ status: "Error", model: "gpt-4o", inputTokens: "10", outputTokens: "5", cachedTokens: "7", cost: "$0.0042", started: "2026-11-21 14:05:09.123", offset: "+0 ms", level: "1" });
  });
  it("unknown values are dashes, and an unpriced span says why", () => {
    const d = describeSpan(view({ costMicro: null, unpriced: true, inputTokens: null, kind: null, model: null }));
    expect(d).toMatchObject({ cost: "—", inputTokens: "—", kind: "—", model: "—" });
    expect(d.costTitle).toContain("no price");
    expect(describeSpan(view({ costMicro: null, unpriced: false })).costTitle).toBe("No cost recorded for this span");
  });
  it("unknown latency is flagged, never shown as 0 ms", () => {
    const d = describeSpan(view({ latencyMs: null }));
    expect(d.duration).toBe("Unknown");
    expect(d.flags).toContain("Duration unknown");
    expect(describeSpan(view({ latencyMs: -5 })).duration).toBe("Unknown");
    expect(describeSpan(view({ latencyMs: 0 })).duration).toBe("0 ms");
  });
  it("orphan, cycle and depth flags are worded", () => {
    expect(describeSpan(view({ parentId: "ghost" })).flags[0]).toMatch(/Parent missing/);
    const c = buildTraceDetailView({ traceId: "t", spans: [sp({ key: "a", parentId: "a" })], truncated: false }).spans[0]!;
    expect(describeSpan(c).flags[0]).toMatch(/loop/);
  });
  it("an unnamed span gets a label, and the aria label says level, status and duration", () => {
    const v = view({ name: null, isError: true, latencyMs: null });
    expect(v.label).toBe("(unnamed span)");
    expect(spanAriaLabel(v)).toBe("(unnamed span), level 1, error, duration unknown");
  });
});

describe("keyboard", () => {
  it("moves one row, a page, or to the ends, and stays inside the list", () => {
    expect(moveActive(0, "ArrowDown", 5)).toBe(1);
    expect(moveActive(4, "ArrowDown", 5)).toBe(4);
    expect(moveActive(0, "ArrowUp", 5)).toBe(0);
    expect(moveActive(3, "ArrowUp", 5)).toBe(2);
    expect(moveActive(0, "PageDown", 50)).toBe(10);
    expect(moveActive(45, "PageDown", 50)).toBe(49);
    expect(moveActive(5, "PageUp", 50)).toBe(0);
    expect(moveActive(7, "Home", 50)).toBe(0);
    expect(moveActive(7, "End", 50)).toBe(49);
  });
  it("ignores other keys and an empty list, and survives a stale index", () => {
    expect(moveActive(0, "a", 5)).toBeNull();
    expect(moveActive(0, "Tab", 5)).toBeNull();
    expect(moveActive(0, "ArrowDown", 0)).toBeNull();
    expect(moveActive(999, "ArrowUp", 5)).toBe(3);
    expect(moveActive(Number.NaN, "ArrowDown", 5)).toBe(1);
    expect(moveActive(-4, "ArrowUp", 5)).toBe(0);
  });
  it("Enter and Space select", () => {
    expect(isSelectKey("Enter")).toBe(true);
    expect(isSelectKey(" ")).toBe(true);
    expect(isSelectKey("a")).toBe(false);
  });
});

describe("the fixtures through the real builder", () => {
  const built = Object.fromEntries(TRACE_FIXTURE_NAMES.map((n) => [n, buildTraceDetailView(traceFixture(n))])) as Record<(typeof TRACE_FIXTURE_NAMES)[number], ReturnType<typeof buildTraceDetailView>>;

  it("are deterministic", () => {
    for (const n of TRACE_FIXTURE_NAMES) expect(traceFixture(n)).toEqual(traceFixture(n));
  });
  it("every span is on the scale and indentation never needs more than the clamp", () => {
    for (const n of TRACE_FIXTURE_NAMES) {
      for (const s of built[n].spans) {
        expect(s.leftPct).toBeGreaterThanOrEqual(0);
        expect(s.leftPct + s.widthPct).toBeLessThanOrEqual(100 + 1e-9);
        expect(s.depth).toBeLessThanOrEqual(MAX_TREE_DEPTH);
      }
    }
    expect(MAX_VISUAL_INDENT_LEVELS).toBeLessThan(MAX_TREE_DEPTH);
  });
  it("ok: seven spans, no notice, no error", () => {
    expect(built.ok.spans).toHaveLength(7);
    expect(built.ok.notices).toEqual([]);
    expect(built.ok.summary.errorLabel).toBeNull();
    expect(built.ok.summary.cost).toBe("$0.017");
  });
  it("failed: three error spans (the root and the failed tool and its call), an unknown-latency marker", () => {
    expect(built.failed.summary.errorLabel).toBe("3 errors");
    const marker = built.failed.spans.filter((s) => s.marker);
    expect(marker).toHaveLength(1);
    expect(marker[0]!.isError).toBe(true);
  });
  it("orphan: no real root, two orphan notices counted", () => {
    expect(built.orphan.notices.map((n) => n.id)).toEqual(["orphan"]);
    expect(built.orphan.notices[0]!.label).toBe("2 spans have a missing parent");
  });
  it("cycle: the loop and the self-parent are cut, nothing is lost", () => {
    expect(built.cycle.notices.map((n) => n.id)).toEqual(["cycle"]);
    expect(built.cycle.spans).toHaveLength(5);
  });
  it("deep: the depth cap notice and a clamped depth", () => {
    expect(built.deep.notices.map((n) => n.id)).toEqual(["depth"]);
    expect(Math.max(...built.deep.spans.map((s) => s.depth))).toBe(MAX_TREE_DEPTH);
  });
  it("unpriced: a lower bound with the dash rule intact per span", () => {
    expect(built.unpriced.summary.cost).toBe("≥ $0.0091");
    expect(built.unpriced.spans.filter((s) => s.unpriced)).toHaveLength(2);
  });
  it("partial: truncated and duplicate notices", () => {
    expect(built.partial.notices.map((n) => n.id)).toEqual(["truncated", "duplicate"]);
  });
  it("large: exactly 2,000 spans, errors, unknown latencies and unpriced calls all present", () => {
    expect(traceFixture("large").spans).toHaveLength(2000);
    expect(built.large.spans).toHaveLength(2000);
    expect(built.large.spans.some((s) => s.isError)).toBe(true);
    expect(built.large.spans.some((s) => s.marker)).toBe(true);
    expect(built.large.spans.some((s) => s.unpriced)).toBe(true);
  });
});

describe("the subtitle under Spans", () => {
  it("normally names the scale", () => {
    expect(scaleSubtitle(7, 4820)).toBe("7 spans on a 4.82 s scale. Bars show when each span ran.");
    expect(scaleSubtitle(1, 1500)).toBe("1 span on a 1.5 s scale. Bars show when each span ran.");
    expect(scaleSubtitle(2, 1)).toBe("2 spans on a 1 ms scale. Bars show when each span ran.");
  });
  it("never says '0 ms scale': a trace within one millisecond says so", () => {
    for (const total of [0, 0.2, 0.49]) {
      const t = scaleSubtitle(3, total);
      expect(t).toBe("3 spans. All spans ran within the same millisecond.");
      expect(t).not.toMatch(/0 ms/);
    }
    expect(scaleSubtitle(1, 0)).toBe("1 span, which ran in under a millisecond.");
    expect(scaleSubtitle(2, Number.NaN)).toBe("2 spans. All spans ran within the same millisecond.");
  });
  it("the instant fixture has a 0 ms total and a clean page of bars", () => {
    const v = buildTraceDetailView(traceFixture("instant"));
    expect(v.totalMs).toBe(0);
    expect(v.summary.duration).toBe("0 ms");
    for (const s of v.spans) expect(s.leftPct + s.widthPct).toBeLessThanOrEqual(100);
  });
});
