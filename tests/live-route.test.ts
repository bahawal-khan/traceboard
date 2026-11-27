import { readFileSync } from "node:fs";
import { NeonDbError } from "@neondatabase/serverless";
import { ZodError } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidCursorError, NotFoundError } from "@/lib/repo/errors";

const m = vi.hoisted(() => ({ ctxFromSession: vi.fn(), getLiveSince: vi.fn() }));
vi.mock("@/lib/repo/ctx", () => ({ ctxFromSession: m.ctxFromSession }));
vi.mock("@/lib/repo/live", () => ({ getLiveSince: m.getLiveSince }));

import * as routeModule from "@/app/api/dashboard/projects/[id]/live/route";
import { GET } from "@/app/api/dashboard/projects/[id]/live/route";
import { sessionRoute } from "@/lib/http/api";
import {
  LIVE_CURSOR_MAX_CHARS, LIVE_POLL_MS, LIVE_RATE, createLiveHandler, liveLimiter, parseLiveQuery, serializeLive,
} from "@/lib/http/live-route";
import { TokenBucketLimiter } from "@/lib/ratelimit";
import { isApiKeyRoute } from "@/lib/security/api-key-routes";
import { isCronRoute } from "@/lib/security/cron-routes";

/**
 * GET /api/dashboard/projects/[id]/live against a mocked repo, in the style of tests/api-routes.test.ts. The real reader is
 * tests/live-repo.test.ts (statement) and tests/db/live.test.ts (database).
 */
const ORIGIN = "https://app.example.com";
const PID = "11111111-1111-4111-8111-111111111111";
// A real cursor, as lib/repo/live.ts encodes it.
const CURSOR = Buffer.from(JSON.stringify({ k: "lv", v: 1, s: "2026-11-26T11:59:00.123456Z", i: "ffffffff-ffff-ffff-ffff-ffffffffffff" })).toString("base64url");
const base = `/api/dashboard/projects/${PID}/live`;
const params = (id = PID) => ({ params: Promise.resolve({ id }) });
const req = (path = base, headers: Record<string, string> = {}, method = "GET") => new Request(`${ORIGIN}${path}`, { method, headers });

let n = 0;
let ctx: { kind: string; ownerId: string; projectIds: string[]; readOnly: boolean };
const trace = { traceId: "tr-1", startedAtMs: 1_000, durationMs: 50, spanCount: 3, errorCount: 1, totalTokens: 9, costMicro: null, costLowerBound: true, unpricedEvents: 2, rootName: "agent.run", hasRoot: true };
const result = (over: Record<string, unknown> = {}) => ({
  cursor: CURSOR, baseline: false, reset: false, truncated: false, newEvents: 3, newErrors: 1, newTraces: 1, traces: [trace], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // The route logger writes one JSON line per request to console.log; keep the test output quiet. The logging test below
  // replaces this with a collecting spy, so what is logged is still asserted. Restored by afterEach.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  n += 1;
  // A fresh owner per test: the module's limiter is per user, and it must not carry state from one test into the next.
  ctx = { kind: "session", ownerId: `user_${n}`, projectIds: [PID], readOnly: false };
  m.ctxFromSession.mockResolvedValue(ctx);
  m.getLiveSince.mockResolvedValue(result());
});
afterEach(() => vi.restoreAllMocks());

describe("auth", () => {
  it("401 without a session, the repo is never called, and the limiter is not spent", async () => {
    m.ctxFromSession.mockResolvedValue(null);
    const tracked = (liveLimiter as TokenBucketLimiter).size;
    const r = await GET(req(`${base}?cursor=${CURSOR}`), params());
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "unauthorized" });
    expect(m.getLiveSince).not.toHaveBeenCalled();
    // sessionRoute answers 401 before the handler runs, so nothing was checked or recorded for anybody
    expect((liveLimiter as TokenBucketLimiter).size).toBe(tracked);
  });

  it("the limiter's memory is bounded: more callers than maxKeys never grow it past maxKeys", () => {
    const lim = new TokenBucketLimiter({ ...LIVE_RATE, now: () => 0 });
    for (let i = 0; i < LIVE_RATE.maxKeys * 2; i++) lim.check(`user_${i}`);
    expect(lim.size).toBe(LIVE_RATE.maxKeys);
  });

  it("401 is the same JSON the other dashboard routes give, with the no-store headers and a request id", async () => {
    m.ctxFromSession.mockResolvedValue(null);
    const r = await GET(req(base, { "x-request-id": "req-12345678" }), params());
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-request-id")).toBe("req-12345678");
  });

  it("the route module exports GET and route config only: every other method is Next's own 405, never a handler", () => {
    const names = Object.keys(routeModule).sort();
    expect(names).toEqual(["GET", "dynamic", "runtime"]);
    expect(routeModule.runtime).toBe("nodejs");
    expect(routeModule.dynamic).toBe("force-dynamic");
  });

  it("an ingest API key is not a credential here: only the session context decides, the Authorization header is never read", async () => {
    m.ctxFromSession.mockResolvedValue(null);
    const r = await GET(req(base, { authorization: `Bearer lm_${"A".repeat(43)}` }), params());
    expect(r.status).toBe(401);
    expect(m.getLiveSince).not.toHaveBeenCalled();
    expect(readFileSync("lib/http/live-route.ts", "utf8")).not.toMatch(/authorization|authenticateApiKey|api-key/i);
  });
});

