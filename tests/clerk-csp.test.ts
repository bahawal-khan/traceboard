import { describe, expect, it } from "vitest";
import { clerkCspSources, clerkFrontendHost } from "@/lib/security/clerk";
import { buildCsp } from "@/lib/security/csp";

const pk = `pk_test_${btoa("example-app-12.clerk.accounts.dev$")}`;

describe("clerk csp", () => {
  it("derives the frontend host from the publishable key", () => {
    expect(clerkFrontendHost(pk)).toBe("example-app-12.clerk.accounts.dev");
    expect(clerkFrontendHost(undefined)).toBeUndefined();
    expect(clerkFrontendHost("pk_test_!!!")).toBeUndefined();
    expect(clerkFrontendHost(`pk_test_${btoa("evil.com;script-src *$")}`)).toBeUndefined();
  });

  it("adds the required sources without weakening scripts", () => {
    const csp = buildCsp({ nonce: "n", isDev: false, ...clerkCspSources(pk) });
    expect(csp).toContain("https://example-app-12.clerk.accounts.dev");
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("https://img.clerk.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp.split("; ").find((d) => d.startsWith("script-src "))).not.toContain("unsafe-inline");
  });
});
