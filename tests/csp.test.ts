import { describe, expect, it } from "vitest";
import { API_CACHE_HEADER, STATIC_SECURITY_HEADERS, buildCsp } from "@/lib/security/csp";
import nextConfig from "@/next.config";

describe("buildCsp", () => {
  const prod = buildCsp({ nonce: "abc123", isDev: false });
  const dev = buildCsp({ nonce: "abc123", isDev: true });

  it("blocks framing, plugins and foreign base/form targets", () => {
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("object-src 'none'");
    expect(prod).toContain("base-uri 'self'");
    expect(prod).toContain("form-action 'self'");
    expect(prod).toContain("frame-src 'none'");
  });

  it("uses the nonce with strict-dynamic and no unsafe-inline for scripts", () => {
    const script = prod.split("; ").find((d) => d.startsWith("script-src "))!;
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toContain("unsafe-eval");
  });

  it("allows unsafe-eval and skips upgrade-insecure-requests only in dev", () => {
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).not.toContain("upgrade-insecure-requests");
    expect(prod).toContain("upgrade-insecure-requests");
  });

  it("allows inline styles (Clerk CSS-in-JS) but never inline scripts", () => {
    const style = prod.split("; ").find((d) => d.startsWith("style-src "))!;
    expect(style).toContain("'unsafe-inline'");
    expect(style).not.toContain("nonce-"); // a nonce would silently disable unsafe-inline
    const script = prod.split("; ").find((d) => d.startsWith("script-src "))!;
    expect(script).not.toContain("unsafe-inline");
  });
});

describe("static headers", () => {
  const names = STATIC_SECURITY_HEADERS.map((h) => h.key);
  it("includes the required set", () => {
    for (const n of ["Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options"]) {
      expect(names).toContain(n);
    }
  });
  it("marks API responses private, no-store", () => {
    expect(API_CACHE_HEADER.value).toBe("private, no-store");
  });
  it("next.config applies them to all routes and the cache header to /api", async () => {
    const cfg = nextConfig("phase-development-server");
    const rules = await cfg.headers!();
    expect(rules.find((r) => r.source === "/:path*")!.headers.map((h) => h.key)).toContain("Strict-Transport-Security");
    expect(rules.find((r) => r.source === "/api/:path*")!.headers[0]).toEqual(API_CACHE_HEADER);
    expect(cfg.poweredByHeader).toBe(false);
  });
});
