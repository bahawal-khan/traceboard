import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectBanners } from "@/components/dashboard/project-banners";
import { conserveBanner, selectNotices } from "@/lib/dashboard/project-notices";
import { loadProjectNotices } from "@/lib/notices/load-notices";
import { createLogger } from "@/lib/logger";
import { FLUSH_HINT_MS, QUOTAS } from "@/lib/quotas";
import { NotFoundError } from "@/lib/repo/errors";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";

const LIMIT = QUOTAS.eventsPerDayPerProject;
const PID = "11111111-1111-4111-8111-111111111111";
const ctx = issueCtx<SessionCtx>({ kind: "session", ownerId: "user_a", projectIds: [PID], readOnly: false });
const n = (eventsToday: number, conserve = false) => ({ eventsToday, eventsLimit: LIMIT, conserve });
const read = (f: string) => readFileSync(f, "utf8");
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("selectNotices", () => {
  it("null (a failed or unreadable status) shows nothing at all", () => {
    expect(selectNotices(null)).toEqual({ quota: null, conserve: null });
    expect(selectNotices(undefined)).toEqual({ quota: null, conserve: null });
  });
  it("quota: nothing below 80%, near from 80%, reached from 100%", () => {
    expect(selectNotices(n(0)).quota).toBeNull();
    expect(selectNotices(n(Math.floor(LIMIT * 0.8) - 1)).quota).toBeNull();
    expect(selectNotices(n(Math.ceil(LIMIT * 0.8))).quota?.level).toBe("near");
    expect(selectNotices(n(LIMIT)).quota?.level).toBe("reached");
  });
  it("conserve is independent of the quota: either, both or neither, at most one of each", () => {
    expect(selectNotices(n(0, true))).toMatchObject({ quota: null, conserve: { title: expect.any(String) } });
    expect(selectNotices(n(LIMIT, false)).conserve).toBeNull();
    const both = selectNotices(n(LIMIT, true));
    expect(both.quota?.level).toBe("reached");
    expect(both.conserve).not.toBeNull();
  });
});

describe("conserve wording says what the guard does, no more and no less", () => {
  const b = conserveBanner();
  const text = `${b.title} ${b.body}`;
  it("states the real flush interval from the constant, and that events are still accepted and stored", () => {
    expect(FLUSH_HINT_MS.conserve).toBe(60_000);
    expect(text).toContain("about once every 60 seconds");
    expect(text).toContain("still accepted and stored");
  });
  it("does not claim anything is refused, dropped, paused, lost or limited, and names no internals", () => {
    expect(text).not.toMatch(/refus|drop|pause|lost|limit|stopp|block|quota|disabled/i);
    expect(text).not.toMatch(/storage|database|neon|vercel|postgres|compute|free tier|free plan|70|85|%|ratio|conserve/i);
  });
});

describe("ProjectBanners markup", () => {
  const html = (notices: Parameters<typeof ProjectBanners>[0]["notices"]) => renderToStaticMarkup(createElement(ProjectBanners, { notices }));
  it("renders nothing when there is nothing to say, or the status is unknown", () => {
    expect(html(n(1))).toBe("");
    expect(html(null)).toBe("");
    expect(html(undefined)).toBe("");
  });
  it("conserve: polite status, icon (aria-hidden) and words", () => {
    const m = html(n(1, true));
    expect(m).toContain('data-notice="conserve"');
    expect(m).toContain('role="status"');
    expect(m).not.toContain('role="alert"');
    expect(m).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(m).toContain("Data is arriving more slowly");
  });
  it("each kind at most once, even with both conditions", () => {
    const m = html(n(LIMIT, true));
    expect(count(m, 'data-quota-level="')).toBe(1);
    expect(count(m, 'data-notice="conserve"')).toBe(1);
  });
});