describe("input validation (before any database work)", () => {
  it("no cursor: the repo is called with exactly (ctx, project id, undefined) and nothing else", async () => {
    const r = await GET(req(), params());
    expect(r.status).toBe(200);
    expect(m.getLiveSince).toHaveBeenCalledTimes(1);
    expect(m.getLiveSince.mock.calls[0]).toEqual([ctx, PID, undefined]);
  });

  it("a valid cursor is passed through unchanged, as the third and last argument", async () => {
    await GET(req(`${base}?cursor=${CURSOR}`), params());
    expect(m.getLiveSince.mock.calls[0]).toEqual([ctx, PID, CURSOR]);
  });

  it("unknown parameters are IGNORED (like every other dashboard route), and cannot smuggle the repo's test hooks", async () => {
    const r = await GET(req(`${base}?nowMs=1&scanCap=1&settleMs=0&cursor=${CURSOR}&x=1&x=2`), params());
    expect(r.status).toBe(200);
    expect(m.getLiveSince.mock.calls[0]).toEqual([ctx, PID, CURSOR]);
    expect(m.getLiveSince.mock.calls[0]).toHaveLength(3);
  });

  const badCursors: Array<[string, string]> = [
    ["empty", "cursor="],
    ["empty after a valid one (duplicate)", `cursor=${CURSOR}&cursor=${CURSOR}`],
    ["duplicate with an empty one", `cursor=${CURSOR}&cursor=`],
    ["one over the cap", `cursor=${"A".repeat(LIVE_CURSOR_MAX_CHARS + 1)}`],
    ["a megabyte", `cursor=${"A".repeat(1_000_000)}`],
    ["a space", "cursor=abc%20def"],
    ["a plus and a slash (base64, not base64url)", "cursor=ab%2Bc%2Fd"],
    ["padding", `cursor=${CURSOR}%3D%3D`],
    ["sql", "cursor=%27%3B%20drop%20table%20events%3B--"],
    ["a NUL byte", "cursor=abc%00def"],
    ["a newline", "cursor=abc%0Adef"],
    ["a unicode string", "cursor=%E2%80%AEabc%F0%9F%92%A5"],
    ["a path traversal", "cursor=..%2F..%2Fetc%2Fpasswd"],
    ["an html tag", "cursor=%3Cscript%3Ealert(1)%3C%2Fscript%3E"],
    ["a lone surrogate (invalid utf-8)", "cursor=%ED%A0%80"],
  ];
  it.each(badCursors)("400 for a cursor that is %s, a generic body, and the repo is never called", async (name, qs) => {
    const r = await GET(req(`${base}?${qs}`), params());
    expect(r.status, name).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_request" });
    expect(m.getLiveSince).not.toHaveBeenCalled();
  });

  it("an array-style key (cursor[]) is a different parameter name: ignored, so no cursor", async () => {
    expect((await GET(req(`${base}?cursor[]=x`), params())).status).toBe(200);
    expect(m.getLiveSince.mock.calls[0]).toEqual([ctx, PID, undefined]);
  });

  it("the cap leaves real margin over a real cursor (the real length is about 130)", () => {
    expect(CURSOR.length).toBeGreaterThan(100);
    expect(LIVE_CURSOR_MAX_CHARS).toBeGreaterThanOrEqual(Math.ceil(CURSOR.length * 1.4));
    expect(LIVE_CURSOR_MAX_CHARS).toBeLessThanOrEqual(256); // the repo's own decode cap
    expect(parseLiveQuery(`${ORIGIN}${base}?cursor=${"A".repeat(LIVE_CURSOR_MAX_CHARS)}`)).toEqual({ ok: true, cursor: "A".repeat(LIVE_CURSOR_MAX_CHARS) });
  });

  const badProjects = ["not-a-uuid", "", "1", "11111111-1111-4111-8111-11111111111", `${PID}x`, "'; drop table projects;--", "../../x", "%00", "00000000-0000-0000-0000-00000000000g"];
  it.each(badProjects)("a malformed project id %j is the SAME 404 as a missing project, and the repo is never called", async (id) => {
    const r = await GET(req(`/api/dashboard/projects/${encodeURIComponent(id)}/live`), params(id));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
    expect(m.getLiveSince).not.toHaveBeenCalled();
  });

  it("parseLiveQuery: absent, one valid, and the failure shapes", () => {
    expect(parseLiveQuery(`${ORIGIN}${base}`)).toEqual({ ok: true, cursor: undefined });
    expect(parseLiveQuery(`${ORIGIN}${base}?cursor=${CURSOR}`)).toEqual({ ok: true, cursor: CURSOR });
    expect(parseLiveQuery(`${ORIGIN}${base}?cursor=`)).toEqual({ ok: false });
    expect(parseLiveQuery("not a url")).toEqual({ ok: false });
  });
});

