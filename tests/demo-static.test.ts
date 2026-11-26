import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { isApiKeyRoute } from "@/lib/security/api-key-routes";
import { isCronRoute } from "@/lib/security/cron-routes";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

/**
 * The demo is static by decision (DEMO_SOURCE=db is deferred): it must not be able to reach a database or a tenant
 * context, so a visitor can never see another user's data through it. ESLint already bans the db client outside
 * lib/repo; this also bans lib/repo, the session and the Clerk server API for the demo and the view-model code it shares.
 */
// The views are shared with the signed-in pages, so every component the demo renders is listed here.
const DEMO_COMPONENTS = [
  "overview-view", "quota-meter", "demo-header", "demo-nav", "demo-shell", "traces-view", "trace-detail-page-view", "trace-explorer", "trace-waterfall",
  "copy-button", "empty-overview", "threads-view", "thread-detail-view",
].map((n) => `components/dashboard/${n}.tsx`);
const FILES = [...walk("app/demo"), ...walk("lib/demo"), ...walk("lib/dashboard"), ...DEMO_COMPONENTS];
const FORBIDDEN = [
  /@\/lib\/repo/, /@\/lib\/db/, /@clerk\/nextjs\/server/, /ctxFromSession|ctxFromApiKey|ctxDemo|withTenant/, /process\.env\.(DATABASE|JOB_DATABASE|MIGRATION)/, /\bfetch\(/,
  // no session or request state, no database driver, no other network API
  /next\/headers|\bcookies\(|\bheaders\(|\bauth\(|currentUser|@neondatabase|drizzle-orm|XMLHttpRequest|WebSocket|EventSource|sendBeacon/,
];

describe("the demo and the shared view-model code are static", () => {
  it("covers the files it should", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(8);
    expect(FILES).toContain("app/demo/page.tsx");
    expect(FILES).toContain("lib/demo/generate.ts");
    for (const f of ["app/demo/traces/page.tsx", "app/demo/traces/[traceId]/page.tsx", "app/demo/not-found.tsx", "lib/demo/traces.ts", "components/dashboard/traces-view.tsx",
      "app/demo/threads/page.tsx", "app/demo/threads/[threadId]/page.tsx", "lib/demo/threads.ts", "components/dashboard/threads-view.tsx", "components/dashboard/thread-detail-view.tsx"]) {
      expect(FILES, f).toContain(f);
    }
  });
  for (const f of FILES) {
    it(`${f} has no database, tenant, session or network access`, () => {
      const src = readFileSync(f, "utf8");
      for (const re of FORBIDDEN) expect(src, `${f} matches ${re}`).not.toMatch(re);
    });
  }
  it("the shared views do not even import a TYPE from lib/repo (the demo must not depend on it)", () => {
    for (const f of DEMO_COMPONENTS) expect(readFileSync(f, "utf8"), f).not.toMatch(/lib\/repo/);
  });
  it("the demo pages only read the committed snapshot through lib/demo", () => {
    for (const f of walk("app/demo").filter((x) => x.endsWith("page.tsx"))) {
      const src = readFileSync(f, "utf8");
      const imports = [...src.matchAll(/from "(@\/[^"]+)"/g)].map((m) => m[1]!);
      expect(imports.filter((i) => i.startsWith("@/lib/")).every((i) => i.startsWith("@/lib/demo") || i.startsWith("@/lib/dashboard")), f).toBe(true);
    }
  });
  it("/demo is public: the proxy protects /dashboard pages only, and /demo is neither protected nor an API-key route", () => {
    const proxy = readFileSync("proxy.ts", "utf8");
    expect(proxy).toContain('createRouteMatcher(["/dashboard(.*)"])');
    expect(proxy).not.toContain("/demo");
  });
  it("the demo routes are not protected by the proxy and are in neither bypass list", async () => {
    const { createRouteMatcher } = await vi.importActual<typeof import("@clerk/nextjs/server")>("@clerk/nextjs/server");
    const proxy = readFileSync("proxy.ts", "utf8");
    expect(proxy).toContain('createRouteMatcher(["/dashboard(.*)"])');
    const isProtected = createRouteMatcher(["/dashboard(.*)"]);
    for (const path of ["/demo", "/demo?range=7d", "/demo/traces", "/demo/traces/tr_00001", "/demo/traces/tr_loop1", "/demo/traces/a%2Fb", "/demo/nope", "/demo/threads", "/demo/threads/th_demo_01", "/demo/threads/a%2Fb"]) {
      expect(isProtected(new NextRequest(`http://localhost${path}`)), path).toBe(false);
      expect(isApiKeyRoute(path.split("?")[0]!), path).toBe(false);
      expect(isCronRoute(path.split("?")[0]!), path).toBe(false);
    }
    // ... while a dashboard page is protected (so the matcher above is the real one)
    expect(isProtected(new NextRequest("http://localhost/dashboard/projects/x/traces/y"))).toBe(true);
    expect(readFileSync("lib/security/api-key-routes.ts", "utf8")).not.toContain("demo");
    expect(readFileSync("lib/security/cron-routes.ts", "utf8")).not.toContain("demo");
  });
});
