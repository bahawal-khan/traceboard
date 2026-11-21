import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const layout = readFileSync("app/layout.tsx", "utf8");

describe("theme wiring (next-themes under the strict CSP)", () => {
  it("passes the per-request CSP nonce to the theme script", () => {
    expect(layout).toContain('(await headers()).get("x-nonce")');
    expect(layout).toMatch(/<ThemeProvider[^>]*nonce=\{nonce\}/);
  });
  it("uses the class strategy the Tailwind dark variant expects, defaulting to the OS setting", () => {
    expect(layout).toMatch(/attribute="class"/);
    expect(layout).toMatch(/defaultTheme="system"/);
    expect(layout).toMatch(/enableSystem/);
  });
  it("tolerates the class next-themes sets on <html> before hydration", () => {
    expect(layout).toContain("suppressHydrationWarning");
  });
  it("pins next-themes exactly (no range)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["next-themes"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["recharts"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("proxy.ts publishes the nonce the layout reads", () => {
    expect(readFileSync("proxy.ts", "utf8")).toContain('requestHeaders.set("x-nonce", nonce)');
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