describe("error mapping", () => {
  const text = async (r: Response) => r.text();

  it("NotFound (missing, deleted, other tenant: all the same repo error) and a malformed id give byte-identical 404 bodies", async () => {
    m.getLiveSince.mockRejectedValue(new NotFoundError());
    const fromRepo = await GET(req(), params());
    const malformed = await GET(req("/api/dashboard/projects/nope/live"), params("nope"));
    expect(fromRepo.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await text(fromRepo)).toBe(await text(malformed));
    m.getLiveSince.mockRejectedValue(new NotFoundError());
    expect(await text(await GET(req(), params()))).toBe('{"error":"not_found"}');
  });

  it("InvalidCursorError is 400 with a generic body that does not echo the cursor", async () => {
    m.getLiveSince.mockRejectedValue(new InvalidCursorError());
    const r = await GET(req(`${base}?cursor=${CURSOR}`), params());
    expect(r.status).toBe(400);
    const body = await text(r);
    expect(JSON.parse(body)).toEqual({ error: "invalid_request" });
    expect(body).not.toContain(CURSOR);
  });

  it("503 with the request id and no details when the database cannot be reached; a SQL error stays 500", async () => {
    const down = new NeonDbError("Error connecting to database: TypeError: fetch failed postgres://user:secretpw@host/db");
    down.sourceError = new TypeError("fetch failed");
    m.getLiveSince.mockRejectedValue(down);
    const r = await GET(req(base, { "x-request-id": "req-12345678" }), params());
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect(r.headers.get("x-request-id")).toBe("req-12345678");
    const body = await text(r);
    expect(JSON.parse(body)).toEqual({ error: "service_unavailable", requestId: "req-12345678" });
    expect(body).not.toMatch(/secretpw|postgres|fetch/);
    const sqlErr = new NeonDbError("permission denied");
    sqlErr.code = "42501";
    m.getLiveSince.mockRejectedValue(sqlErr);
    expect((await GET(req(), params())).status).toBe(500);
  });

  it("an unexpected error is a generic 500 that never echoes the cause", async () => {
    m.getLiveSince.mockRejectedValue(new Error("connect postgres://user:secretpw@host/db failed"));
    const r = await GET(req(), params());
    expect(r.status).toBe(500);
    const body = await text(r);
    expect(body).not.toMatch(/secretpw|postgres/);
    expect(JSON.parse(body).error).toBe("internal");
  });

  it("a ZodError from the repo's own result check is OUR bug: 500, not the 422 meant for bad client input", async () => {
    m.getLiveSince.mockRejectedValue(new ZodError([]));
    const r = await GET(req(), params());
    expect(r.status).toBe(500);
    expect(JSON.parse(await text(r)).error).toBe("internal");
  });
});

