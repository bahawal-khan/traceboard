import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TracesView, type TracesViewProps } from "@/components/dashboard/traces-view";
import { PROJECT_NAV_ITEMS } from "@/lib/dashboard/nav";
import { traceDetailHref } from "@/lib/dashboard/trace-detail-view";
import {
  DEFAULT_TRACE_RANGE, TRACES_PAGE_SIZE, buildTracesHref, parseCursorParam, parseTraceRange, parseTraceStatus, repoStatus,
  toTraceRowView, traceCostView, traceRangeWindow,
} from "@/lib/dashboard/traces-view";
import type { TraceListItem } from "@/lib/repo/traces";

const NOW = Date.UTC(2026, 10, 21, 12, 30, 0);
const BASE = "/dashboard/projects/p1/traces";
const KEYS = "/dashboard/projects/p1/keys";
const item = (o: Partial<TraceListItem> = {}): TraceListItem => ({
  traceId: "tr-aaaa", startedAtMs: NOW - 5_000, durationMs: 1_200, spanCount: 4, errorCount: 0, totalTokens: 1_500, costMicro: 3_100, costLowerBound: false,
  unpricedEvents: 0, rootName: "agent.run", hasRoot: true, ...o,
});
const view = (o: Partial<TracesViewProps> = {}) =>
  renderToStaticMarkup(createElement(TracesView, { items: [item()], range: "24h", status: "all", hasCursor: false, nextCursor: null, truncated: false, basePath: BASE, keysHref: KEYS, rowHref: (id: string) => traceDetailHref(BASE, id), ...o }));
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("URL parameters", () => {
  it("range: exactly 24h, 7d or 14d; anything else is 24h", () => {
    for (const r of ["24h", "7d", "14d"]) expect(parseTraceRange(r)).toBe(r);
    for (const bad of [undefined, "", "1h", "24H", " 7d", "7d ", "30d", "90d", "7", "all", "7d,14d", "__proto__"]) expect(parseTraceRange(bad)).toBe(DEFAULT_TRACE_RANGE);
    expect(parseTraceRange(["14d", "7d"])).toBe("14d");
    expect(parseTraceRange([])).toBe("24h");
  });
  it("status: exactly 'errors' filters; everything else is all", () => {
    expect(parseTraceStatus("errors")).toBe("errors");
    for (const bad of [undefined, "", "error", "ERRORS", "ok", "all", " errors", ["x"]]) expect(parseTraceStatus(bad)).toBe("all");
    expect(parseTraceStatus(["errors", "all"])).toBe("errors");
    expect(repoStatus("errors")).toBe("error");
    expect(repoStatus("all")).toBeUndefined();
  });
  it("cursor: only a short base64url string gets through", () => {
    expect(parseCursorParam("abc_DEF-123")).toBe("abc_DEF-123");
    expect(parseCursorParam(["abc", "def"])).toBe("abc");
    for (const bad of [undefined, "", "a b", "a=", "a/b", "a+b", "a'b", "<script>", "a\nb", "x".repeat(513), [], ["", "abc"]]) expect(parseCursorParam(bad as never)).toBeUndefined();
    expect(parseCursorParam("x".repeat(512))).toHaveLength(512);
  });
  it("the window ends now and is as long as the range", () => {
    expect(traceRangeWindow("24h", NOW)).toEqual({ fromMs: NOW - 24 * 3_600_000, toMs: NOW });
    expect(traceRangeWindow("14d", NOW).toMs - traceRangeWindow("14d", NOW).fromMs).toBe(14 * 24 * 3_600_000);
  });
  it("page size is the documented 50", () => expect(TRACES_PAGE_SIZE).toBe(50));
});

describe("links", () => {
  it("defaults stay out of the URL; non-defaults and the cursor go in", () => {
    expect(buildTracesHref(BASE, { range: "24h", status: "all" })).toBe(BASE);
    expect(buildTracesHref(BASE, { range: "7d", status: "all" })).toBe(`${BASE}?range=7d`);
    expect(buildTracesHref(BASE, { range: "24h", status: "errors", cursor: "abc" })).toBe(`${BASE}?status=errors&cursor=abc`);
    expect(buildTracesHref(BASE, { range: "14d", status: "errors", cursor: null }, { view: "traces" })).toBe(`${BASE}?view=traces&range=14d&status=errors`);
  });
});

