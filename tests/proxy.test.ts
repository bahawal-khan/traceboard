import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({ handler: vi.fn(async () => new Response(null, { status: 200 })) }));
vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: () => clerk.handler,
  createRouteMatcher: () => () => false,
}));

import proxy from "@/proxy";
import { isApiKeyRoute } from "@/lib/security/api-key-routes";

const event = {} as Parameters<typeof proxy>[1];
const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, { method: "POST", headers });

describe("isApiKeyRoute", () => {
  it("matches the ingest and OTLP endpoints and their sub-paths only", () => {
    for (const p of ["/api/ingest", "/api/ingest/", "/api/otlp", "/api/otlp/v1/traces", "/api/ingest/anything"]) expect(isApiKeyRoute(p), p).toBe(true);
    for (const p of ["/api/ingestx", "/api/otlpx/v1", "/api/dashboard/projects", "/api/dashboard/ingest", "/dashboard", "/", "/api", "/api/ingest-old", "/API/ingest", "/x/api/ingest"]) {
      expect(isApiKeyRoute(p), p).toBe(false);
    }
  });
});

describe("proxy", () => {
  beforeEach(() => clerk.handler.mockClear());

  it("never hands /api/ingest or /api/otlp/* to Clerk, so Clerk never sees their Authorization header", async () => {
    for (const path of ["/api/ingest", "/api/otlp/v1/traces"]) {
      const res = await proxy(req(path, { authorization: `Bearer lm_${"A".repeat(43)}` }), event);
      expect(res, path).toBeDefined();
    }
    expect(clerk.handler).not.toHaveBeenCalled();
  });

  it("still applies the CSP and security headers and a request id to those routes", async () => {
    const res = (await proxy(req("/api/ingest"), event)) as Response;
    expect(res.headers.get("content-security-policy")).toMatch(/default-src/);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a caller-supplied request id when it is safe, and replaces an unsafe one", async () => {
    const ok = (await proxy(req("/api/ingest", { "x-request-id": "client-req-12345" }), event)) as Response;
    expect(ok.headers.get("x-request-id")).toBe("client-req-12345");
    const bad = (await proxy(req("/api/ingest", { "x-request-id": "bad id!\n" }), event)) as Response;
    expect(bad.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not forward the Authorization header to Clerk or modify it for the route", async () => {
    const res = (await proxy(req("/api/ingest", { authorization: "Bearer lm_secret" }), event)) as Response;
    // NextResponse.next({ request: { headers } }) forwards request headers via x-middleware-request-*; the
    // bearer token must pass through untouched so the route can authenticate it itself.
    expect(res.headers.get("x-middleware-request-authorization")).toBe("Bearer lm_secret");
    expect(clerk.handler).not.toHaveBeenCalled();
  });

  it("sends every other path through Clerk exactly as before", async () => {
    for (const path of ["/dashboard", "/api/dashboard/projects", "/api/ingestx", "/", "/sign-in"]) {
      clerk.handler.mockClear();
      await proxy(req(path), event);
      expect(clerk.handler, path).toHaveBeenCalledTimes(1);
    }
  });
});
