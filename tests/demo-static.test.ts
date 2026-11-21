import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
const FILES = [...walk("app/demo"), ...walk("lib/demo"), ...walk("lib/dashboard"), "components/dashboard/overview-view.tsx", "components/dashboard/quota-meter.tsx", "components/dashboard/demo-header.tsx"];
const FORBIDDEN = [/@\/lib\/repo/, /@\/lib\/db/, /@clerk\/nextjs\/server/, /ctxFromSession|ctxFromApiKey|ctxDemo|withTenant/, /process\.env\.(DATABASE|JOB_DATABASE|MIGRATION)/, /\bfetch\(/];

describe("the demo and the shared view-model code are static", () => {
  it("covers the files it should", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(8);
    expect(FILES).toContain("app/demo/page.tsx");
    expect(FILES).toContain("lib/demo/generate.ts");
  });
  for (const f of FILES) {
    it(`${f} has no database, tenant, session or network access`, () => {
      const src = readFileSync(f, "utf8");
      for (const re of FORBIDDEN) expect(src, `${f} matches ${re}`).not.toMatch(re);
    });
  }
  it("/demo is public: the proxy protects /dashboard pages only, and /demo is neither protected nor an API-key route", () => {
    const proxy = readFileSync("proxy.ts", "utf8");
    expect(proxy).toContain('createRouteMatcher(["/dashboard(.*)"])');
    expect(proxy).not.toContain("/demo");
  });
});
