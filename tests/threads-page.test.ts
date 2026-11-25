import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadsView, type ThreadsViewProps } from "@/components/dashboard/threads-view";
import { PROJECT_NAV_ITEMS } from "@/lib/dashboard/nav";
import { HOSTILE_THREAD_FIXTURES, HOSTILE_THREAD_IDS, THREAD_FIXTURES } from "@/lib/dashboard/thread-fixtures";
import {
  THREADS_PAGE_SIZE, THREAD_ID_LABEL_CHARS, buildThreadsHref, displayThreadId, parseCursorParam, parseTraceRange, threadCostView, threadDetailHref,
  threadIdLabel, toThreadRowView, traceRangeWindow,
} from "@/lib/dashboard/threads-view";
import type { ThreadListItem } from "@/lib/repo/threads";

const NOW = Date.UTC(2026, 10, 21, 12, 30, 0);
const BASE = "/dashboard/projects/p1/threads";
const TRACES = "/dashboard/projects/p1/traces";
const item = (o: Partial<ThreadListItem> = {}): ThreadListItem => ({
  threadId: "sess-1", startedAtMs: NOW - 600_000, lastActiveAtMs: NOW - 5_000, traceCount: 3, spanCount: 12, errorCount: 0, totalTokens: 1_500,
  costMicro: 3_100, costLowerBound: false, unpricedEvents: 0, ...o,
});
const view = (o: Partial<ThreadsViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(ThreadsView, { items: [item()], range: "24h", hasCursor: false, nextCursor: null, truncated: false, basePath: BASE, tracesHref: TRACES, rowHref: (id: string) => threadDetailHref(BASE, id), ...o }),
  );
const count = (s: string, needle: string) => s.split(needle).length - 1;
const read = (f: string) => readFileSync(f, "utf8");