describe("loadProjectNotices never breaks the page", () => {
  const sink = () => {
    const lines: string[] = [];
    return { lines, log: createLogger({}, { sink: (l) => void lines.push(l) }) };
  };
  it("passes the status through", async () => {
    const read = vi.fn().mockResolvedValue({ eventsToday: 5, eventsLimit: LIMIT, conserve: true });
    expect(await loadProjectNotices(ctx, PID, { read })).toEqual({ eventsToday: 5, eventsLimit: LIMIT, conserve: true });
  });
  it("a failed read gives null (no banner) and logs ONE generic label: no message text, no ids, no connection string", async () => {
    const { lines, log } = sink();
    const read = vi.fn().mockRejectedValue(new Error(`boom postgres://u:secretpw@h/d project ${PID} user_a`));
    expect(await loadProjectNotices(ctx, PID, { read, log })).toBeNull();
    expect(lines).toHaveLength(1);
    const all = lines.join("\n");
    expect(all).not.toMatch(/boom|secretpw|postgres|user_a/);
    expect(all).not.toContain(PID);
    expect(JSON.parse(all)).toMatchObject({ msg: "project notices unavailable", route: "project.notices", outcome: "read_failed" });
  });
  it("not found gives null and logs nothing (the page's own lookup answers 404)", async () => {
    const { lines, log } = sink();
    expect(await loadProjectNotices(ctx, PID, { read: vi.fn().mockRejectedValue(new NotFoundError()), log })).toBeNull();
    expect(lines).toHaveLength(0);
  });
});

describe("ProjectFrame is the one place the banners are mounted", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((x) => (statSync(join(d, x)).isDirectory() ? walk(join(d, x)) : [join(d, x)]));
  const sources = [...walk("app"), ...walk("components"), ...walk("lib")].filter((f) => /\.tsx?$/.test(f));

  it("only project-frame mounts ProjectBanners, and only project-banners mounts QuotaBanner", () => {
    const users = (re: RegExp, skip: string[]) => sources.filter((f) => !skip.includes(f) && re.test(read(f)));
    expect(users(/<ProjectBanners\b/, ["components/dashboard/project-banners.tsx"])).toEqual(["components/dashboard/project-frame.tsx"]);
    expect(users(/<QuotaBanner\b/, ["components/dashboard/quota-banner.tsx"])).toEqual(["components/dashboard/project-banners.tsx"]);
  });
  it("the Overview view does not mount a quota banner of its own (it keeps the meter only)", () => {
    const src = read("components/dashboard/overview-view.tsx");
    expect(src).not.toContain("QuotaBanner");
    expect(src).toContain("<QuotaMeter");
  });
  it("every project page loads the notices and hands them to the frame, in parallel with its own data", () => {
    const pages = walk("app/dashboard/projects").filter((f) => f.endsWith("page.tsx"));
    expect(pages).toHaveLength(6);
    for (const f of pages) {
      const s = read(f);
      expect(s, f).toMatch(/loadProjectNotices\(ctx, id\)/);
      expect(s, f).toContain("notices={notices}");
      expect(s, f).toMatch(/Promise\.all\(\[[\s\S]*loadProjectNotices/);
    }
  });
  it("the layout stays absent from the [id] segment", () => {
    expect(readdirSync("app/dashboard/projects/[id]")).not.toContain("layout.tsx");
  });
  it("the banner area is part of the server render: no 'use client', no polling, no effect", () => {
    for (const f of ["components/dashboard/project-banners.tsx", "components/dashboard/quota-banner.tsx", "lib/dashboard/project-notices.ts", "lib/notices/load-notices.ts"]) {
      expect(read(f), f).not.toMatch(/["']use client["']|useEffect|setInterval|setTimeout|fetch\(/);
    }
  });
  it("the frame places them between the tabs and the content, and takes them as a prop (the header needs a theme provider, so this reads the source)", () => {
    const src = read("components/dashboard/project-frame.tsx");
    const nav = src.indexOf("<ProjectNav");
    const banners = src.indexOf("<ProjectBanners notices={notices} />");
    const content = src.indexOf("{children}");
    expect(nav).toBeGreaterThan(-1);
    expect(banners).toBeGreaterThan(nav);
    expect(content).toBeGreaterThan(banners);
    expect(count(src, "<ProjectBanners")).toBe(1);
    expect(src).toMatch(/notices\?: ProjectNotices \| null/);
  });
});
