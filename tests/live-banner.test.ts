import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveBannerView } from "@/components/dashboard/live-banner-view";
import {
  LIVE_BANNER_CARD_CLASS, LIVE_BANNER_CARD_MAX_REM, LIVE_BANNER_GAP_REM, LIVE_BANNER_INSET, LIVE_BANNER_OFFSET_CLASS, LIVE_BANNER_RESERVE_CLASS,
  bannerState, endedText, liveEnabledForPath, newEventsText, type BannerState,
} from "@/lib/dashboard/live-banner";
import { INITIAL_LIVE_SNAPSHOT } from "@/lib/dashboard/live-poller";

const read = (f: string) => readFileSync(f, "utf8");
/** Source without comments, so a comment may talk about what the code must not do. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const render = (state: BannerState) => renderToStaticMarkup(createElement(LiveBannerView, { state }));
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

describe("banner state and text (counts only)", () => {
  it("shows nothing until something is new", () => {
    expect(bannerState(INITIAL_LIVE_SNAPSHOT)).toEqual({ kind: "none" });
    expect(bannerState({ ...INITIAL_LIVE_SNAPSHOT, newErrors: 3 })).toEqual({ kind: "none" }); // errors alone never exist without events
  });
  it("new events, with errors and 'at least'", () => {
    expect(bannerState({ ...INITIAL_LIVE_SNAPSHOT, newEvents: 12, newErrors: 2 })).toEqual({ kind: "new", events: 12, errors: 2, atLeast: false });
    expect(newEventsText(12, 2, false)).toBe("12 new events (2 errors)");
    expect(newEventsText(1, 1, false)).toBe("1 new event (1 error)");
    expect(newEventsText(5, 0, false)).toBe("5 new events");
    expect(newEventsText(1000, 14, true)).toBe("At least 1,000 new events (at least 14 errors)");
    expect(newEventsText(987_654, 0, true)).toBe("At least 987,654 new events");
  });
  it("paused and ended; new events are still shown while paused (they were counted before)", () => {
    expect(bannerState({ ...INITIAL_LIVE_SNAPSHOT, status: "paused" })).toEqual({ kind: "paused" });
    expect(bannerState({ ...INITIAL_LIVE_SNAPSHOT, status: "paused", newEvents: 4 })).toMatchObject({ kind: "new", events: 4 });
    expect(bannerState({ ...INITIAL_LIVE_SNAPSHOT, status: "ended", endReason: "session_ended" })).toEqual({ kind: "ended", reason: "session_ended" });
    expect(endedText("session_ended")).toMatch(/session ended/);
    expect(endedText("not_found")).toMatch(/no longer available/);
  });
  it("runs on every project page except the API keys page, and never outside the dashboard", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    for (const p of [`/dashboard/projects/${id}`, `/dashboard/projects/${id}/traces`, `/dashboard/projects/${id}/traces/abc`, `/dashboard/projects/${id}/threads`, `/dashboard/projects/${id}/threads/t1`]) {
      expect(liveEnabledForPath(p), p).toBe(true);
    }
    for (const p of [`/dashboard/projects/${id}/keys`, "/dashboard", "/demo", "/demo/traces", "/design/pages", "/", "", null]) {
      expect(liveEnabledForPath(p), String(p)).toBe(false);
    }
  });
});

describe("LiveBannerView", () => {
  it("always renders one polite live region, empty when there is nothing to say, and fixed so it can never move the page", () => {
    const html = render({ kind: "none" });
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain("fixed");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<svg");
  });
  it("new events: icon, text, a Refresh button of at least 44 px (min-h-11)", () => {
    const html = render({ kind: "new", events: 12, errors: 2, atLeast: false });
    expect(html).toContain("12 new events (2 errors)");
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/<button[^>]*min-h-11[^>]*>Refresh<\/button>/);
  });
  it("paused: neutral text and a Resume button; ended: text, a sign-in link only when the session ended", () => {
    const p = render({ kind: "paused" });
    expect(p).toContain("Live updates paused");
    expect(p).toMatch(/<button[^>]*min-h-11[^>]*>Resume<\/button>/);
    const s = render({ kind: "ended", reason: "session_ended" });
    expect(s).toContain("your session ended");
    expect(s).toContain('href="/sign-in"');
    expect(s).not.toContain("<button");
    const g = render({ kind: "ended", reason: "not_found" });
    expect(g).toContain("no longer available");
    expect(g).not.toContain("/sign-in");
  });
  it("long numbers wrap instead of overflowing (min-w-0, break-words) and the card is capped in width", () => {
    const html = render({ kind: "new", events: 987_654, errors: 123_456, atLeast: true });
    expect(html).toContain("At least 987,654 new events (at least 123,456 errors)");
    expect(html).toContain("break-words");
    expect(html).toContain("min-w-0");
    expect(html).toContain("max-w-md");
  });
  it("hostile props cannot inject markup: only numbers and fixed words are rendered", () => {
    const html = render({ kind: "new", events: Number("<script>"), errors: 0, atLeast: false } as BannerState);
    expect(html).not.toContain("<script");
  });
});

describe("design fixtures", () => {
  const src = read("app/design/pages/page.tsx");
  for (const name of ["none", "new", "one", "errors", "truncated", "long", "paused", "ended-session", "ended-gone"]) {
    it(`has the view live-${name}`, () => {
      expect(src).toContain(`case "live-${name}"`);
    });
  }
  it("uses the real view, and the dev route stays dev-only", () => {
    expect(src).toContain("<LiveBannerView state={state} />");
    expect(src).toContain('process.env.NODE_ENV === "production"');
  });
});

describe("room reserved for the fixed banner", () => {
  const frame = read("components/dashboard/project-frame.tsx");
  const view = read("components/dashboard/live-banner-view.tsx");
  it("the offset, the card height and the reserve all come from the same numbers", () => {
    expect(LIVE_BANNER_OFFSET_CLASS).toBe(`pb-[${LIVE_BANNER_INSET}]`);
    expect(LIVE_BANNER_RESERVE_CLASS).toBe(`pb-[calc(${LIVE_BANNER_INSET}+${LIVE_BANNER_CARD_MAX_REM + LIVE_BANNER_GAP_REM}rem)]`);
    // max-h-24 is 6rem (Tailwind: 1 unit = 0.25rem)
    const m = /^max-h-(\d+) /.exec(LIVE_BANNER_CARD_CLASS);
    expect(Number(m?.[1]) * 0.25).toBe(LIVE_BANNER_CARD_MAX_REM);
    expect(LIVE_BANNER_INSET).toContain("env(safe-area-inset-bottom)");
  });
  it("the frame pads its content with the shared reserve, permanently (not conditional on the banner), and the view uses the shared offset and card classes", () => {
    expect(frame).toContain("LIVE_BANNER_RESERVE_CLASS");
    expect(frame).toMatch(/<div className=\{`mt-6 \$\{LIVE_BANNER_RESERVE_CLASS\}`\}>\{children\}<\/div>/);
    expect(view).toContain("${LIVE_BANNER_OFFSET_CLASS}");
    expect(view).toContain("${LIVE_BANNER_CARD_CLASS}");
    // no second, hand-written copy of the numbers in either file
    for (const src of [frame, view]) expect(src).not.toMatch(/safe-area-inset-bottom|pb-\[/);
  });
  it("the card text is clamped so the card cannot outgrow the reserve", () => {
    expect(view.match(/line-clamp-3/g)).toHaveLength(3);
    expect(render({ kind: "new", events: 1, errors: 0, atLeast: false })).toContain("max-h-24");
  });
  it("the banner stays a fixed overlay: its wrapper takes no room in the page", () => {
    expect(render({ kind: "none" })).toMatch(/class="[^"]*\bfixed\b[^"]*bottom-0/);
  });
});

describe("static shape of the live-updates files", () => {
  const FILES = ["components/dashboard/live-updates.tsx", "components/dashboard/live-banner-view.tsx", "lib/dashboard/live-banner.ts", "lib/dashboard/live-poller.ts"];
  const component = read("components/dashboard/live-updates.tsx");

  it("never reads or writes web storage or cookies, anywhere", () => {
    for (const f of FILES) {
      expect(code(f), f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|cookies\(|caches\.|window\.name|history\.(push|replace)State|BroadcastChannel/);
    }
  });
  it("refreshes through router.refresh, with a client directive, and mounts the poller only in an effect", () => {
    expect(component.startsWith('"use client"')).toBe(true);
    expect(component).toContain("router.refresh()");
    expect(component).toContain("useRouter");
    expect(component).toMatch(/useEffect\(\(\) => \{[\s\S]*createLivePoller\(/);
    expect(component).toContain("poller.stop()");
    expect(component).not.toMatch(/dangerouslySetInnerHTML|window\.location|location\.reload/);
  });
  it("the poller is framework-agnostic: no React, no browser globals, no direct network call", () => {
    expect(code("lib/dashboard/live-poller.ts")).not.toMatch(/from "react|from "next|\bwindow\b|\bdocument\b|\bnavigator\b|\bfetch\(|Math\.random|Date\.now/);
  });
  it("the view renders only what the state carries through the two text builders and fixed words", () => {
    const expressions = [...code("components/dashboard/live-banner-view.tsx").matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!.trim());
    const textual = expressions.filter((e) => /^(newEventsText|endedText)\(/.test(e));
    expect(textual).toEqual(["newEventsText(state.events, state.errors, state.atLeast)", "endedText(state.reason)"]);
    expect(code("components/dashboard/live-banner-view.tsx")).not.toMatch(/\.(message|stack|error|traceId|traces|rootName|cursor)\b/);
  });
  it("has no emoji", () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/\p{Extended_Pictographic}/u);
  });
  it("is mounted once, by ProjectFrame (every project page uses it; the [id] segment must have no layout), with the project's own id", () => {
    expect(read("components/dashboard/project-frame.tsx")).toContain("<LiveUpdates projectId={project.id} />");
    const importers = [...walk("app"), ...walk("components"), ...walk("lib")].filter((f) => /from "@\/components\/dashboard\/live-updates"/.test(read(f)));
    expect(importers).toEqual([join("components", "dashboard", "project-frame.tsx")]);
  });
  it("every signed-in project page goes through ProjectFrame", () => {
    for (const f of walk("app/dashboard/projects").filter((x) => x.endsWith("page.tsx"))) expect(read(f), f).toContain("<ProjectFrame");
  });
  it("the public demo and everything it shares never import any of it", () => {
    const names = /live-updates|live-poller|live-banner/;
    const demoFiles = [...walk("app/demo"), ...walk("lib/demo")];
    for (const f of demoFiles) expect(read(f), f).not.toMatch(names);
    for (const c of ["overview-view", "quota-meter", "demo-header", "demo-nav", "demo-shell", "traces-view", "trace-detail-page-view", "trace-explorer", "trace-waterfall", "copy-button", "empty-overview", "threads-view", "thread-detail-view"]) {
      expect(read(`components/dashboard/${c}.tsx`), c).not.toMatch(names);
    }
  });
});