describe("row view-model", () => {
  it("formats time in UTC with seconds, duration, counts and tokens", () => {
    const r = toTraceRowView(item({ startedAtMs: Date.UTC(2026, 10, 21, 14, 5, 9, 999), durationMs: 1_200, spanCount: 1_234, totalTokens: 12_450 }));
    expect(r).toMatchObject({ started: "2026-11-21 14:05:09", duration: "1.2 s", spans: "1,234", tokens: "12.4k" });
  });
  it("cost: unknown is a dash, a lower bound is '≥ $x', a real zero is $0.00", () => {
    expect(traceCostView(null, true)).toEqual({ text: "—", title: "Unknown: no price for this model" });
    expect(traceCostView(null, false).text).toBe("—");
    expect(traceCostView(3_100, true).text).toBe("≥ $0.0031");
    expect(traceCostView(3_100, false)).toEqual({ text: "$0.0031", title: null });
    expect(traceCostView(0, false).text).toBe("$0.00");
    expect(traceCostView(0, true).text).toBe("≥ $0.00");
    expect(traceCostView(null, true).text).not.toContain("0.00");
  });
  it("orphans say so; an unnamed root is not an orphan", () => {
    const o = toTraceRowView(item({ hasRoot: false, rootName: null }));
    expect(o).toMatchObject({ rootLabel: "(no root)", orphan: true });
    expect(o.rootTitle).toContain("No root span");
    expect(toTraceRowView(item({ hasRoot: true, rootName: null }))).toMatchObject({ rootLabel: "(unnamed root)", orphan: false });
    expect(toTraceRowView(item({ rootName: "agent.run" }))).toMatchObject({ rootLabel: "agent.run", orphan: false });
  });
  it("errors: a label with the count; none is null", () => {
    expect(toTraceRowView(item({ errorCount: 0 })).errorLabel).toBeNull();
    expect(toTraceRowView(item({ errorCount: 1 })).errorLabel).toBe("1 error");
    expect(toTraceRowView(item({ errorCount: 12 })).errorLabel).toBe("12 errors");
  });
  it("a trace without any token count shows a dash, not 0", () => {
    expect(toTraceRowView(item({ totalTokens: 0 })).tokens).toBe("—");
  });
});

describe("TracesView HTML", () => {
  const rows = [
    item({ traceId: "tr-ok", rootName: "agent.run", costMicro: 3_100 }),
    item({ traceId: "tr-err", rootName: "failing", errorCount: 2 }),
    item({ traceId: "tr-lb", rootName: "partly priced", costMicro: 3_100, costLowerBound: true, unpricedEvents: 1 }),
    item({ traceId: "tr-unk", rootName: "unpriced", costMicro: null, costLowerBound: true, unpricedEvents: 2 }),
    item({ traceId: "tr-zero", rootName: "free", costMicro: 0 }),
    item({ traceId: "tr-orphan", rootName: null, hasRoot: false }),
  ];
  const html = view({ items: rows });

  it("renders every trace twice: a table from md up and cards below, switched by CSS", () => {
    expect(html).toContain('class="hidden md:block"');
    expect(html).toContain("md:hidden");
    expect(count(html, "tr-ok")).toBeGreaterThanOrEqual(2);
    expect(count(html, "<tr")).toBe(rows.length + 1); // one header row
    expect(html).toContain("Started (UTC)");
  });
  it("shows the cost rules and the orphan label", () => {
    expect(html).toContain("≥ $0.0031");
    expect(html).toContain("$0.00");
    expect(html).toContain("—");
    expect(html).toContain("(no root)");
    // the unknown-cost row never reads $0.00: its cell holds only the dash
    expect(html).toMatch(/title="Unknown: no price for this model"[^>]*>—</);
  });
  it("errors are an icon AND words, not colour only", () => {
    expect(html).toContain("2 errors");
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span>2 errors<\/span>/);
    expect(html).toContain("<span>OK</span>");
  });
  it("every row links to its trace detail, encoded, in both the table and the cards; every other link is a filter, the pager or the nav", () => {
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    for (const h of hrefs) expect(h.startsWith(BASE), h).toBe(true);
    const details = hrefs.filter((h) => h.startsWith(`${BASE}/`));
    expect(details).toHaveLength(rows.length * 2); // table + cards
    for (const r of rows) expect(details.filter((h) => h === `${BASE}/${encodeURIComponent(r.traceId)}`)).toHaveLength(2);
    // detail links carry no query string and nothing but the encoded id
    for (const h of details) expect(h).toMatch(/^\/dashboard\/projects\/p1\/traces\/[A-Za-z0-9._~%-]+$/);
  });

  it("tap targets are 44 px on small screens and nothing forces a wide layout", () => {
    expect(html).toContain("min-h-11");
    expect(html).not.toMatch(/min-w-\[|w-\[\d{3,}px\]/);
  });
  it("escapes names from the SDK", () => {
    const xss = view({ items: [item({ rootName: "<script>alert(1)</script>", traceId: "<img src=x onerror=alert(1)>" })] });
    expect(xss).not.toContain("<script>alert");
    expect(xss).not.toContain("<img src=x");
    expect(xss).toContain("&lt;script&gt;");
  });
  it("shows the Partial data notice only when truncated", () => {
    expect(view({ truncated: true })).toContain("Partial data");
    expect(view({ truncated: false })).not.toContain("Partial data");
  });
  it("marks the current range and status, and filter links drop the cursor but keep the other filter", () => {
    const h = view({ range: "7d", status: "errors", hasCursor: true, nextCursor: "NEXT" });
    expect(h).toMatch(/href="[^"]*range=14d[^"]*"/);
    for (const m of h.matchAll(/<a href="([^"]*)"[^>]*>(24 hours|7 days|14 days|All traces|Errors only)</g)) {
      expect(m[1], m[2]).not.toContain("cursor=");
    }
    expect(h).toContain(`href="${BASE}?range=24h&amp;status=errors"`.replace("range=24h&amp;", ""));
    expect(h).toContain(`href="${BASE}?range=7d"`); // "All traces" keeps 7d
    expect(count(h, 'aria-current="page"')).toBe(2);
  });
  it("paging: Older uses nextCursor and keeps the filters; Newest drops the cursor; the last page has no Older", () => {
    const h = view({ range: "7d", status: "errors", hasCursor: true, nextCursor: "NEXT_abc" });
    expect(h).toContain(`href="${BASE}?range=7d&amp;status=errors&amp;cursor=NEXT_abc"`);
    expect(h).toContain(`href="${BASE}?range=7d&amp;status=errors"`);
    expect(h).toContain(">Older<");
    expect(h).toContain(">Newest<");
    const last = view({ hasCursor: true, nextCursor: null });
    expect(last).not.toContain(">Older<");
    expect(view({ hasCursor: false, nextCursor: "N" })).not.toContain(">Newest<");
    expect(view({ hasCursor: false, nextCursor: null })).not.toContain(">Older<");
  });
});

