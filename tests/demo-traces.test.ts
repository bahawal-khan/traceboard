import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DemoNotFound from "@/app/demo/not-found";
import DemoTracePage, { dynamicParams, generateStaticParams } from "@/app/demo/traces/[traceId]/page";
import DemoTracesPage from "@/app/demo/traces/page";
import { ThemeProvider } from "@/components/theme-provider";
import { MIN_BAR_PCT, buildTraceDetailView } from "@/lib/dashboard/trace-detail-view";
import { getDemoSnapshot } from "@/lib/demo";
import { demoListItem, demoSpans, getDemoTraceIds, getDemoTraceList, getDemoTraceView } from "@/lib/demo/traces";

const snap = getDemoSnapshot();
const count = (s: string, needle: string) => s.split(needle).length - 1;
// The header's theme toggle needs its provider (the real root layout supplies it).
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(ThemeProvider, null, el));

describe("the demo trace list", () => {
  const list = getDemoTraceList();
  it("has the 36 sample traces, newest first, one row per trace", () => {
    expect(list).toHaveLength(36);
    expect(getDemoTraceIds()).toHaveLength(36);
    const starts = list.map((t) => t.startedAtMs);
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
  });
  it("applies the same cost and orphan rules as the signed-in list", () => {
    const unpriced = list.filter((t) => t.costLowerBound);
    expect(unpriced.length).toBeGreaterThan(0);
    const orphan = list.find((t) => t.traceId === "tr_orph1")!;
    expect(orphan).toMatchObject({ hasRoot: false, rootName: null, spanCount: 2 });
    const loop = list.find((t) => t.traceId === "tr_loop1")!;
    expect(loop).toMatchObject({ hasRoot: true, rootName: "support-agent", spanCount: 13 });
    expect(loop.errorCount).toBe(1);
  });
  it("renders through TracesView: every row links to its demo detail, no filters, no pager, no range", () => {
    const h = render(createElement(DemoTracesPage));
    const hrefs = [...h.matchAll(/href="(\/demo\/traces\/[^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBe(36 * 2); // table + cards
    expect(new Set(hrefs).size).toBe(36);
    expect(h).toContain("A sample of the demo project");
    for (const gone of ["Time range", "Errors only", "Newest</a>", "Older", "Showing the last", "Pick a shorter range"]) expect(h).not.toContain(gone);
    // the demo banner and both tabs
    expect(h).toContain("Demo project: sample data");
    expect(h).toMatch(/href="\/demo"[^>]*>Overview</);
    expect(h).toMatch(/aria-current="page"[^>]*>Traces</);
    expect(h).toContain("(no root)");
    // the five unpriced traces use only the unpriced model: their cost is unknown (a dash), never $0.00
    expect(count(h, 'title="Unknown: no price for this model"')).toBe(5 * 2);
  });
  it("every link on the page stays in the demo or goes to the public sign-in/up pages", () => {
    const h = render(createElement(DemoTracesPage));
    for (const m of h.matchAll(/href="([^"]*)"/g)) expect(m[1]!, m[1]).toMatch(/^\/(demo|sign-in|sign-up)?(\/|$)|^\/$/);
  });
});

describe("a demo trace detail", () => {
  it("every sample trace builds with the real builder, nothing lost", () => {
    for (const t of snap.traces) {
      const v = getDemoTraceView(t.summary.traceId)!;
      expect(v, t.summary.traceId).not.toBeNull();
      expect(v.spans).toHaveLength(t.spans.length);
      expect(v.summary.spans).toBe(String(t.spans.length).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
    }
  });
  it("the loop is a deep failed trace, the orphan has the orphan notice, the unpriced trace is a lower bound", () => {
    const loop = getDemoTraceView("tr_loop1")!;
    expect(loop.summary.errorLabel).toBe("1 error");
    expect(loop.notices).toEqual([]);
    const orphan = getDemoTraceView("tr_orph1")!;
    expect(orphan.notices.map((n) => n.id)).toEqual(["orphan"]);
    expect(orphan.notices[0]!.label).toBe("2 spans have a missing parent");
    const unpricedId = snap.traces.find((t) => t.summary.unpricedSpans > 0)!.summary.traceId;
    const u = getDemoTraceView(unpricedId)!;
    expect(u.summary.costLowerBound).toBe(true);
    expect(u.summary.cost.startsWith("≥") || u.summary.cost === "—").toBe(true);
    const unpricedSpan = u.spans.find((s) => s.unpriced)!;
    expect(unpricedSpan.costMicro).toBeNull();
  });
  it("an unknown or malformed id is null; nothing is echoed and nothing throws", () => {
    for (const bad of ["", "nope", "tr_99999", "__proto__", "constructor", "tr_00001\u0000", "x".repeat(200), "../dashboard", undefined, ["tr_loop1", "x"]]) {
      expect(getDemoTraceView(bad as never), JSON.stringify(bad)).toBeNull();
    }
  });
  it("only the snapshot's ids are generated, and nothing else is served", () => {
    expect(dynamicParams).toBe(false);
    expect(generateStaticParams()).toHaveLength(36);
    expect(generateStaticParams()[0]).toEqual({ traceId: getDemoTraceIds()[0] });
  });
  it("the page renders the shared detail view: summary, waterfall, panel and the table switch", async () => {
    const el = await DemoTracePage({ params: Promise.resolve({ traceId: "tr_loop1" }) });
    const h = render(el);
    expect(h).toContain('href="/demo/traces"');
    expect(h).toContain("Back to traces");
    expect(h).toContain('role="listbox"');
    expect(h).toContain("View as table");
    expect(h).toContain("Demo project: sample data");
    expect(h).toContain("tr_loop1");
    expect(count(h, 'role="option"')).toBe(13);
    expect(h).toMatch(/Span details/);
  });
  it("an unknown id gives Next's not-found (a 404), never a page", async () => {
    for (const id of ["nope", "tr_99999", ""]) {
      await expect(DemoTracePage({ params: Promise.resolve({ traceId: id }) })).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    }
  });
  it("the not-found page is plain, neutral and the same for everything", () => {
    const h = render(createElement(DemoNotFound));
    expect(h).toContain(">Not found<");
    expect(h).toContain("This demo page does not exist.");
    expect(h).not.toMatch(/tr_|trace id|project/i);
  });
});

describe("the sample's timings look real (a waterfall with real bars, not all at 0 ms)", () => {
  const all = snap.traces.flatMap((t) => t.spans);
  it("no span has a missing or zero latency; the median is in the hundreds of ms or more", () => {
    for (const s of all) expect(s.latencyMs ?? 0).toBeGreaterThan(0);
    const sorted = all.map((s) => s.latencyMs!).sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeGreaterThan(200);
    expect(sorted.at(-1)!).toBeLessThan(120_000);
  });
  it("every trace lasts at least a second and every span sits inside it", () => {
    for (const t of snap.traces) {
      expect(t.summary.durationMs, t.summary.traceId).toBeGreaterThan(1000);
      for (const s of t.spans) expect(s.offsetMs + (s.latencyMs ?? 0), `${t.summary.traceId}/${s.spanId}`).toBeLessThanOrEqual(t.summary.durationMs);
    }
  });
  it("spans start at different times (steps follow each other), so the bars form a staircase", () => {
    for (const t of snap.traces) {
      if (t.spans.length < 3) continue;
      expect(new Set(t.spans.map((s) => s.offsetMs)).size, t.summary.traceId).toBeGreaterThanOrEqual(t.spans.length - 1);
    }
  });
  it("child bars are visible: most are wider than the minimum and none spills out of the scale", () => {
    let wide = 0;
    let total = 0;
    for (const t of snap.traces) {
      const v = buildTraceDetailView({ traceId: t.summary.traceId, spans: demoSpans(t), truncated: false });
      for (const s of v.spans) {
        total += 1;
        if (s.widthPct > MIN_BAR_PCT * 4) wide += 1;
        expect(s.leftPct + s.widthPct).toBeLessThanOrEqual(100 + 1e-9);
      }
    }
    // quick tool calls on a long trace are legitimately thin; measured 89.7% of all spans are wider than 4 x the minimum
    expect(wide / total).toBeGreaterThan(0.85);
  });
  it("the list item and the detail agree on duration and span count", () => {
    for (const t of snap.traces) {
      const i = demoListItem(t);
      expect(i.spanCount).toBe(t.summary.spanCount);
      expect(i.durationMs).toBe(t.summary.durationMs);
    }
  });
});
