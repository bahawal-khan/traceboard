import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpanPanel, SpanTable } from "@/components/dashboard/trace-explorer";
import { TraceDetailPageView } from "@/components/dashboard/trace-detail-page-view";
import { buildTraceDetailView, TABLE_ROW_LIMIT, type TraceDetailView } from "@/lib/dashboard/trace-detail-view";
import { TRACE_FIXTURE_NAMES, traceFixture, type TraceFixtureName } from "@/lib/dashboard/trace-fixtures";
import type { SpanInput } from "@/lib/dashboard/trace-tree";

const BACK = "/dashboard/projects/p1/traces";
const read = (f: string) => readFileSync(f, "utf8");
const viewOf = (n: TraceFixtureName) => buildTraceDetailView(traceFixture(n));
const html = (v: TraceDetailView) => renderToStaticMarkup(createElement(TraceDetailPageView, { view: v, backHref: BACK }));
const count = (s: string, needle: string) => s.split(needle).length - 1;
const noop = () => {};

describe("the rendered trace page", () => {
  const h = html(viewOf("ok"));
  it("has a back link, the short id with a copy button, and the summary with labels", () => {
    expect(h).toContain(`href="${BACK}"`);
    expect(h).toContain("Back to traces");
    expect(h).toContain("9f2c41d8…2c3d4e");
    expect(h).toContain('title="9f2c41d8e0a74b6c8d3e5f7a1b2c3d4e"');
    expect(h).toContain("Full trace id: 9f2c41d8e0a74b6c8d3e5f7a1b2c3d4e"); // for screen readers and select-all
    expect(h).toContain('aria-label="Copy the full trace id"');
    for (const label of ["Started (UTC)", "Duration", "Spans", "Errors", "Tokens", "Cost"]) expect(h).toContain(`>${label}<`);
    expect(h).toContain("2026-11-21 12:29:20");
    expect(h).toContain("4.82 s");
    expect(h).toContain("None"); // no errors: words, with an icon
  });
  it("lists spans as a listbox with a position and a name for each row", () => {
    expect(h).toContain('role="listbox"');
    expect(h).toContain('tabindex="0"');
    expect(h).toMatch(/aria-activedescendant="[^"]+-row-0"/);
    expect(count(h, 'role="option"')).toBe(7);
    expect(h).toContain('aria-setsize="7"');
    expect(h).toContain('aria-posinset="1"');
    expect(h).toContain('aria-label="agent.run, level 1, ok, 4.82 s, 5 children"');
    expect(h).toContain("View as table");
  });
  it("has no horizontal-scroll trap: fixed row height, hidden x overflow, and an overall 44 px row", () => {
    expect(h).toContain("height:44px");
    expect(h).toContain("max-height:440px");
    expect(h).toContain("overflow-x-hidden");
    expect(h).not.toMatch(/min-w-\[\d{3,}px\]/);
  });
  it("is the same for every fixture without throwing", () => {
    for (const n of TRACE_FIXTURE_NAMES) expect(html(viewOf(n)).length).toBeGreaterThan(1000);
  });
});

describe("states and cost rules", () => {
  it("failed: errors are an icon AND words, on the summary and on the row", () => {
    const h = html(viewOf("failed"));
    expect(h).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span>3 errors<\/span>/);
    expect(h).toContain("agent.run, level 1, error");
    expect(h).toContain("duration unknown");
  });
  it("unpriced: a lower bound, never $0.00", () => {
    const h = html(viewOf("unpriced"));
    expect(h).toContain("≥ $0.0091");
    expect(h).not.toContain("$0.00<");
  });
  it("unknown cost everywhere is a dash with a reason", () => {
    const only = buildTraceDetailView({ traceId: "t", spans: [{ ...traceFixture("unpriced").spans[1]! }], truncated: false });
    const h = html(only);
    expect(h).toMatch(/title="Unknown: no price for this model"[^>]*>—</);
    expect(h).not.toContain("$0.00");
  });
  it("a real zero cost reads $0.00", () => {
    const v = buildTraceDetailView({ traceId: "t", spans: [{ ...traceFixture("ok").spans[0]!, costMicro: 0 }], truncated: false });
    expect(html(v)).toContain("$0.00");
  });
  it("notices come with an icon and a label (not colour only), one region for all", () => {
    const h = html(viewOf("partial"));
    expect(h).toContain('aria-label="Notices about this trace"');
    for (const label of ["Partial trace", "1 duplicate span id ignored"]) expect(h).toMatch(new RegExp(`<svg[^>]*aria-hidden="true"[\\s\\S]*?</svg><div[^>]*>${label}</div>`));
    const o = html(viewOf("orphan"));
    expect(o).toContain("2 spans have a missing parent");
    expect(html(viewOf("cycle"))).toContain("2 parent loops cut");
    expect(html(viewOf("deep"))).toContain("nested more than 64 levels deep");
    expect(html(viewOf("ok"))).not.toContain("Notices about this trace");
  });
});