describe("TracesView empty states", () => {
  it("no traces in the window: says so and points to the quickstart and the keys page", () => {
    const h = view({ items: [], range: "24h" });
    expect(h).toContain("No traces in the last 24 hours");
    expect(h).toContain(`href="${KEYS}"`);
    expect(h).toContain("pip install ./sdk/python");
    expect(h).toContain("Look at the last 7 days");
    expect(view({ items: [], range: "14d" })).toContain("No traces in the last 14 days");
  });
  it("the quickstart's 'last 7 days' link stays on this page", () => {
    expect(view({ items: [], range: "24h" })).toContain(`href="${BASE}?range=7d"`);
  });
  it("errors only with no match is NOT the quickstart: it says no traces have errors and offers all traces", () => {
    const h = view({ items: [], status: "errors", range: "7d" });
    expect(h).toContain("No traces with errors in the last 7 days");
    expect(h).toContain("Show all traces");
    expect(h).toContain(`href="${BASE}?range=7d"`);
    expect(h).not.toContain("pip install");
  });
  it("an empty page past the end says there is nothing older and links back to the newest", () => {
    const h = view({ items: [], hasCursor: true });
    expect(h).toContain("No older traces");
    expect(h).toContain(">Newest<");
    expect(h).not.toContain("pip install");
  });
  it("an empty truncated window still shows the partial notice", () => {
    expect(view({ items: [], truncated: true })).toContain("Partial data");
  });
});

describe("static checks", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  const page = read("app/dashboard/projects/[id]/traces/page.tsx");
  const sources = ["components/dashboard/traces-view.tsx", "lib/dashboard/traces-view.ts", "app/dashboard/projects/[id]/traces/page.tsx"];

  it("the Traces tab sits between Overview and API keys, and its page exists", () => {
    expect(PROJECT_NAV_ITEMS.map((i) => i.segment)).toEqual(["", "traces", "keys"]);
    expect(PROJECT_NAV_ITEMS[1]).toEqual({ segment: "traces", label: "Traces" });
  });
  it("the page gets data only from getProject and listTracesTolerant with a session context, validates every parameter, and shares one not-found page", () => {
    expect(page).toContain('import { listTracesTolerant } from "@/lib/repo/traces"');
    expect(page).toContain("const ctx = await ctxFromSession()");
    expect(page).toContain('if (!ctx) redirect("/sign-in")');
    expect(page).toContain("parseTraceRange(query.range)");
    expect(page).toContain("parseTraceStatus(query.status)");
    expect(page).toContain("parseCursorParam(query.cursor)");
    expect(page).toContain("listTracesTolerant(ctx, id,");
    expect(page).toMatch(/if \(isNotFoundLike\(e\)\) notFound\(\);\s*throw e;/);
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toMatch(/robots: \{ index: false/);
  });
  it("no client component, no locale formatting, no raw HTML; the row link comes only from the rowHref prop", () => {
    for (const f of sources) {
      const s = read(f);
      expect(s, f).not.toMatch(/["']use client["']/);
      expect(s, f).not.toMatch(/toLocale|Intl\.DateTimeFormat|dangerouslySetInnerHTML/);
    }
    // the component never builds a detail URL itself (the page and the fixtures decide where a row leads)
    expect(read("components/dashboard/traces-view.tsx")).not.toMatch(/\/traces\/\$|href=\{`/);
    expect(read("components/dashboard/traces-view.tsx")).toContain("href={rowHref(");
    expect(page).toContain("traceDetailHref(`${base}/traces`, traceId)");
  });
});
