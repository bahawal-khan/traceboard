import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadDetailPageView } from "@/components/dashboard/thread-detail-view";
import {
  buildThreadDetailView, parseThreadIdParam, threadCostSummary, toTurnRowView, type TurnInput,
} from "@/lib/dashboard/thread-detail-view";
import { HOSTILE_THREAD_IDS, THREAD_DETAIL_NAMES, threadDetailFixture } from "@/lib/dashboard/thread-fixtures";
import { threadDetailHref } from "@/lib/dashboard/threads-view";
import { traceIdSchema } from "@/lib/repo/trace-detail";
import type { ThreadTurn } from "@/lib/repo/thread-detail";

const NOW = Date.UTC(2026, 10, 21, 12, 30, 0);
const BASE = "/dashboard/projects/p1/threads";
const TRACES = "/dashboard/projects/p1/traces";
const read = (f: string) => readFileSync(f, "utf8");
const count = (s: string, needle: string) => s.split(needle).length - 1;

const turn = (o: Partial<ThreadTurn> = {}): ThreadTurn => ({
  traceId: "tr-1", startedAtMs: NOW - 600_000, durationMs: 4_000, spanCount: 5, errorCount: 0, totalTokens: 1_500, costMicro: 3_100, costLowerBound: false,
  unpricedEvents: 0, rootName: "support.answer", hasRoot: true, ...o,
});
const build = (turns: ThreadTurn[], o: { untracedEvents?: number; truncated?: boolean; threadId?: string } = {}) =>
  buildThreadDetailView({ threadId: o.threadId ?? "sess-1", turns, untracedEvents: o.untracedEvents ?? 0, truncated: o.truncated ?? false, tracesPath: TRACES });
const render = (v: ReturnType<typeof build>) => renderToStaticMarkup(createElement(ThreadDetailPageView, { view: v, backHref: BASE }));