describe("2,000 spans", () => {
  const v = viewOf("large");
  const h = html(v);
  const rendered = count(h, 'role="option"');
  it("renders only a screenful of rows, not 2,000", () => {
    // the number reported in the step summary
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(30);
    expect(h).toContain('aria-setsize="2000"');
    expect(h).toContain("height:88000px"); // 2,000 x 44 px of scroll height, held by one spacer
  });
  it("the page HTML stays small", () => {
    expect(h.length).toBeLessThan(250_000);
  });
  it("the span count and the partial notice are shown", () => {
    expect(h).toContain("2,000 spans");
    expect(h).toContain("Partial trace");
  });
});

describe("the table fallback", () => {
  const v = viewOf("large");
  const t = renderToStaticMarkup(createElement(SpanTable, { spans: v.spans, selectedKey: null, onSelect: noop }));
  it("is bounded", () => {
    expect(count(t, "<tr")).toBe(TABLE_ROW_LIMIT + 1); // plus the header row
    expect(t).toContain("Showing the first 200 of 2,000 spans");
    expect(t).toContain("the first 200 of 2,000");
  });
  it("is a labelled, focusable scroller with real headers and 44 px buttons", () => {
    expect(t).toContain('role="region"');
    expect(t).toContain('aria-label="Spans table (scrolls sideways)"');
    expect(count(t, "<th ")).toBe(9);
    expect(t).toContain("min-h-11");
  });
  it("a short trace is shown whole, with no 'first N' text", () => {
    const small = renderToStaticMarkup(createElement(SpanTable, { spans: viewOf("ok").spans, selectedKey: "s2", onSelect: noop }));
    expect(count(small, "<tr")).toBe(8);
    expect(small).not.toContain("Showing the first");
    expect(small).toContain('aria-pressed="true"');
  });
});

describe("the selected-span panel", () => {
  const spans = viewOf("failed").spans;
  it("starts with a hint", () => {
    const p = renderToStaticMarkup(createElement(SpanPanel, { span: null }));
    expect(p).toContain("Select a span to see its details");
  });
  it("shows metadata only, with words for status and flags", () => {
    const err = spans.find((s) => s.isError && s.marker)!;
    const p = renderToStaticMarkup(createElement(SpanPanel, { span: err }));
    for (const label of ["Kind", "Model", "Starts at", "Duration", "Input tokens", "Output tokens", "Cached tokens", "Cost", "Level", "Children", "Span id"]) expect(p).toContain(`>${label}<`);
    expect(p).toContain("Error");
    expect(p).toContain("Duration unknown");
    expect(p).toContain("Unknown");
    expect(p).not.toMatch(/input_text|output_text|messages|prompt|response text/i);
  });
});

describe("no message content, ever", () => {
  it("a span view has exactly the metadata fields, none of them free text beyond the span's own name", () => {
    const keys = Object.keys(viewOf("ok").spans[0]!).sort();
    expect(keys).toEqual(
      [
        "cachedTokens", "childCount", "costMicro", "cycleBroken", "depth", "depthCapped", "durationKnown", "durationMs", "inputTokens", "isError", "key", "kind",
        "label", "leftPct", "marker", "model", "orphan", "outputTokens", "parentKey", "startInvalid", "startOffsetMs", "startUs", "unnamed", "unpriced", "widthPct",
      ].sort(),
    );
  });
  it("a hostile span name is escaped, in the list, the table and the panel", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const spans: SpanInput[] = [{ ...traceFixture("ok").spans[0]!, name: evil, key: 'k"><b>' }];
    const v = buildTraceDetailView({ traceId: "t", spans, truncated: false });
    const all = html(v) + renderToStaticMarkup(createElement(SpanTable, { spans: v.spans, selectedKey: null, onSelect: noop })) + renderToStaticMarkup(createElement(SpanPanel, { span: v.spans[0]! }));
    expect(all).not.toContain("<img");
    expect(all).not.toContain("<b>");
    expect(all).toContain("&lt;img");
  });
});