describe("the 200 answer", () => {
  it("has exactly the documented fields, in explicit form, plus the poll hint", async () => {
    const r = await GET(req(`${base}?cursor=${CURSOR}`, { "x-request-id": "req-12345678" }), params());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Object.keys(body).sort()).toEqual(["baseline", "cursor", "newErrors", "newEvents", "newTraces", "pollMs", "reset", "traces", "truncated"]);
    expect(body).toEqual({ ...result(), pollMs: LIVE_POLL_MS });
    expect(Object.keys(body.traces[0]).sort()).toEqual(Object.keys(trace).sort());
    expect(LIVE_POLL_MS).toBe(15_000);
  });

  it("nothing the repo returns beyond the documented fields can reach the client (no spreading)", async () => {
    m.getLiveSince.mockResolvedValue({ ...result(), internal: "SECRET", traces: [{ ...trace, errorText: "SECRET", inputText: "SECRET" }] });
    const text = await (await GET(req(), params())).text();
    expect(text).not.toContain("SECRET");
    expect(Object.keys(serializeLive(result() as never)).sort()).toEqual(["baseline", "cursor", "newErrors", "newEvents", "newTraces", "pollMs", "reset", "traces", "truncated"]);
  });

  it("a null cost stays null (never 0) and the lower bound flag is kept", async () => {
    const body = await (await GET(req(), params())).json();
    expect(body.traces[0].costMicro).toBeNull();
    expect(body.traces[0].costLowerBound).toBe(true);
  });

  it("headers: private no-store, nosniff, a JSON content type, the request id, and no CORS headers", async () => {
    const r = await GET(req(base, { "x-request-id": "req-12345678", origin: "https://evil.example.com" }), params());
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(r.headers.get("x-request-id")).toBe("req-12345678");
    for (const [k] of r.headers) expect(k).not.toMatch(/^access-control-/);
  });

  it("the error answers carry the same safe headers", async () => {
    for (const setup of [() => m.getLiveSince.mockRejectedValue(new NotFoundError()), () => m.getLiveSince.mockRejectedValue(new InvalidCursorError()), () => m.getLiveSince.mockRejectedValue(new Error("x"))]) {
      setup();
      const r = await GET(req(), params());
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("x-request-id")).toBeTruthy();
    }
  });
});

describe("rate limiting (per signed-in user, per instance)", () => {
  it("429 with Retry-After, the same JSON shape and safe headers, and the repo is not called", async () => {
    const limited = sessionRoute<{ id: string }>("live.test", createLiveHandler({ check: () => ({ ok: false, retryAfterMs: 2_300 }) }));
    const r = await limited(req(base, { "x-request-id": "req-12345678" }), params());
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("3");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-request-id")).toBe("req-12345678");
    expect(await r.json()).toEqual({ error: "rate_limited" });
    expect(m.getLiveSince).not.toHaveBeenCalled();
  });

  it("Retry-After is at least 1 second and a whole number", async () => {
    const limited = sessionRoute<{ id: string }>("live.test", createLiveHandler({ check: () => ({ ok: false, retryAfterMs: 1 }) }));
    expect((await limited(req(), params())).headers.get("retry-after")).toBe("1");
  });

  it("the limiter is keyed by the signed-in user id, not by anything the request controls", async () => {
    const keys: string[] = [];
    const spy = sessionRoute<{ id: string }>("live.test", createLiveHandler({ check: (k) => (keys.push(k), { ok: true }) }));
    await spy(req(base, { "x-forwarded-for": "203.0.113.9", "x-request-id": "req-12345678" }), params());
    expect(keys).toEqual([ctx.ownerId]);
  });

  it("the real limiter: a burst of 10 passes, the 11th is 429, another user is unaffected, and a few tabs polling every 15 s never hit it", async () => {
    const real = (clock: { t: number }) => new TokenBucketLimiter({ ...LIVE_RATE, now: () => clock.t });
    const clock = { t: 1_000_000 };
    const lim = real(clock);
    const route = sessionRoute<{ id: string }>("live.test", createLiveHandler(lim));
    for (let i = 0; i < LIVE_RATE.burst; i++) expect((await route(req(), params())).status, `request ${i + 1}`).toBe(200);
    const blocked = await route(req(), params());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    m.ctxFromSession.mockResolvedValue({ ...ctx, ownerId: "someone_else" });
    expect((await route(req(), params())).status).toBe(200);
    m.ctxFromSession.mockResolvedValue(ctx);
    clock.t += 1_000; // one token refills per second
    expect((await route(req(), params())).status).toBe(200);

    const q = { t: 0 };
    const tabsRoute = sessionRoute<{ id: string }>("live.test", createLiveHandler(real(q)));
    for (let poll = 0; poll < 40; poll++) {
      for (let tab = 0; tab < 5; tab++) expect((await tabsRoute(req(), params())).status).toBe(200);
      q.t += LIVE_POLL_MS;
    }
  });

  it("the shipped limiter is the shared token bucket, with bounded memory and no extra dependency", () => {
    expect(liveLimiter).toBeInstanceOf(TokenBucketLimiter);
    expect(LIVE_RATE.maxKeys).toBeLessThanOrEqual(10_000);
    expect(readFileSync("lib/http/live-route.ts", "utf8")).toMatch(/from "@\/lib\/ratelimit"/);
  });

  it("an invalid request still spends a token (a flood of bad requests is limited too), but a 401 does not reach the limiter", async () => {
    const calls: string[] = [];
    const route = sessionRoute<{ id: string }>("live.test", createLiveHandler({ check: (k) => (calls.push(k), { ok: true }) }));
    await route(req(`${base}?cursor=`), params());
    expect(calls).toHaveLength(1);
    m.ctxFromSession.mockResolvedValue(null);
    await route(req(), params());
    expect(calls).toHaveLength(1);
  });
});