describe("links", () => {
  it("defaults stay out of the URL; a range, the cursor and fixed parameters go in", () => {
    expect(buildThreadsHref(BASE, { range: "24h" })).toBe(BASE);
    expect(buildThreadsHref(BASE, { range: "7d" })).toBe(`${BASE}?range=7d`);
    expect(buildThreadsHref(BASE, { range: "24h", cursor: "abc" })).toBe(`${BASE}?cursor=abc`);
    expect(buildThreadsHref(BASE, { range: "14d", cursor: null }, { view: "threads" })).toBe(`${BASE}?view=threads&range=14d`);
  });
  it("the thread detail link is ONE encoded path segment, whatever the id holds", () => {
    expect(threadDetailHref(BASE, "sess-1")).toBe(`${BASE}/sess-1`);
    for (const id of [...HOSTILE_THREAD_IDS, "a/b", "..", ".", "%2e%2e", "a?b#c", "x\\y"]) {
      const h = threadDetailHref(BASE, id);
      const seg = h.slice(BASE.length + 1);
      expect(seg, id).not.toMatch(/[/?#\\ <>"']/);
      expect(decodeURIComponent(seg)).toBe(id);
    }
  });
  it("the range and cursor parameters are the Traces page's (same functions)", () => {
    expect(parseTraceRange("7d")).toBe("7d");
    expect(parseTraceRange("90d")).toBe("24h");
    expect(parseCursorParam("abc_DEF-1")).toBe("abc_DEF-1");
    expect(parseCursorParam("a b")).toBeUndefined();
    expect(traceRangeWindow("24h", NOW)).toEqual({ fromMs: NOW - 24 * 3_600_000, toMs: NOW });
  });
  it("page size is the documented 50", () => expect(THREADS_PAGE_SIZE).toBe(50));
});

describe("thread ids", () => {
  it("a short id is shown as is; a long one is cut at 40 characters with an ellipsis; the full id stays in the title", () => {
    expect(threadIdLabel("sess-1")).toBe("sess-1");
    expect(threadIdLabel("x".repeat(40))).toBe("x".repeat(40));
    expect(threadIdLabel("x".repeat(41))).toBe("x".repeat(40) + "…");
    const r = toThreadRowView(item({ threadId: "y".repeat(128) }));
    expect(r.idLabel).toHaveLength(THREAD_ID_LABEL_CHARS + 1);
    expect(r.idTitle).toBe("y".repeat(128));
    expect(r.threadId).toBe("y".repeat(128));
  });
  it("cuts whole characters: an emoji is never split into a broken half", () => {
    const label = threadIdLabel("💬".repeat(60));
    expect(Array.from(label)).toHaveLength(41);
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // no lone surrogate
  });
  it("reordering and invisible characters are made visible in the label and the title, never in the link", () => {
    const evil = "abc‮def​ghi﻿jkl⁦mno";
    expect(displayThreadId(evil)).toBe("abc·def·ghi·jkl·mno");
    const r = toThreadRowView(item({ threadId: evil }));
    expect(r.idLabel).not.toMatch(/[‪-‮⁦-⁩​-‏﻿]/);
    expect(r.idTitle).not.toMatch(/[‪-‮⁦-⁩​-‏﻿]/);
    expect(r.threadId).toBe(evil); // the link needs the real id
    expect(threadDetailHref(BASE, evil)).toContain("%E2%80%AE"); // encoded, so it cannot reorder anything either
  });
});

describe("row view-model", () => {
  it("formats times in UTC with seconds, counts and tokens", () => {
    const r = toThreadRowView(item({ startedAtMs: Date.UTC(2026, 10, 21, 13, 0, 0), lastActiveAtMs: Date.UTC(2026, 10, 21, 14, 5, 9, 999), spanCount: 1_234, totalTokens: 12_450, traceCount: 1_200 }));
    expect(r).toMatchObject({ lastActive: "2026-11-21 14:05:09", started: "2026-11-21 13:00:00", events: "1,234", tokens: "12.4k", turns: "1,200" });
  });
  it("cost: unknown is a dash, a lower bound is '≥ $x', a real zero is $0.00, and the words say thread", () => {
    expect(threadCostView(null, true)).toEqual({ text: "—", title: "Unknown: no price for this model" });
    expect(threadCostView(null, false).text).toBe("—");
    expect(threadCostView(3_100, true)).toEqual({ text: "≥ $0.0031", title: "At least this much: some calls in this thread have no price" });
    expect(threadCostView(3_100, false)).toEqual({ text: "$0.0031", title: null });
    expect(threadCostView(0, false).text).toBe("$0.00");
    expect(threadCostView(0, true).text).toBe("≥ $0.00");
    expect(threadCostView(null, true).text).not.toContain("0.00");
    expect(toThreadRowView(item({ costMicro: null, costLowerBound: true })).cost).toBe("—");
  });
  it("errors: a label with the count; none is null", () => {
    expect(toThreadRowView(item({ errorCount: 0 })).errorLabel).toBeNull();
    expect(toThreadRowView(item({ errorCount: 1 })).errorLabel).toBe("1 error");
    expect(toThreadRowView(item({ errorCount: 2_500 })).errorLabel).toBe("2,500 errors");
  });
  it("a thread without any token count shows a dash, not 0; a thread without trace ids shows a dash with a reason", () => {
    expect(toThreadRowView(item({ totalTokens: 0 })).tokens).toBe("—");
    const r = toThreadRowView(item({ traceCount: 0 }));
    expect(r.turns).toBe("—");
    expect(r.turnsTitle).toContain("no trace id");
    expect(toThreadRowView(item({ traceCount: 2 })).turnsTitle).toBeNull();
  });
  it("accepts a real ThreadListItem (extra fields are fine) and never needs content", () => {
    const keys = Object.keys(toThreadRowView(item())).join(",");
    expect(keys).not.toMatch(/input|output|prompt|content|error[A-Z]?[a-z]*Text/);
  });
});

describe("ThreadsView HTML", () => {
  const rows = [
    item({ threadId: "th-ok", costMicro: 3_100 }),
    item({ threadId: "th-err", errorCount: 2 }),
    item({ threadId: "th-lb", costMicro: 3_100, costLowerBound: true, unpricedEvents: 1 }),
    item({ threadId: "th-unk", costMicro: null, costLowerBound: true, unpricedEvents: 2 }),
    item({ threadId: "th-zero", costMicro: 0 }),
    item({ threadId: "th-notrace", traceCount: 0, totalTokens: 0 }),
  ];
  const html = view({ items: rows });

  it("renders every thread twice: a table from md up and cards below, switched by CSS", () => {
    expect(html).toContain('class="hidden md:block"');
    expect(html).toContain("md:hidden");
    expect(count(html, "th-ok")).toBeGreaterThanOrEqual(2);
    expect(count(html, "<tr")).toBe(rows.length + 1); // one header row
    expect(html).toContain("Last active (UTC)");
  });
  it("shows the cost rules", () => {
    expect(html).toContain("≥ $0.0031");
    expect(html).toContain("$0.00");
    expect(html).toMatch(/title="Unknown: no price for this model"[^>]*>—</);
    expect(html).toContain("some calls in this thread have no price");
  });
  it("errors are an icon AND words, not colour only", () => {
    expect(html).toContain("2 errors");
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span>2 errors<\/span>/);
    expect(html).toContain("<span>OK</span>");
  });
  it("every row links to its thread, encoded, in both the table and the cards; every other link is the range, the pager or the Traces link", () => {
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    const details = hrefs.filter((h) => h.startsWith(`${BASE}/`));
    expect(details).toHaveLength(rows.length * 2);
    for (const r of rows) expect(details.filter((h) => h === `${BASE}/${encodeURIComponent(r.threadId)}`)).toHaveLength(2);
    for (const h of hrefs.filter((x) => !details.includes(x))) expect(h.startsWith(BASE) || h === TRACES, h).toBe(true);
  });
  it("the link has an accessible name with the full id, and a tooltip", () => {
    expect(html).toContain('aria-label="Open thread th-ok"');
    expect(html).toContain('title="th-ok"');
  });
  it("header columns are wide enough for their text (measured in a browser: 'Last active (UTC)' needs 111 px of content), so no header runs into the next", () => {
    const widthOf = (label: string) => {
      const m = new RegExp(`<th[^>]*class="[^"]*\\bw-(\\d+)\\b[^"]*"[^>]*>${label}</th>`).exec(html);
      return m ? Number(m[1]) * 4 : null; // Tailwind w-N = N x 4 px
    };
    const MIN_PX = { "Last active \\(UTC\\)": 128 + 16, Turns: 64, Events: 72, Tokens: 72 }; // text + 8 px padding each side + room
    for (const [label, min] of Object.entries(MIN_PX)) expect(widthOf(label), label).toBeGreaterThanOrEqual(min);
  });
  it("tap targets are 44 px on small screens and nothing forces a wide layout", () => {
    expect(html).toContain("min-h-11");
    expect(html).not.toMatch(/min-w-\[|w-\[\d{3,}px\]/);
  });
  it("shows the Partial data notice only when truncated", () => {
    expect(view({ truncated: true })).toContain("Partial data");
    expect(view({ truncated: false })).not.toContain("Partial data");
  });
  it("marks the current range; range links drop the cursor", () => {
    const h = view({ range: "7d", hasCursor: true, nextCursor: "NEXT" });
    for (const m of h.matchAll(/<a href="([^"]*)"[^>]*>(24 hours|7 days|14 days)</g)) expect(m[1], m[2]).not.toContain("cursor=");
    expect(h).toContain(`href="${BASE}?range=14d"`);
    expect(h).toContain(`href="${BASE}"`);
    expect(count(h, 'aria-current="page"')).toBe(1);
    expect(h).toContain("Showing the last 7 days");
  });
  it("paging: Older uses nextCursor and keeps the range; Most recent drops the cursor; the last page has no Older", () => {
    const h = view({ range: "7d", hasCursor: true, nextCursor: "NEXT_abc" });
    expect(h).toContain(`href="${BASE}?range=7d&amp;cursor=NEXT_abc"`);
    expect(h).toContain(`href="${BASE}?range=7d"`);
    expect(h).toContain(">Older<");
    expect(h).toContain(">Most recent<");
    expect(view({ hasCursor: true, nextCursor: null })).not.toContain(">Older<");
    expect(view({ hasCursor: false, nextCursor: "N" })).not.toContain(">Most recent<");
    expect(view({ hasCursor: false, nextCursor: null })).not.toContain(">Older<");
  });
  it("walks the keyset: the cursor in the link is exactly what the repo gave, untouched", () => {
    const cursor = Buffer.from(JSON.stringify({ k: "th", v: 1, s: "2026-11-21T12:00:00.000001Z", t: "a'b" })).toString("base64url");
    expect(view({ nextCursor: cursor })).toContain(`cursor=${cursor}`);
  });
});

describe("hostile thread ids", () => {
  const html = view({ items: HOSTILE_THREAD_FIXTURES });
  it("no markup from an id reaches the page unescaped", () => {
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });
  it("no reordering or invisible character reaches the page text or attributes", () => {
    expect(html).not.toMatch(/[‪-‮⁦-⁩​-‏﻿]/);
  });
  it("a 128-character id is cut in the row but whole in the tooltip", () => {
    expect(html).not.toContain(`>${"x".repeat(128)}<`);
    expect(html).toContain(`title="${"x".repeat(128)}"`);
    expect(html).toContain("x".repeat(40) + "…");
  });
  it("every row still has exactly one thread link per layout, with a single-segment encoded path", () => {
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!).filter((h) => h.startsWith(`${BASE}/`));
    expect(hrefs).toHaveLength(HOSTILE_THREAD_FIXTURES.length * 2);
    for (const h of hrefs) expect(h.slice(BASE.length + 1), h).not.toMatch(/[/?#\\ <>"']/);
  });
});

describe("fixtures", () => {
  it("cover every cost case and a thread without trace ids", () => {
    const rows = THREAD_FIXTURES.map(toThreadRowView);
    expect(rows.some((r) => r.cost.startsWith("≥"))).toBe(true);
    expect(rows.some((r) => r.cost === "—")).toBe(true);
    expect(rows.some((r) => r.cost === "$0.00")).toBe(true);
    expect(rows.some((r) => r.turns === "—")).toBe(true);
    expect(rows.some((r) => r.errorLabel !== null)).toBe(true);
  });
  it("every fixture id obeys the ingest rule (1 to 128 characters, no control characters)", () => {
    for (const f of [...THREAD_FIXTURES, ...HOSTILE_THREAD_FIXTURES]) {
      expect(f.threadId.length).toBeGreaterThanOrEqual(1);
      expect(f.threadId.length).toBeLessThanOrEqual(128);
      expect(f.threadId).toMatch(/^[^\u0000-\u001f\u007f]*$/);
    }
  });
});

describe("ThreadsView empty states", () => {
  it("no threads in the window: explains what a thread is, shows the SDK hint and links to the traces; no table, no pager", () => {
    const h = view({ items: [] });
    expect(h).toContain("No threads in the last 24 hours");
    expect(h).toContain("thread_id=session_id");
    expect(h).toContain(`href="${TRACES}"`);
    expect(h).not.toContain("<table");
    expect(h).not.toContain('aria-label="Pages"');
  });
  it("the 7-day wording follows the range", () => {
    expect(view({ items: [], range: "7d" })).toContain("No threads in the last 7 days");
  });
  it("without a traces link the card still renders", () => {
    expect(view({ items: [], tracesHref: undefined })).not.toContain("See the traces");
  });
  it("an empty page past the end says there is nothing older and links back to the most recent", () => {
    const h = view({ items: [], hasCursor: true });
    expect(h).toContain("No older threads");
    expect(h).toContain(">Most recent<");
    expect(h).not.toContain("thread_id=session_id");
  });
  it("an empty truncated window still shows the partial notice", () => {
    expect(view({ items: [], truncated: true })).toContain("Partial data");
  });
});

describe("static checks", () => {
  const page = read("app/dashboard/projects/[id]/threads/page.tsx");
  const sources = ["components/dashboard/threads-view.tsx", "lib/dashboard/threads-view.ts", "lib/dashboard/thread-fixtures.ts", "app/dashboard/projects/[id]/threads/page.tsx"];

  it("the Threads tab sits after Traces and before API keys, and its page exists", () => {
    expect(PROJECT_NAV_ITEMS.map((i) => i.segment)).toEqual(["", "traces", "threads", "keys"]);
    expect(PROJECT_NAV_ITEMS[2]).toEqual({ segment: "threads", label: "Threads" });
  });
  it("the page gets data only from getProject and listThreadsTolerant with a session context, validates every parameter, and shares the one not-found page", () => {
    expect(page).toContain('import { listThreadsTolerant } from "@/lib/repo/threads"');
    expect(page).toContain("const ctx = await ctxFromSession()");
    expect(page).toContain('if (!ctx) redirect("/sign-in")');
    expect(page).toContain("parseTraceRange(query.range)");
    expect(page).toContain("parseCursorParam(query.cursor)");
    expect(page).toContain("listThreadsTolerant(ctx, id,");
    expect(page).toMatch(/if \(isNotFoundLike\(e\)\) notFound\(\);\s*throw e;/);
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toMatch(/robots: \{ index: false/);
    expect(page).not.toMatch(/@\/lib\/db|neon|getSql|withTenant/);
  });
  it("no client component, no locale formatting, no raw HTML; the row link comes only from the rowHref prop", () => {
    for (const f of sources) {
      const s = read(f);
      expect(s, f).not.toMatch(/["']use client["']/);
      expect(s, f).not.toMatch(/toLocale|Intl\.DateTimeFormat|dangerouslySetInnerHTML/);
    }
    expect(read("components/dashboard/threads-view.tsx")).not.toMatch(/\/threads\/\$|href=\{`/);
    expect(read("components/dashboard/threads-view.tsx")).toContain("href={rowHref(");
    expect(page).toContain("threadDetailHref(`${base}/threads`, threadId)");
  });
  it("the view modules never import lib/repo or the database (they are shared with static pages)", () => {
    for (const f of ["lib/dashboard/threads-view.ts", "lib/dashboard/thread-fixtures.ts", "components/dashboard/threads-view.tsx"]) {
      expect(read(f), f).not.toMatch(/@\/lib\/repo|@\/lib\/db|@clerk/);
    }
  });
});
