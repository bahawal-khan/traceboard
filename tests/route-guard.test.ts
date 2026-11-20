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
