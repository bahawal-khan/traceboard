import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DemoNotFound from "@/app/demo/not-found";
import DemoThreadPage, { dynamicParams, generateStaticParams } from "@/app/demo/threads/[threadId]/page";
import DemoThreadsPage from "@/app/demo/threads/page";
import { ThemeProvider } from "@/components/theme-provider";
import { buildThreadDetailView } from "@/lib/dashboard/thread-detail-view";
import { threadDetailHref, toThreadRowView } from "@/lib/dashboard/threads-view";
import { traceDetailHref } from "@/lib/dashboard/trace-detail-view";
import { assignDemoThreads, generateDemoSnapshot } from "@/lib/demo/generate";
import { getDemoSnapshot } from "@/lib/demo";
import { demoThreadItem, getDemoThreadIds, getDemoThreadList, getDemoThreadView } from "@/lib/demo/threads";
import { demoListItem, getDemoTraceIds } from "@/lib/demo/traces";

const snap = getDemoSnapshot();
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(ThemeProvider, null, el));
const traceById = new Map(snap.traces.map((t) => [t.summary.traceId, t]));

describe("the snapshot's threads", () => {
  it("has several threads of different sizes; some traces have no thread; the orphan never has one", () => {
    expect(snap.threads.length).toBeGreaterThanOrEqual(8);
    const sizes = new Set(snap.threads.map((t) => t.traceIds.length));
    expect(sizes.has(1)).toBe(true);
    expect([...sizes].some((n) => n >= 3)).toBe(true);
    const threaded = snap.threads.flatMap((t) => t.traceIds);
    expect(threaded.length).toBeLessThan(snap.traces.length);
    expect(threaded).not.toContain("tr_orph1");
  });
  it("every trace is in at most one thread, every id is a real sample trace, every thread id is unique and URL-safe", () => {
    const threaded = snap.threads.flatMap((t) => t.traceIds);
    expect(new Set(threaded).size).toBe(threaded.length);
    for (const id of threaded) expect(traceById.has(id), id).toBe(true);
    const ids = snap.threads.map((t) => t.threadId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(encodeURIComponent(id), id).toBe(id);
  });
  it("shows the cases a visitor should see: a failed turn and an unpriced turn (a lower bound), and a thread of one turn", () => {
    const list = getDemoThreadList();
    expect(list.some((t) => t.errorCount > 0)).toBe(true);
    expect(list.some((t) => t.costLowerBound && t.costMicro !== null)).toBe(true);
    expect(list.some((t) => t.traceCount === 1)).toBe(true);
  });
  it("is derived without random numbers: regenerating gives the same threads, and the sample's traces are untouched by it", () => {
    const again = generateDemoSnapshot();
    expect(again.threads).toEqual(snap.threads);
    expect(assignDemoThreads(snap.traces)).toEqual(snap.threads);
    // the order the traces are given in does not matter
    expect(assignDemoThreads([...snap.traces].reverse())).toEqual(snap.threads);
  });
});

describe("the demo thread list", () => {
  const list = getDemoThreadList();
  it("has one row per thread, most recently active first", () => {
    expect(list).toHaveLength(snap.threads.length);
    const last = list.map((t) => t.lastActiveAtMs);
    expect([...last].sort((a, b) => b - a)).toEqual(last);
  });
  it("renders through ThreadsView: every row links to its demo detail, no range, no pager, no filters", () => {
    const h = render(createElement(DemoThreadsPage));
    const hrefs = [...h.matchAll(/href="(\/demo\/threads\/[^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBe(snap.threads.length * 2); // table + cards
    expect(new Set(hrefs).size).toBe(snap.threads.length);
    for (const t of snap.threads) expect(hrefs).toContain(threadDetailHref("/demo/threads", t.threadId));
    expect(h).toContain("The conversations of the demo project");
    for (const gone of ["Time range", "Showing the last", "Most recent<", "Older", "Pages", "Pick a shorter range", "threads on this page"]) expect(h).not.toContain(gone);
    expect(h).toContain("Demo project: sample data");
    expect(h).toMatch(/aria-current="page"[^>]*>Threads</);
  });
  it("the demo tabs are Overview, Traces, Threads, in the dashboard's order", () => {
    const h = render(createElement(DemoThreadsPage));
    const order = ["Overview<", "Traces<", "Threads<"].map((s) => h.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("every link on the page stays in the demo or goes to the public sign-in/up pages", () => {
    const h = render(createElement(DemoThreadsPage));
    for (const m of h.matchAll(/href="([^"]*)"/g)) expect(m[1]!, m[1]).toMatch(/^\/(demo|sign-in|sign-up)?(\/|$)|^\/$/);
  });
  it("cost rules: an unpriced turn makes a lower bound ('≥'), a dash only when nothing is known, never $0.00 for unknown", () => {
    const h = render(createElement(DemoThreadsPage));
    expect(h).toContain("≥ $");
    expect(h).not.toMatch(/\$0\.00(?![0-9])/); // "$0.0006" is a small real cost; a bare "$0.00" would mean a zero
    for (const it of list) {
      const row = toThreadRowView(it);
      if (it.costLowerBound) expect(row.cost, it.threadId).toMatch(/^(≥ \$|—)/);
      if (it.costMicro === null) expect(row.cost, it.threadId).toBe("—");
    }
  });
});

describe("numbers on the demo thread pages equal the numbers computed from the snapshot (parity)", () => {
  // Computed here straight from the raw spans, NOT through lib/demo: the same sums the thread SQL does.
  function fromSpans(traceIds: readonly string[]) {
    const spans = traceIds.flatMap((id) => traceById.get(id)!.spans);
    const known = spans.filter((s) => s.costMicro !== null);
    const unpriced = spans.filter((s) => s.model !== null && s.model !== "" && s.costMicro === null).length;
    return {
      events: spans.length,
      errors: spans.filter((s) => s.status === "error").length,
      tokens: spans.reduce((a, s) => a + (s.inputTokens ?? 0) + (s.outputTokens ?? 0), 0),
      cost: known.length > 0 ? known.reduce((a, s) => a + (s.costMicro as number), 0) : unpriced === 0 ? 0 : null,
      lowerBound: unpriced > 0,
    };
  }
  for (const th of snap.threads) {
    it(`${th.threadId}: list row and detail summary match the spans`, () => {
      const want = fromSpans(th.traceIds);
      const item = demoThreadItem(th.threadId, th.traceIds);
      expect(item).toMatchObject({
        traceCount: th.traceIds.length,
        spanCount: want.events,
        errorCount: want.errors,
        totalTokens: want.tokens,
        costMicro: want.cost,
        costLowerBound: want.lowerBound,
      });
      const starts = th.traceIds.map((id) => Date.parse(traceById.get(id)!.summary.startedAt));
      expect(item.startedAtMs).toBe(Math.min(...starts));
      // the detail page is the dashboard builder on the same turns: same totals, same cost text as the list row
      const view = getDemoThreadView(th.threadId)!;
      const row = toThreadRowView(item);
      expect(view.summary.cost).toBe(row.cost);
      expect(view.summary.events).toBe(row.events);
      expect(view.summary.turns).toBe(row.turns);
      expect(view.summary.tokens).toBe(row.tokens);
      expect(view.summary.errorLabel).toBe(row.errorLabel);
      expect(view.summary.partial).toBe(false);
      expect(view.turns).toHaveLength(th.traceIds.length);
    });
  }
  it("the thread totals add up to the threaded traces' totals", () => {
    const all = getDemoThreadList();
    const threaded = snap.threads.flatMap((t) => t.traceIds);
    expect(all.reduce((a, t) => a + t.spanCount, 0)).toBe(fromSpans(threaded).events);
    expect(all.reduce((a, t) => a + t.totalTokens, 0)).toBe(fromSpans(threaded).tokens);
  });
});

describe("a demo thread detail", () => {
  it("renders for every snapshot thread, through the shared view, with each turn linking to its demo trace page", async () => {
    for (const th of snap.threads) {
      const h = render(await DemoThreadPage({ params: Promise.resolve({ threadId: th.threadId }) }));
      expect(h, th.threadId).toContain("Demo project: sample data");
      expect(h).toMatch(/aria-current="page"[^>]*>Threads</);
      const hrefs = new Set([...h.matchAll(/href="(\/demo\/traces\/[^"]+)"/g)].map((m) => m[1]!));
      expect([...hrefs].sort()).toEqual(th.traceIds.map((id) => traceDetailHref("/demo/traces", id)).sort());
      for (const id of th.traceIds) expect(getDemoTraceIds()).toContain(id);
      expect(h).toContain('href="/demo/threads"'); // the way back
      for (const m of h.matchAll(/href="([^"]*)"/g)) expect(m[1]!, m[1]).toMatch(/^\/(demo|sign-in|sign-up)?(\/|$)|^\/$/);
    }
  });
  it("is the dashboard builder on the same turns: the view equals buildThreadDetailView of the list items", () => {
    const th = snap.threads.find((t) => t.traceIds.length > 1)!;
    const view = getDemoThreadView(th.threadId)!;
    const items = th.traceIds.map((id) => demoListItem(traceById.get(id)!)).sort((a, b) => a.startedAtMs - b.startedAtMs || (a.traceId < b.traceId ? -1 : 1));
    expect(view).toEqual(buildThreadDetailView({ threadId: th.threadId, turns: items, untracedEvents: 0, truncated: false, tracesPath: "/demo/traces" }));
    expect(view.notices.map((n) => n.id)).toEqual(["scope"]);
    expect(view.turns.map((t) => t.n)).toEqual(th.traceIds.map((_, i) => i + 1));
  });
  it("turns are oldest first", () => {
    for (const th of snap.threads) {
      const starts = getDemoThreadView(th.threadId)!.turns.map((t) => t.started);
      expect([...starts].sort(), th.threadId).toEqual(starts);
    }
  });
  it("shows content nowhere: no message or error text from the snapshot is rendered", async () => {
    const h = render(await DemoThreadPage({ params: Promise.resolve({ threadId: snap.threads[0]!.threadId }) }));
    for (const w of ["tool_timeout", "provider_error", "stopped after", "argsHash"]) expect(h).not.toContain(w);
  });
  it("unknown, malformed and hostile ids give Next's not-found (a 404), never a page", async () => {
    for (const id of ["nope", "th_demo_99", "", "TH_DEMO_01", "th_demo_01 ", "a%2Fb", "%E0%A4%A", "%00", "x".repeat(500), "..", "<script>"]) {
      await expect(DemoThreadPage({ params: Promise.resolve({ threadId: id }) }), id).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    }
    expect(getDemoThreadView(["th_demo_01"])).toBeNull();
    expect(getDemoThreadView(undefined)).toBeNull();
  });
  it("only the snapshot's threads exist: dynamicParams is off and every id is a static param", () => {
    expect(dynamicParams).toBe(false);
    expect(generateStaticParams()).toEqual(getDemoThreadIds().map((threadId) => ({ threadId })));
    expect(generateStaticParams()).toHaveLength(snap.threads.length);
  });
});

describe("the static demo thread pages", () => {
  const FILES = ["app/demo/threads/page.tsx", "app/demo/threads/[threadId]/page.tsx", "lib/demo/threads.ts"];
  it("import no repo, db, session, cookies or headers, and read the snapshot only through lib/demo", () => {
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/@\/lib\/repo|@\/lib\/db|@clerk|ctxFromSession|withTenant|next\/headers|\bcookies\(|\bheaders\(|\bfetch\(|process\.env/);
      for (const m of src.matchAll(/from "(@\/lib\/[^"]+)"/g)) expect(m[1]!, f).toMatch(/^@\/lib\/(demo|dashboard)/);
    }
  });
  it("the thread detail page sets dynamicParams = false and the list page is not force-dynamic", () => {
    expect(readFileSync("app/demo/threads/[threadId]/page.tsx", "utf8")).toMatch(/export const dynamicParams = false;/);
    for (const f of FILES.slice(0, 2)) expect(readFileSync(f, "utf8"), f).not.toMatch(/force-dynamic|revalidate/);
  });
});

describe("the demo not-found page", () => {
  it("is plain, neutral and the same for everything; it links back to /demo and echoes nothing", () => {
    const h = render(createElement(DemoNotFound));
    expect(h).toContain(">Not found<");
    expect(h).toContain("This demo page does not exist.");
    expect(h).toContain('href="/demo"');
    expect(h).not.toMatch(/tr_|th_|trace id|thread id|project|<script/i);
    for (const m of h.matchAll(/href="([^"]*)"/g)) expect(m[1]!, m[1]).toMatch(/^\/(demo|sign-in|sign-up)?(\/|$)|^\/$/);
  });
});
