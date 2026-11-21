import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every dashboard API handler must go through sessionRoute (origin check, session context, generic errors). */
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : name === "route.ts" ? [p] : [];
  });
}

describe("dashboard API route guard", () => {
  const files = routeFiles("app/api/dashboard");

  it("finds the dashboard routes", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("exports only sessionRoute handlers: no bare function handlers, no direct db or driver access", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/);
      const handlers = [...src.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=\s*([A-Za-z]+)/g)];
      expect(handlers.length, `${f} exports no handler`).toBeGreaterThan(0);
      for (const h of handlers) expect(h[2], `${f} ${h[1]}`).toBe("sessionRoute");
      expect(src, f).not.toMatch(/@neondatabase|lib\/db|getSql|auth\(\)/);
    }
  });
});

/** The cron route authenticates with CRON_SECRET only: a thin export of the tested handler, no session, no tenant db access. */
describe("cron route guard (app/api/jobs)", () => {
  const files = routeFiles("app/api/jobs");

  it("finds the daily job route and nothing unexpected", () => {
    expect(files.map((f) => f.replaceAll("\\", "/"))).toEqual(["app/api/jobs/daily/route.ts"]);
  });

  it("exports only GET, built by createDailyJobHandler, with no Clerk, session, API key or direct db access", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const exported = [...src.matchAll(/export\s+(?:async\s+)?(?:const|function)\s+([A-Za-z]+)/g)].map((m) => m[1]!);
      expect(exported.filter((n) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(n)), f).toEqual(["GET"]);
      expect(src, f).toMatch(/export\s+const\s+GET\s*=\s*createDailyJobHandler\(/);
      expect(src, f).not.toMatch(/sessionRoute|@clerk|auth\(\)|@neondatabase|lib\/db|getSql|authenticateApiKey/);
      expect(src, f).toMatch(/export const runtime = "nodejs"/);
      expect(src, f).toMatch(/export const dynamic = "force-dynamic"/);
      expect(Number(/export const maxDuration = (\d+)/.exec(src)?.[1]), f).toBeLessThanOrEqual(300);
    }
  });

  it("the handler checks the secret before it touches the store, and never logs it", () => {
    const src = readFileSync("lib/jobs/handler.ts", "utf8");
    expect(src.indexOf("isCronAuthorized")).toBeGreaterThan(-1);
    expect(src.indexOf("isCronAuthorized(")).toBeLessThan(src.indexOf("deps.store()"));
    expect(src).not.toMatch(/log\.\w+\([^)]*secret/i);
  });

  it("vercel.json schedules the route once a day (Hobby allows one run per day)", () => {
    const cfg = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(cfg.crons).toHaveLength(1);
    expect(cfg.crons[0]!.path).toBe("/api/jobs/daily");
    expect(cfg.crons[0]!.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });
});