describe("logging", () => {
  it("never logs the cursor, the project id, headers or any content: only the route, the request id and an outcome class", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    m.getLiveSince.mockResolvedValueOnce(result());
    await GET(req(`${base}?cursor=${CURSOR}`, { "x-request-id": "req-12345678", authorization: "Bearer secret-token-value", cookie: "sess=abc" }), params());
    m.getLiveSince.mockRejectedValueOnce(new InvalidCursorError());
    await GET(req(`${base}?cursor=${CURSOR}`, { "x-request-id": "req-12345678" }), params());
    m.getLiveSince.mockRejectedValueOnce(new Error("boom postgres://u:secretpw@h/d"));
    await GET(req(`${base}?cursor=${CURSOR}`, { "x-request-id": "req-12345678" }), params());
    const all = lines.join("\n");
    expect(all).not.toContain(CURSOR);
    expect(all).not.toMatch(/secretpw|secret-token-value|sess=abc|tr-1|agent\.run/);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const rec of parsed.filter((p) => p.route === "live.get" && p.outcome)) {
      expect(rec.requestId).toBe("req-12345678");
      expect(["ok", "not_found", "invalid", "rate_limited"]).toContain(rec.outcome);
    }
    expect(parsed.some((p) => p.outcome === "ok")).toBe(true);
    expect(parsed.some((p) => p.outcome === "invalid")).toBe(true);
  });
});

describe("static guards", () => {
  const files = ["app/api/dashboard/projects/[id]/live/route.ts", "lib/http/live-route.ts"];

  it("neither the route nor its handler can pass getLiveSince's test hooks (nowMs, scanCap, settleMs), and it is called with exactly three arguments", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""), f).not.toMatch(/nowMs|scanCap|settleMs/);
    }
    const handler = readFileSync("lib/http/live-route.ts", "utf8");
    expect(handler.match(/getLiveSince\(/g)).toHaveLength(1);
    expect(handler).toMatch(/getLiveSince\(ctx, pid\.data, query\.cursor\)/);
  });

  it("the route file is GET only, nodejs, force-dynamic, built by sessionRoute, with no db or auth access of its own", () => {
    const src = readFileSync(files[0]!, "utf8");
    expect(src).toMatch(/export const runtime = "nodejs"/);
    expect(src).toMatch(/export const dynamic = "force-dynamic"/);
    expect(src).toMatch(/export const GET = sessionRoute</);
    expect(src).not.toMatch(/export\s+(const|async function|function)\s+(POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/);
    expect(src).not.toMatch(/@neondatabase|lib\/db|getSql|auth\(\)|revalidate|fetchCache|unstable_cache|"use cache"/);
  });

  it("no log call in the handler mentions the cursor or the project id", () => {
    const src = readFileSync("lib/http/live-route.ts", "utf8");
    const lines = src.split("\n").filter((x) => /\blog\.(debug|info|warn|error)\(/.test(x));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    // Only the fields count; the message text may say "cursor".
    for (const l of lines) expect(l.replace(/"[^"]*"/g, '""')).not.toMatch(/cursor|params|pid|request\b|query/i);
  });

  it("the handler sets no CORS header and no cache header other than the shared no-store", () => {
    const src = readFileSync("lib/http/live-route.ts", "utf8");
    expect(src).not.toMatch(/access-control|Cache-Control|max-age|s-maxage|stale-while/i);
  });

  it("the proxy protects the whole /api/dashboard tree with a 401 JSON, and this path is in it and in no bypass list", () => {
    const proxy = readFileSync("proxy.ts", "utf8");
    expect(proxy).toMatch(/const isProtectedApi = createRouteMatcher\(\["\/api\/dashboard\(\.\*\)"\]\)/);
    expect(proxy).toMatch(/isProtectedApi\(request\)[\s\S]*?\{ error: "unauthorized" \},\s*\{ status: 401/);
    expect(base.startsWith("/api/dashboard")).toBe(true);
    expect(isApiKeyRoute(base)).toBe(false);
    expect(isCronRoute(base)).toBe(false);
    // the bypass is exactly these two, evaluated before Clerk
    expect(proxy).toMatch(/if \(isApiKeyRoute\(path\) \|\| isCronRoute\(path\)\) return withSecurity\(request\);/);
  });
});
