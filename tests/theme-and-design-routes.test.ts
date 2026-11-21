import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const layout = readFileSync("app/layout.tsx", "utf8");

describe("theme wiring (own provider, server-rendered script, strict CSP)", () => {
  it("the ROOT LAYOUT (a Server Component) renders the theme script in <head> with the per-request CSP nonce", () => {
    expect(layout).toContain('(await headers()).get("x-nonce")');
    expect(layout).toMatch(/<head>[\s\S]*<ThemeScript nonce=\{nonce\} \/>[\s\S]*<\/head>/);
    expect(layout).not.toMatch(/^["']use client["']/m); // the layout stays a Server Component
  });
  it("the script component is a Server Component and renders a plain <script>, never dangerouslySetInnerHTML", () => {
    const src = readFileSync("components/theme-script.tsx", "utf8");
    expect(src.trimStart().startsWith('"use client"')).toBe(false); // a directive is the first statement; comments may mention it
    expect(src).toContain("<script nonce={nonce}>{THEME_SCRIPT}</script>");
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
  it("tolerates the class and colour scheme the script sets on <html> before hydration", () => {
    expect(layout).toContain("suppressHydrationWarning");
  });
  it("the provider is a Client Component that renders no script and keeps the dark class after a dev Strict Mode remount", () => {
    const src = readFileSync("components/theme-provider.tsx", "utf8");
    expect(src.startsWith('"use client"')).toBe(true);
    expect(src).not.toMatch(/<script/i);
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*applyCurrent\(\)/); // re-applied before paint
    expect(src).toContain('addEventListener("change"'); // follows the OS while open
    expect(src).toContain('addEventListener("storage"'); // follows other tabs
    expect(src).toMatch(/\(\) => "system" as Theme/); // server snapshot = first client render: hydration-safe
    // every storage access sits inside a try with a catch (blocked storage must never throw into the app)
    const accesses = [...src.matchAll(/window\.localStorage\.\w+\(/g)];
    expect(accesses.length).toBeGreaterThanOrEqual(3);
    for (const call of accesses) {
      const around = src.slice(Math.max(0, call.index! - 120), call.index! + 260);
      expect(around, call[0]).toMatch(/try \{/);
      expect(around, call[0]).toMatch(/catch/);
    }
  });
  it("next-themes is gone: not a dependency, not imported, not in the lockfile", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["next-themes"]).toBeUndefined();
    expect(readFileSync("package-lock.json", "utf8")).not.toContain("node_modules/next-themes");
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) return f === "node_modules" || f === ".next" ? [] : walk(p);
        return /\.(ts|tsx|mjs)$/.test(p) ? [p] : [];
      });
    }
    const importers = [...walk("app"), ...walk("components"), ...walk("lib")].filter((f) => /from ["']next-themes["']/.test(readFileSync(f, "utf8")));
    expect(importers).toEqual([]);
  });
  it("pins recharts exactly (no range)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["recharts"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("proxy.ts publishes the nonce the layout reads", () => {
    expect(readFileSync("proxy.ts", "utf8")).toContain('requestHeaders.set("x-nonce", nonce)');
  });
  it("no Client Component renders a <script> element (React warns in development when it client-renders one)", () => {
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) return walk(p);
        return /\.tsx$/.test(p) ? [p] : [];
      });
    }
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const clientFiles = [...walk("app"), ...walk("components")].filter((f) => readFileSync(f, "utf8").trimStart().startsWith('"use client"'));
    expect(clientFiles.length).toBeGreaterThan(5);
    for (const f of clientFiles) expect(stripComments(readFileSync(f, "utf8")), f).not.toMatch(/<script[\s>]/i);
  });
});

describe("no locale-dependent date rendering in client or page code (hydration drift)", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(ts|tsx)$/.test(p) ? [p] : [];
    });
  }
  it("app/ and components/ never call toLocaleDateString/toLocaleTimeString (use lib/format instead)", () => {
    const offenders = [...walk("app"), ...walk("components")].filter((f) => /toLocale(Date|Time)String/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("development-only routes", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("/design answers 404 in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: Page } = await import("@/app/design/page");
    expect(() => Page()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });

  it("/design/pages answers 404 in production, whatever the view", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: Page } = await import("@/app/design/pages/page");
    await expect(Page({ searchParams: Promise.resolve({ view: "projects" }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });

  it("/design/pages rejects an unknown view outside production too", async () => {
    const { default: Page } = await import("@/app/design/pages/page");
    await expect(Page({ searchParams: Promise.resolve({ view: "../etc/passwd" }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });
});