describe("the thread id parameter", () => {
  it("decodes once: Next hands the page the percent-encoded segment (next 16 get-dynamic-param re-encodes it)", () => {
    expect(parseThreadIdParam("sess-1")).toBe("sess-1");
    expect(parseThreadIdParam("a%20b")).toBe("a b");
    expect(parseThreadIdParam("%F0%9F%92%AC")).toBe("💬");
    expect(parseThreadIdParam("a%2Fb%3Fc%23d")).toBe("a/b?c#d");
    expect(parseThreadIdParam("100%25")).toBe("100%"); // a literal percent sign survives
    expect(parseThreadIdParam("a%2520b")).toBe("a%20b"); // and is NOT decoded twice
  });
  it("round-trips every hostile id through the link helper and Next's re-encoding", () => {
    for (const id of [...HOSTILE_THREAD_IDS, "a/b", "..", ".", "%2e%2e", "100%", "a%20b", "a?b#c", "x\\y", "q=1&r=2", "a+b"]) {
      const href = threadDetailHref(BASE, id);
      const segment = href.slice(BASE.length + 1);
      expect(segment, id).not.toMatch(/[/?#\\ <>"']/); // one safe path segment
      expect(parseThreadIdParam(segment), id).toBe(id);
      expect(parseThreadIdParam(encodeURIComponent(id)), id).toBe(id);
    }
  });
  it("rejects what cannot be an id, with null (the page then shows not-found and makes no database call)", () => {
    for (const bad of [undefined, "", [], ["a"], "%", "%E0%A4%A", "%ZZ", "%00", "%0A", "%1F", "%7F", "a%00b", "x".repeat(129), encodeURIComponent("x".repeat(129)), "x".repeat(2_000)]) {
      expect(parseThreadIdParam(bad as never), String(bad)).toBeNull();
    }
    expect(parseThreadIdParam("x".repeat(128))).toBe("x".repeat(128));
    expect(parseThreadIdParam(encodeURIComponent("💬".repeat(64)))).toBe("💬".repeat(64)); // 128 UTF-16 units, the ingest length rule
  });
  it("an accepted id is accepted by getThread's own rule (the two rules are the same)", () => {
    for (const id of [...HOSTILE_THREAD_IDS, "sess-1", "a b"]) {
      expect(parseThreadIdParam(encodeURIComponent(id))).not.toBeNull();
      expect(traceIdSchema.safeParse(id).success).toBe(true);
    }
  });
  it("fuzz: random strings never throw, and anything accepted is a valid id", () => {
    let seed = 20261125;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const alphabet = "abc019%2F3AFZ/?#\\ \u0000\n‮%%é💬";
    for (let i = 0; i < 1_000; i++) {
      let s = "";
      for (let j = Math.floor(rnd() * 40); j > 0; j--) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = parseThreadIdParam(s);
      if (r !== null) expect(traceIdSchema.safeParse(r).success).toBe(true);
    }
  });
});

describe("summary", () => {
  it("totals the turns: counts, events (with untraced), errors, tokens, cost, first and last activity in UTC", () => {
    const v = build(
      [
        turn({ traceId: "a", startedAtMs: Date.UTC(2026, 10, 21, 10, 0, 0), durationMs: 5_000, spanCount: 4, errorCount: 1, totalTokens: 1_000, costMicro: 1_000 }),
        turn({ traceId: "b", startedAtMs: Date.UTC(2026, 10, 21, 11, 0, 0), durationMs: 90_000, spanCount: 6, errorCount: 2, totalTokens: 2_000, costMicro: 2_500 }),
      ],
      { untracedEvents: 0 },
    );
    expect(v.summary).toMatchObject({
      turns: "2", events: "10", errorLabel: "3 errors", tokens: "3k", cost: "$0.0035", costTitle: null,
      firstActivity: "2026-11-21 10:00:00", lastActivity: "2026-11-21 11:01:30", partial: false,
    });
  });
  it("one error is singular; none is null", () => {
    expect(build([turn({ errorCount: 1 })]).summary.errorLabel).toBe("1 error");
    expect(build([turn()]).summary.errorLabel).toBeNull();
  });
  it("cost: nothing known is a dash (never $0.00); a real zero is $0.00; a mix is a lower bound", () => {
    expect(threadCostSummary([{ costMicro: null, costLowerBound: true }], false)).toEqual({ text: "—", title: "Unknown: no price for this model" });
    expect(threadCostSummary([], false).text).toBe("—");
    expect(threadCostSummary([{ costMicro: 0, costLowerBound: false }], false)).toEqual({ text: "$0.00", title: null });
    expect(threadCostSummary([{ costMicro: 700, costLowerBound: false }, { costMicro: null, costLowerBound: true }], false).text).toBe("≥ $0.0007");
    expect(threadCostSummary([{ costMicro: 700, costLowerBound: true }], false).text).toBe("≥ $0.0007");
    expect(threadCostSummary([{ costMicro: 700, costLowerBound: false }], true).text).toBe("≥ $0.0007"); // part of the thread is not shown
    expect(threadCostSummary([{ costMicro: null, costLowerBound: true }], true).text).toBe("—");
    expect(threadCostSummary([{ costMicro: 0, costLowerBound: false }, { costMicro: 0, costLowerBound: false }], false).text).toBe("$0.00");
    expect(threadCostSummary([{ costMicro: 0, costLowerBound: true }], false).text).toBe("≥ $0.00");
  });
  it("a truncated thread says '≥' on turns, events, errors, tokens and cost; untraced events make tokens, errors and cost lower bounds but not the turn count", () => {
    const t = build([turn({ errorCount: 1 })], { truncated: true }).summary;
    expect(t).toMatchObject({ turns: "≥ 1", events: "≥ 5", errorLabel: "≥ 1 error", tokens: "≥ 1.5k", cost: "≥ $0.0031", partial: true });
    const u = build([turn({ errorCount: 1 })], { untracedEvents: 3 }).summary;
    expect(u).toMatchObject({ turns: "1", events: "8", errorLabel: "≥ 1 error", tokens: "≥ 1.5k", cost: "≥ $0.0031", partial: true });
    const whole = build([turn()]).summary;
    expect(whole).toMatchObject({ turns: "1", events: "5", tokens: "1.5k", cost: "$0.0031", partial: false });
  });
  it("tokens: none on any turn is a dash, not 0", () => {
    expect(build([turn({ totalTokens: 0 })]).summary.tokens).toBe("—");
  });
  it("no turns: activity is a dash; the events are the untraced ones", () => {
    const s = build([], { untracedEvents: 4 }).summary;
    expect(s).toMatchObject({ turns: "0", events: "4", firstActivity: "—", lastActivity: "—", cost: "—", tokens: "—" });
  });
  it("the id: short ones as is; long ones shortened with the whole id kept; invisible characters made visible", () => {
    expect(build([turn()], { threadId: "sess-1" }).summary).toMatchObject({ shortId: "sess-1", fullId: "sess-1", idShortened: false });
    const long = build([turn()], { threadId: "x".repeat(128) }).summary;
    expect(long.shortId).toBe("x".repeat(40) + "…");
    expect(long.fullId).toBe("x".repeat(128));
    expect(long.idShortened).toBe(true);
    const evil = build([turn()], { threadId: "a‮b​c" }).summary;
    expect(evil.shortId).toBe("a·b·c");
    expect(evil.fullId).toBe("a·b·c");
  });
});

describe("notices", () => {
  const ids = (v: ReturnType<typeof build>) => v.notices.map((n) => n.id);
  it("a whole, traced thread has only the scope note", () => {
    expect(ids(build([turn()]))).toEqual(["scope"]);
    expect(build([turn()]).notices[0]!.detail).toContain("carry this thread id");
    expect(build([turn()]).notices[0]!.detail).toContain("lower than on the trace page");
  });
  it("truncated: says only part is shown, oldest events and earliest turns kept", () => {
    const n = build([turn()], { truncated: true }).notices.find((x) => x.id === "truncated")!;
    expect(n.label).toBe("Only part of this thread is shown");
    expect(n.detail).toContain("oldest events are kept");
    expect(n.detail).toContain("earliest turns are kept");
    expect(n.detail).toContain("newest turns may be missing");
  });
  it("untraced events: the count (singular and plural) and why they are not turns", () => {
    expect(build([turn()], { untracedEvents: 1 }).notices.find((x) => x.id === "untraced")!.label).toBe("1 event has no trace id");
    const many = build([turn()], { untracedEvents: 1_234 }).notices.find((x) => x.id === "untraced")!;
    expect(many.label).toBe("1,234 events have no trace id");
    expect(many.detail).toContain("not shown as turns");
  });
  it("no linkable traces: replaces the scope note and the untraced notice, and says what to do", () => {
    const v = build([], { untracedEvents: 5 });
    expect(ids(v)).toEqual(["no-traces"]);
    expect(v.notices[0]).toMatchObject({ label: "No linkable traces" });
    expect(v.notices[0]!.detail).toContain("5 events");
    expect(v.notices[0]!.detail).toContain("trace id");
  });
  it("every combination keeps a fixed order: truncated, untraced, then the scope note", () => {
    expect(ids(build([turn()], { truncated: true, untracedEvents: 2 }))).toEqual(["truncated", "untraced", "scope"]);
    expect(ids(build([], { truncated: true, untracedEvents: 2 }))).toEqual(["truncated", "no-traces"]);
  });
});

describe("turn rows", () => {
  it("formats a turn and links to the existing trace detail page", () => {
    const r = toTurnRowView(turn({ traceId: "tr-9", startedAtMs: Date.UTC(2026, 10, 21, 14, 5, 9, 999), durationMs: 1_200, spanCount: 1_234, totalTokens: 12_450, errorCount: 2 }), 3, TRACES);
    expect(r).toMatchObject({
      n: 3, traceId: "tr-9", started: "2026-11-21 14:05:09", duration: "1.2 s", spans: "1,234", tokens: "12.4k", errorLabel: "2 errors", rootLabel: "support.answer",
      href: `${TRACES}/tr-9`,
    });
  });
  it("root: its name, '(unnamed root)' when it has none, 'No root span' for an orphan", () => {
    expect(toTurnRowView(turn({ rootName: null, hasRoot: true }), 1, TRACES)).toMatchObject({ rootLabel: "(unnamed root)", orphan: false });
    expect(toTurnRowView(turn({ rootName: null, hasRoot: false }), 1, TRACES)).toMatchObject({ rootLabel: "No root span", orphan: true });
  });
  it("cost: unknown is a dash with a reason, a lower bound is '≥ $x', a real zero is $0.00", () => {
    expect(toTurnRowView(turn({ costMicro: null, costLowerBound: true }), 1, TRACES)).toMatchObject({ cost: "—", costTitle: "Unknown: no price for this model" });
    expect(toTurnRowView(turn({ costMicro: 3_100, costLowerBound: true }), 1, TRACES).cost).toBe("≥ $0.0031");
    expect(toTurnRowView(turn({ costMicro: 0 }), 1, TRACES)).toMatchObject({ cost: "$0.00", costTitle: null });
  });
  it("errors none is null; tokens none is a dash", () => {
    const r = toTurnRowView(turn({ errorCount: 0, totalTokens: 0 }), 1, TRACES);
    expect(r.errorLabel).toBeNull();
    expect(r.tokens).toBe("—");
  });
  it("the trace link is ONE encoded path segment for every hostile trace id, and keys are unique even for repeated ids", () => {
    for (const id of [...HOSTILE_THREAD_IDS, "a/b", "..", "a?b#c", "x\\y"]) {
      const r = toTurnRowView(turn({ traceId: id }), 1, TRACES);
      const seg = r.href.slice(TRACES.length + 1);
      expect(seg, id).not.toMatch(/[/?#\\ <>"']/);
      expect(decodeURIComponent(seg)).toBe(id);
      expect(r.traceIdTitle).not.toMatch(/[‪-‮⁦-⁩​-‏﻿]/);
    }
    const v = build([turn({ traceId: "dup" }), turn({ traceId: "dup" })]);
    expect(new Set(v.turns.map((t) => t.key)).size).toBe(2);
  });
  it("turns keep the order getThread gave (oldest first) and are numbered from 1", () => {
    const v = build([turn({ traceId: "c" }), turn({ traceId: "a" }), turn({ traceId: "b" })]);
    expect(v.turns.map((t) => [t.n, t.traceId])).toEqual([[1, "c"], [2, "a"], [3, "b"]]);
  });
  it("has no field that could hold message text", () => {
    expect(Object.keys(toTurnRowView(turn(), 1, TRACES)).join(",")).not.toMatch(/input|output|prompt|content|text/i);
  });
});

describe("the rendered page", () => {
  const rows = [
    turn({ traceId: "tr-ok" }),
    turn({ traceId: "tr-err", errorCount: 2, rootName: "failing" }),
    turn({ traceId: "tr-lb", costMicro: 3_100, costLowerBound: true }),
    turn({ traceId: "tr-unk", costMicro: null, costLowerBound: true }),
    turn({ traceId: "tr-zero", costMicro: 0 }),
    turn({ traceId: "tr-orphan", rootName: null, hasRoot: false }),
  ];
  const html = render(build(rows, { truncated: true, untracedEvents: 2 }));

  it("has a back link, the thread id, the summary labels and the turn table and cards", () => {
    expect(html).toContain(`href="${BASE}"`);
    expect(html).toContain("Back to threads");
    for (const l of ["Turns", "Events", "Errors", "Tokens", "Cost", "First activity (UTC)", "Last activity (UTC)"]) expect(html).toContain(`>${l}<`);
    expect(html).toContain('class="hidden md:block"');
    expect(html).toContain("md:hidden");
    expect(count(html, "<tr")).toBe(rows.length + 1); // one header row
    expect(html).toContain("Turns of this thread, oldest first");
  });
  it("shows the cost rules and the orphan label", () => {
    expect(html).toContain("≥ $0.0031");
    expect(html).toContain("$0.00");
    expect(html).toMatch(/title="Unknown: no price for this model"[^>]*>—</);
    expect(html).toContain("No root span");
  });
  it("errors are an icon AND words, not colour only", () => {
    expect(html).toContain("2 errors");
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span>2 errors<\/span>/);
    expect(html).toContain("<span>OK</span>");
  });
  it("notices: ONE region, each with an icon and a label", () => {
    expect(count(html, 'role="region"')).toBe(1);
    expect(html).toContain('aria-label="Notices about this thread"');
    expect(count(html, 'role="alert"')).toBe(3); // the only alerts on the page are the three notices
    for (const label of ["Only part of this thread is shown", "2 events have no trace id", "A turn counts only this thread&#x27;s spans"]) expect(html).toContain(label);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><div[^>]*>Only part of this thread is shown/);
  });
  it("every turn links to its trace, encoded, in both the table and the cards; the only other link is Back", () => {
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    const details = hrefs.filter((h) => h.startsWith(`${TRACES}/`));
    expect(details).toHaveLength(rows.length * 2);
    for (const r of rows) expect(details.filter((h) => h === `${TRACES}/${encodeURIComponent(r.traceId)}`)).toHaveLength(2);
    expect(hrefs.filter((h) => !h.startsWith(`${TRACES}/`))).toEqual([BASE]);
  });
  it("tap targets are 44 px on small screens and nothing forces a wide layout", () => {
    expect(html).toContain("min-h-11");
    expect(html).toContain("h-11 px-4 sm:h-9");
    expect(html).not.toMatch(/min-w-\[|w-\[\d{3,}px\]/);
  });
  it("header columns are wide enough for their text (measured in a browser), so no header runs into the next", () => {
    const widthOf = (label: string) => {
      const m = new RegExp(`<th[^>]*class="[^"]*\\bw-(\\d+)\\b[^"]*"[^>]*>${label}</th>`).exec(html);
      return m ? Number(m[1]) * 4 : null;
    };
    const MIN_PX = { "Started \\(UTC\\)": 112, Duration: 72, Spans: 72, Tokens: 72 };
    for (const [label, min] of Object.entries(MIN_PX)) expect(widthOf(label), label).toBeGreaterThanOrEqual(min);
  });
  it("no turns: only the notices, no table, no empty list", () => {
    const h = render(build([], { untracedEvents: 3 }));
    expect(h).toContain("No linkable traces");
    expect(h).not.toContain("<table");
    expect(h).not.toContain('aria-label="Turns"');
  });
  it("the summary strip fits narrow screens: two columns first, more only from sm up", () => {
    expect(html).toContain("grid-cols-2");
    expect(html).toMatch(/sm:grid-cols-3/);
  });
});

describe("hostile ids on the page", () => {
  const fx = threadDetailFixture("hostile");
  const html = render(buildThreadDetailView({ ...fx, tracesPath: TRACES }));
  it("no markup from an id or a name reaches the page unescaped", () => {
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });
  it("no reordering or invisible character reaches the text or the attributes", () => {
    expect(html).not.toMatch(/[‪-‮⁦-⁩​-‏﻿]/);
  });
  it("a 128-character thread id is shortened in the heading and whole below it and for screen readers", () => {
    expect(html).toContain("x".repeat(40) + "…");
    expect(html).toContain(`title="${"x".repeat(128)}"`);
    expect(html).toContain(`Full thread id: ${"x".repeat(128)}`);
    const heading = /<code[^>]*class="[^"]*truncate[^"]*"[^>]*>([^<]*)<\/code>/.exec(html)?.[1];
    expect(heading).toBe("x".repeat(40) + "…"); // the heading never shows more than 40 characters
    expect(html).toContain(`>${"x".repeat(128)}</p>`); // the whole id is printed once below it
  });
  it("every turn still has one table link and one card link with a single-segment encoded path", () => {
    const details = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!).filter((h) => h.startsWith(`${TRACES}/`));
    expect(details).toHaveLength(fx.turns.length * 2);
    for (const h of details) expect(h.slice(TRACES.length + 1), h).not.toMatch(/[/?#\\ <>"']/);
  });
});

describe("fixtures", () => {
  it("every named fixture builds and renders without throwing, with a valid id", () => {
    for (const name of THREAD_DETAIL_NAMES) {
      const fx = threadDetailFixture(name);
      expect(traceIdSchema.safeParse(fx.threadId).success, name).toBe(true);
      expect(() => render(buildThreadDetailView({ ...fx, tracesPath: TRACES })), name).not.toThrow();
    }
  });
  it("cover the states the page has: partial cost, truncated, untraced, no traces, 200 turns", () => {
    const by = (n: (typeof THREAD_DETAIL_NAMES)[number]) => buildThreadDetailView({ ...threadDetailFixture(n), tracesPath: TRACES });
    expect(by("partial-cost").turns.some((t) => t.cost.startsWith("≥"))).toBe(true);
    expect(by("partial-cost").turns.some((t) => t.cost === "—")).toBe(true);
    expect(by("truncated").notices.map((n) => n.id)).toContain("truncated");
    expect(by("untraced").notices.map((n) => n.id)).toContain("untraced");
    expect(by("no-traces").notices.map((n) => n.id)).toEqual(["no-traces"]);
    expect(by("many").turns).toHaveLength(200);
  });
  it("200 turns (the cap) render in bounded HTML: the page holds both layouts, so the raw size is about 1 MB but it compresses to a small response", () => {
    const h = render(buildThreadDetailView({ ...threadDetailFixture("many"), tracesPath: TRACES }));
    expect(count(h, "<tr")).toBe(201);
    expect(count(h, "<li")).toBe(200);
    expect(h.length).toBeLessThan(1_200_000);
    expect(gzipSync(h).length).toBeLessThan(80_000);
  });
});

describe("static checks", () => {
  const page = read("app/dashboard/projects/[id]/threads/[threadId]/page.tsx");
  const sources = [
    "app/dashboard/projects/[id]/threads/[threadId]/page.tsx",
    "components/dashboard/thread-detail-view.tsx",
    "lib/dashboard/thread-detail-view.ts",
    "lib/dashboard/thread-fixtures.ts",
  ];
  it("the page validates the thread id before the session, then reads through getThread and getProject only", () => {
    expect(page).toContain('import { getThread } from "@/lib/repo/thread-detail"');
    expect(page).toContain('import { getProject } from "@/lib/repo/projects"');
    expect(page).toContain("parseThreadIdParam(rawThreadId)");
    expect(page.indexOf("parseThreadIdParam(")).toBeLessThan(page.indexOf("ctxFromSession()"));
    expect(page).toContain("const ctx = await ctxFromSession()");
    expect(page).toContain('if (!ctx) redirect("/sign-in")');
    expect(page).toContain("getThread(ctx, id, threadId)");
    expect(page).toMatch(/if \(isNotFoundLike\(e\)\) notFound\(\);\s*throw e;/);
    expect(page).toMatch(/if \(threadId === null\) notFound\(\)/);
    expect(page).not.toMatch(/@\/lib\/db|neon|getSql|withTenant|@\/lib\/repo\/threads"/);
  });
  it("it is force-dynamic and noindex", () => {
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toMatch(/robots: \{ index: false/);
  });
  it("no client component, no locale formatting, no raw HTML in any of the new sources", () => {
    for (const f of sources) {
      const s = read(f);
      expect(s, f).not.toMatch(/["']use client["']/);
      expect(s, f).not.toMatch(/toLocale|Intl\.DateTimeFormat|dangerouslySetInnerHTML/);
    }
  });
  it("the view modules and the component never import lib/repo values or the database (types only for the repo)", () => {
    for (const f of ["lib/dashboard/thread-detail-view.ts", "components/dashboard/thread-detail-view.tsx"]) {
      expect(read(f), f).not.toMatch(/@\/lib\/repo|@\/lib\/db|@clerk/);
    }
    expect(read("lib/dashboard/thread-fixtures.ts")).not.toMatch(/@\/lib\/repo|@\/lib\/db|@clerk/);
  });
  it("the page lives under the Threads tab, so that tab stays active on it", () => {
    expect(read("components/dashboard/project-nav.tsx")).toContain("pathname.startsWith(`${href}/`)");
  });
});

// the turn type the view takes is the repo's turn type (a type-level check: this file does not compile otherwise)
const _typeCheck: TurnInput = turn();
void _typeCheck;