describe("static checks of the sources", () => {
  const page = read("app/dashboard/projects/[id]/traces/[traceId]/page.tsx");
  const sources = [
    "app/dashboard/projects/[id]/traces/[traceId]/page.tsx",
    "components/dashboard/trace-detail-page-view.tsx",
    "components/dashboard/trace-explorer.tsx",
    "components/dashboard/trace-waterfall.tsx",
    "components/dashboard/copy-button.tsx",
    "lib/dashboard/trace-detail-view.ts",
    "lib/dashboard/trace-fixtures.ts",
  ];
  it("the page validates the trace id before the session, then reads through getTrace and getProject only", () => {
    // the segment arrives percent-encoded: it is decoded once and validated (decodeRouteIdParam does both) before the session
    expect(page.indexOf("decodeRouteIdParam(rawTraceId)")).toBeGreaterThan(-1);
    expect(page.indexOf("decodeRouteIdParam(rawTraceId)")).toBeLessThan(page.indexOf("ctxFromSession()"));
    expect(page).not.toMatch(/getTrace\(ctx, id, rawTraceId\)/); // never the undecoded segment
    expect(page).toMatch(/if \(traceId === null\) notFound\(\);/);
    expect(page).toContain("getTrace(ctx, id, traceId)");
    expect(page).toContain("getProject(ctx, id)");
    expect(page).toContain('import { getTrace } from "@/lib/repo/trace-detail"');
  });
  it("it is force-dynamic, noindex, and the shared not-found path is the only one", () => {
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toMatch(/robots: \{ index: false/);
    expect(page).toMatch(/if \(isNotFoundLike\(e\)\) notFound\(\);\s*throw e;/);
    expect(page).not.toMatch(/NotFoundError|catch \{/);
  });
  it("no database client, SQL, locale formatting, raw HTML or network in any of the new sources", () => {
    for (const f of sources) {
      const s = read(f);
      expect(s, f).not.toMatch(/@\/lib\/db|getSql|@neondatabase|withTenant|runScoped/);
      expect(s, f).not.toMatch(/toLocale|Intl\.DateTimeFormat|dangerouslySetInnerHTML|\bfetch\(|process\.env/);
      expect(s, f).not.toMatch(/event_content|input_text|output_text|redaction_report/i);
    }
  });
  it("the view-model and fixtures never import lib/repo (they are shared with static pages)", () => {
    for (const f of ["lib/dashboard/trace-detail-view.ts", "lib/dashboard/trace-fixtures.ts"]) expect(read(f), f).not.toMatch(/@\/lib\/repo/);
  });
  it("only the explorer, the waterfall and the copy button are client components", () => {
    for (const f of sources) {
      const isClient = /^\s*["']use client["']/.test(read(f));
      expect(isClient, f).toBe(["components/dashboard/trace-explorer.tsx", "components/dashboard/trace-waterfall.tsx", "components/dashboard/copy-button.tsx"].includes(f));
    }
  });
  it("react-virtual is pinned to an exact version", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@tanstack/react-virtual"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("row height is the 44 px tap target and the list is a fixed height", () => {
    const w = read("components/dashboard/trace-waterfall.tsx");
    expect(w).toContain("WATERFALL_ROW_HEIGHT = 44");
    expect(w).toContain("estimateSize: () => WATERFALL_ROW_HEIGHT");
  });
});

describe("the 0 ms trace", () => {
  it("says all spans ran within the same millisecond, not '0 ms scale'", () => {
    const h = html(viewOf("instant"));
    expect(h).toContain("All spans ran within the same millisecond.");
    expect(h).not.toMatch(/on a 0 ms scale/);
    expect(h).toContain("Duration");
  });
});
