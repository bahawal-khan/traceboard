import { NeonDbError } from "@neondatabase/serverless";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlTag: vi.fn(), transaction: vi.fn(), auth: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db/client", () => ({ getSql: () => Object.assign(mocks.sqlTag, { transaction: mocks.transaction }) }));

import { generateApiKey } from "@/lib/api-key";
import { ApiKeyAuthenticator } from "@/lib/api-key-auth";
import { authenticateApiKeyRequest, bearerToken, type ApiKeyAuthDeps } from "@/lib/http/api-key-request";
import { clientIp } from "@/lib/http/ip";
import { RATE_LIMITS } from "@/lib/quotas";
import { TokenBucketLimiter } from "@/lib/ratelimit";
import { resetTouchThrottleForTests, touchApiKey } from "@/lib/repo/api-keys";
import { ctxFromApiKey } from "@/lib/repo/ctx";
import { issueCtx, type ApiKeyCtx } from "@/lib/repo/tenant";
import { TtlCache } from "@/lib/ttl-cache";

const PID = "11111111-1111-4111-8111-111111111111";
const KID = "22222222-2222-4222-8222-222222222222";
const mkCtx = (scopes: string[] = ["ingest"], keyId = KID) =>
  issueCtx<ApiKeyCtx>({ kind: "apiKey", ownerId: null, projectIds: [PID], keyId, scopes, readOnly: false });

describe("TtlCache", () => {
  it("expires entries and evicts the least recently used", () => {
    let t = 0;
    const c = new TtlCache<number>(2, 100, () => t);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1); // a is now the most recent
    c.set("c", 3); // evicts b
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
    t = 100;
    expect(c.get("a")).toBeUndefined();
    expect(c.size).toBe(1); // only c left unread; a was dropped on read
  });

  it("is bounded", () => {
    const c = new TtlCache<number>(3, 1000);
    for (let i = 0; i < 50; i++) c.set(`k${i}`, i);
    expect(c.size).toBe(3);
    expect(() => new TtlCache(0, 1)).toThrow();
  });
});

describe("TokenBucketLimiter", () => {
  it("allows the burst, then refuses with a retry-after, then refills", () => {
    let t = 0;
    const l = new TokenBucketLimiter({ burst: 3, refillPerSec: 1, now: () => t });
    expect([l.check("a"), l.check("a"), l.check("a")].every((r) => r.ok)).toBe(true);
    const denied = l.check("a");
    expect(denied).toEqual({ ok: false, retryAfterMs: 1000 });
    t = 500;
    expect(l.check("a")).toEqual({ ok: false, retryAfterMs: 500 });
    t = 1000;
    expect(l.check("a")).toEqual({ ok: true });
    expect(l.check("a").ok).toBe(false);
  });

  it("never exceeds the burst after a long idle period, and keys are independent", () => {
    let t = 0;
    const l = new TokenBucketLimiter({ burst: 2, refillPerSec: 10, now: () => t });
    l.check("a");
    l.check("a");
    expect(l.check("a").ok).toBe(false);
    expect(l.check("b").ok).toBe(true);
    t = 3_600_000;
    expect([l.check("a").ok, l.check("a").ok, l.check("a").ok]).toEqual([true, true, false]);
  });

  it("bounds the number of tracked callers", () => {
    const l = new TokenBucketLimiter({ burst: 1, refillPerSec: 1, maxKeys: 5 });
    for (let i = 0; i < 100; i++) l.check(`ip${i}`);
    expect(l.size).toBe(5);
  });

  it("rejects nonsense settings", () => {
    expect(() => new TokenBucketLimiter({ burst: 0, refillPerSec: 1 })).toThrow();
    expect(() => new TokenBucketLimiter({ burst: 1, refillPerSec: 0 })).toThrow();
  });
});

describe("ApiKeyAuthenticator", () => {
  const key = generateApiKey().secret;
  let t: number;
  beforeEach(() => {
    t = 0;
  });
  const make = (resolve: (k: string) => Promise<ApiKeyCtx | null>) => new ApiKeyAuthenticator(resolve, { now: () => t });

  it("caches a valid key for 60 s, then looks it up again (revocation takes effect within the TTL)", async () => {
    const ctx = mkCtx();
    const resolve = vi.fn().mockResolvedValueOnce(ctx).mockResolvedValueOnce(null); // revoked in between
    const a = make(resolve);
    expect(await a.authenticate(key)).toBe(ctx);
    t = RATE_LIMITS.authCacheTtlMs - 1;
    expect(await a.authenticate(key)).toBe(ctx); // still served from cache
    expect(resolve).toHaveBeenCalledTimes(1);
    t = RATE_LIMITS.authCacheTtlMs;
    expect(await a.authenticate(key)).toBeNull(); // cache expired: revoked key now refused
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("cached() reports only positive hits, never queries, and never fills the cache", async () => {
    const ctx = mkCtx();
    const resolve = vi.fn().mockResolvedValue(ctx);
    const a = make(resolve);
    expect(a.cached(key)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    await a.authenticate(key);
    expect(a.cached(key)).toBe(ctx);
    expect(a.cached(null)).toBeUndefined();
    expect(a.cached("lm_short")).toBeUndefined();
    t = RATE_LIMITS.authCacheTtlMs;
    expect(a.cached(key)).toBeUndefined(); // expired
    const neg = make(vi.fn().mockResolvedValue(null));
    await neg.authenticate(key);
    expect(neg.cached(key)).toBeUndefined(); // a negative entry is not a positive hit
  });

  it("caches unknown keys negatively for a short time", async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    const a = make(resolve);
    for (let i = 0; i < 20; i++) expect(await a.authenticate(key)).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    t = RATE_LIMITS.authNegativeTtlMs;
    await a.authenticate(key);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(RATE_LIMITS.authNegativeTtlMs).toBeGreaterThanOrEqual(30_000);
    expect(RATE_LIMITS.authNegativeTtlMs).toBeLessThanOrEqual(60_000);
  });

  it("a key created after a negative lookup works once the negative entry expires", async () => {
    const ctx = mkCtx();
    const resolve = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(ctx);
    const a = make(resolve);
    expect(await a.authenticate(key)).toBeNull();
    t = RATE_LIMITS.authNegativeTtlMs;
    expect(await a.authenticate(key)).toBe(ctx);
  });

  it("shares one lookup between concurrent requests for the same key", async () => {
    const resolve = vi.fn(async () => mkCtx());
    const a = make(resolve);
    await Promise.all(Array.from({ length: 10 }, () => a.authenticate(key)));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("never touches the database or the cache for malformed or missing keys", async () => {
    const resolve = vi.fn();
    const a = make(resolve);
    for (const bad of [null, undefined, "", "lm_short", `xx_${"A".repeat(43)}`, `lm_${"A".repeat(43)}'`, "Bearer x"]) expect(await a.authenticate(bad)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not cache lookup errors, so the next request retries", async () => {
    const resolve = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(mkCtx());
    const a = make(resolve);
    await expect(a.authenticate(key)).rejects.toThrow("db down");
    expect(await a.authenticate(key)).not.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("caches per key: two keys never share an entry", async () => {
    const other = generateApiKey().secret;
    const ctxA = mkCtx(["ingest"], KID);
    const ctxB = mkCtx(["ingest"], "33333333-3333-4333-8333-333333333333");
    const a = make(async (k) => (k === key ? ctxA : ctxB));
    expect(await a.authenticate(key)).toBe(ctxA);
    expect(await a.authenticate(other)).toBe(ctxB);
    expect(await a.authenticate(key)).toBe(ctxA);
  });
});

describe("authenticateApiKeyRequest", () => {
  const key = generateApiKey().secret;
  const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api/ingest", { method: "POST", headers });
  const deps = (over: Partial<ApiKeyAuthDeps> = {}): ApiKeyAuthDeps => ({
    ipLimiter: { check: () => ({ ok: true }) },
    keyLimiter: { check: () => ({ ok: true }) },
    failureBudget: { peek: () => ({ ok: true }), consume: () => {} },
    authenticator: { authenticate: vi.fn(async () => mkCtx()), cached: () => undefined },
    ...over,
  });

  it("accepts a valid Bearer key with the right scope", async () => {
    const d = deps();
    const r = await authenticateApiKeyRequest(req({ authorization: `Bearer ${key}`, "x-forwarded-for": "203.0.113.5" }), "ingest", d);
    expect(r.ok).toBe(true);
    expect(d.authenticator.authenticate).toHaveBeenCalledWith(key);
  });

  it("limits by IP BEFORE any authentication lookup", async () => {
    const authenticate = vi.fn();
    const ipLimiter = new TokenBucketLimiter({ burst: 2, refillPerSec: 0.001 });
    const d = deps({ ipLimiter, authenticator: { authenticate, cached: () => undefined } });
    const call = () => authenticateApiKeyRequest(req({ authorization: `Bearer ${key}`, "x-forwarded-for": "203.0.113.9" }), "ingest", d);
    await call();
    await call();
    const third = await call();
    expect(third).toMatchObject({ ok: false, status: 429, error: "rate_limited" });
    expect((third as { retryAfterSec: number }).retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(authenticate).toHaveBeenCalledTimes(2); // the third request never reached the authenticator
  });

  it("peek does not spend a token and does not create an entry", () => {
    const l = new TokenBucketLimiter({ burst: 1, refillPerSec: 1, now: () => 0 });
    for (let i = 0; i < 5; i++) expect(l.peek("a")).toEqual({ ok: true });
    expect(l.size).toBe(0);
    l.consume("a");
    expect(l.peek("a")).toEqual({ ok: false, retryAfterMs: 1000 });
  });

  it("buckets IPs separately, and requests with no valid IP share one 'unknown' bucket", async () => {
    const seen: string[] = [];
    const d = deps({ ipLimiter: { check: (k) => (seen.push(k), { ok: true }) } });
    await authenticateApiKeyRequest(req({ "x-forwarded-for": "203.0.113.1, 10.0.0.1" }), "ingest", d);
    await authenticateApiKeyRequest(req({ "x-forwarded-for": "not-an-ip" }), "ingest", d);
    await authenticateApiKeyRequest(req(), "ingest", d);
    expect(seen).toEqual(["203.0.113.1", "unknown", "unknown"]);
  });

  it("answers 401 for a missing, non-Bearer or unknown key, with a generic body", async () => {
    const d = deps({ authenticator: { authenticate: vi.fn(async () => null), cached: () => undefined } });
    for (const headers of [{} as Record<string, string>, { authorization: "Basic abc" }, { authorization: `Bearer ${key}` }, { authorization: "Bearer" }]) {
      expect(await authenticateApiKeyRequest(req(headers), "ingest", d)).toEqual({ ok: false, status: 401, error: "unauthorized" });
    }
  });

  it("answers 403 when the key lacks the scope", async () => {
    const d = deps({ authenticator: { authenticate: vi.fn(async () => mkCtx(["eval"])), cached: () => undefined } });
    expect(await authenticateApiKeyRequest(req({ authorization: `Bearer ${key}` }), "ingest", d)).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("rate limits per key after authentication", async () => {
    const d = deps({ keyLimiter: new TokenBucketLimiter({ burst: 1, refillPerSec: 0.001 }) });
    const call = () => authenticateApiKeyRequest(req({ authorization: `Bearer ${key}` }), "ingest", d);
    expect((await call()).ok).toBe(true);
    expect(await call()).toMatchObject({ ok: false, status: 429, error: "rate_limited" });
  });

  describe("failed-authentication budget", () => {
    const burst = RATE_LIMITS.ipFailureBurst;
    const ipReq = (k: string, ip = "203.0.113.50") => req({ authorization: `Bearer ${k}`, "x-forwarded-for": ip });
    const fresh = () => generateApiKey().secret;
    /** A real authenticator over a fake resolver that knows one valid key; counts every lookup. */
    const setup = () => {
      const valid = generateApiKey().secret;
      const resolve = vi.fn(async (k: string) => (k === valid ? mkCtx() : null));
      const d: ApiKeyAuthDeps = {
        ipLimiter: new TokenBucketLimiter({ burst: 1000, refillPerSec: 1000 }),
        keyLimiter: new TokenBucketLimiter({ burst: 1000, refillPerSec: 1000 }),
        failureBudget: new TokenBucketLimiter({ burst, refillPerSec: RATE_LIMITS.ipFailureRefillPerSec }),
        authenticator: new ApiKeyAuthenticator(resolve),
      };
      return { valid, resolve, d };
    };

    it("is stricter than the normal per-IP limit and lives in RATE_LIMITS", () => {
      expect(burst).toBe(10);
      expect(RATE_LIMITS.ipFailureRefillPerSec).toBe(1);
      expect(RATE_LIMITS.ipFailureBurst).toBeLessThan(RATE_LIMITS.ipBurst);
    });

    it("11 fresh random well-formed keys from one IP: the later ones are 429 with no lookup", async () => {
      const { resolve, d } = setup();
      const results = [];
      for (let i = 0; i < burst + 1; i++) results.push(await authenticateApiKeyRequest(ipReq(fresh()), "ingest", d));
      expect(results.slice(0, burst).every((r) => !r.ok && r.status === 401)).toBe(true);
      expect(results[burst]).toMatchObject({ ok: false, status: 429, error: "rate_limited" });
      expect(resolve).toHaveBeenCalledTimes(burst); // the 11th never reached the database
      for (let i = 0; i < 20; i++) expect(await authenticateApiKeyRequest(ipReq(fresh()), "ingest", d)).toMatchObject({ status: 429 });
      expect(resolve).toHaveBeenCalledTimes(burst);
    });

    it("tells the client when to retry, and recovers at 1 token per second", async () => {
      let t = 0;
      const { resolve, d } = setup();
      d.failureBudget = new TokenBucketLimiter({ burst, refillPerSec: RATE_LIMITS.ipFailureRefillPerSec, now: () => t });
      for (let i = 0; i < burst; i++) await authenticateApiKeyRequest(ipReq(fresh()), "ingest", d);
      const blocked = await authenticateApiKeyRequest(ipReq(fresh()), "ingest", d);
      expect(blocked).toMatchObject({ status: 429, retryAfterSec: 1 });
      t = 1000;
      expect(await authenticateApiKeyRequest(ipReq(fresh()), "ingest", d)).toMatchObject({ status: 401 }); // looked up again
      expect(resolve).toHaveBeenCalledTimes(burst + 1);
    });

    it("successful authentication never spends it, however many valid requests are made", async () => {
      const { valid, d } = setup();
      for (let i = 0; i < 200; i++) expect((await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).ok).toBe(true);
      // the full failure budget is still there
      for (let i = 0; i < burst; i++) expect(await authenticateApiKeyRequest(ipReq(fresh()), "ingest", d)).toMatchObject({ status: 401 });
    });

    it("valid keys from the same IP are unaffected while it is under the failure budget", async () => {
      const { valid, d } = setup();
      for (let i = 0; i < burst - 1; i++) await authenticateApiKeyRequest(ipReq(fresh()), "ingest", d);
      expect((await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).ok).toBe(true);
      expect((await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).ok).toBe(true);
    });

    it("a different IP has its own budget", async () => {
      const { valid, resolve, d } = setup();
      for (let i = 0; i < burst + 1; i++) await authenticateApiKeyRequest(ipReq(fresh(), "203.0.113.1"), "ingest", d);
      expect(await authenticateApiKeyRequest(ipReq(fresh(), "203.0.113.1"), "ingest", d)).toMatchObject({ status: 429 });
      const before = resolve.mock.calls.length;
      expect((await authenticateApiKeyRequest(ipReq(valid, "203.0.113.2"), "ingest", d)).ok).toBe(true);
      expect(await authenticateApiKeyRequest(ipReq(fresh(), "203.0.113.2"), "ingest", d)).toMatchObject({ status: 401 });
      expect(resolve.mock.calls.length).toBe(before + 2);
    });

    it("a wrong-scope key spends it only when it needed a lookup; missing and malformed keys never do", async () => {
      const resolve = vi.fn(async () => mkCtx(["eval"]));
      const { d } = setup();
      d.authenticator = new ApiKeyAuthenticator(resolve);
      // Distinct wrong-scope keys each need a lookup: they exhaust the budget.
      for (let i = 0; i < burst; i++) expect(await authenticateApiKeyRequest(ipReq(fresh()), "ingest", d)).toMatchObject({ status: 403 });
      expect(await authenticateApiKeyRequest(ipReq(fresh()), "ingest", d)).toMatchObject({ status: 429 });
      // The same wrong-scope key, once cached, causes no lookup: it answers 403 and spends nothing.
      const s1 = setup();
      s1.d.authenticator = new ApiKeyAuthenticator(resolve);
      const scoped = fresh();
      for (let i = 0; i < 50; i++) expect(await authenticateApiKeyRequest(ipReq(scoped), "ingest", s1.d)).toMatchObject({ status: 403 });
      expect(resolve.mock.calls.filter((c) => (c as unknown[])[0] === scoped)).toHaveLength(1);
      expect(s1.d.failureBudget.peek("203.0.113.50").ok).toBe(true);

      const s2 = setup();
      for (let i = 0; i < 50; i++) {
        await authenticateApiKeyRequest(req({ "x-forwarded-for": "203.0.113.77" }), "ingest", s2.d); // no key
        await authenticateApiKeyRequest(ipReq("lm_short", "203.0.113.77"), "ingest", s2.d); // malformed
      }
      expect(s2.resolve).not.toHaveBeenCalled();
      expect(await authenticateApiKeyRequest(ipReq(s2.valid, "203.0.113.77"), "ingest", s2.d)).toMatchObject({ ok: true });
    });

    describe("a cached valid key skips the failure budget (it causes no database access)", () => {
      /** Own clock so the positive cache can expire. */
      const withClock = () => {
        let t = 0;
        const valid = generateApiKey().secret;
        const resolve = vi.fn(async (k: string) => (k === valid ? mkCtx() : null));
        const d: ApiKeyAuthDeps = {
          ipLimiter: new TokenBucketLimiter({ burst: 1000, refillPerSec: 1000 }),
          keyLimiter: new TokenBucketLimiter({ burst: 1000, refillPerSec: 1000 }),
          failureBudget: new TokenBucketLimiter({ burst, refillPerSec: RATE_LIMITS.ipFailureRefillPerSec, now: () => t }),
          authenticator: new ApiKeyAuthenticator(resolve, { now: () => t }),
        };
        return { valid, resolve, d, advance: (ms: number) => (t += ms) };
      };
      const exhaust = async (d: ApiKeyAuthDeps) => {
        for (let i = 0; i < burst; i++) await authenticateApiKeyRequest(ipReq(fresh()), "ingest", d);
      };

      it("an IP with an exhausted failure budget still gets through with a valid cached key, but 429 for an uncached key", async () => {
        const { valid, resolve, d } = withClock();
        expect((await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).ok).toBe(true); // fills the positive cache
        await exhaust(d);
        expect(d.failureBudget.peek("203.0.113.50").ok).toBe(false);
        const calls = resolve.mock.calls.length;

        expect((await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).ok).toBe(true);
        expect(await authenticateApiKeyRequest(ipReq(fresh()), "ingest", d)).toMatchObject({ ok: false, status: 429 });
        expect(resolve.mock.calls.length).toBe(calls); // neither request touched the resolver
      });

      it("a valid key that is NOT cached yet is gated like any lookup", async () => {
        const { valid, resolve, d } = withClock();
        await exhaust(d);
        const calls = resolve.mock.calls.length;
        expect(await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).toMatchObject({ ok: false, status: 429 });
        expect(resolve.mock.calls.length).toBe(calls);
      });

      it("negative-cache hits are gated too", async () => {
        const { resolve, d } = withClock();
        const bad = fresh();
        await authenticateApiKeyRequest(ipReq(bad), "ingest", d); // negative entry, one failure
        await exhaust(d);
        expect(await authenticateApiKeyRequest(ipReq(bad), "ingest", d)).toMatchObject({ status: 429 });
        expect(resolve).toHaveBeenCalledTimes(burst); // 1 for `bad` + (burst - 1) of the exhausting keys
      });

      it("after the positive entry expires the failure budget applies again", async () => {
        const { valid, resolve, d, advance } = withClock();
        await authenticateApiKeyRequest(ipReq(valid), "ingest", d);
        // Keep the failure budget exhausted at the moment the cache expires: fail 10 times right then.
        advance(RATE_LIMITS.authCacheTtlMs);
        await exhaust(d);
        const calls = resolve.mock.calls.length;
        expect(await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).toMatchObject({ ok: false, status: 429 });
        expect(resolve.mock.calls.length).toBe(calls); // blocked before any lookup
        advance(1000); // one token refilled: the lookup is allowed again and succeeds
        expect((await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).ok).toBe(true);
        expect(resolve.mock.calls.length).toBe(calls + 1);
      });

      it("the per-key and normal per-IP limiters still apply to cached keys", async () => {
        const { valid, d } = withClock();
        await authenticateApiKeyRequest(ipReq(valid), "ingest", d);
        d.keyLimiter = new TokenBucketLimiter({ burst: 1, refillPerSec: 0.001 });
        await authenticateApiKeyRequest(ipReq(valid), "ingest", d);
        expect(await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).toMatchObject({ status: 429 });
        d.keyLimiter = new TokenBucketLimiter({ burst: 1000, refillPerSec: 1000 });
        d.ipLimiter = new TokenBucketLimiter({ burst: 1, refillPerSec: 0.001 });
        await authenticateApiKeyRequest(ipReq(valid), "ingest", d);
        expect(await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).toMatchObject({ status: 429 });
      });
    });

    it("a per-key rate limit (429) does not spend it", async () => {
      const { valid, d } = setup();
      d.keyLimiter = new TokenBucketLimiter({ burst: 1, refillPerSec: 0.001 });
      await authenticateApiKeyRequest(ipReq(valid), "ingest", d);
      for (let i = 0; i < 30; i++) expect(await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).toMatchObject({ status: 429 });
      d.keyLimiter = new TokenBucketLimiter({ burst: 100, refillPerSec: 100 });
      expect((await authenticateApiKeyRequest(ipReq(valid), "ingest", d)).ok).toBe(true);
    });
  });

  it("lets a database failure propagate (the route answers 503, not 401)", async () => {
    const d = deps({ authenticator: { authenticate: vi.fn().mockRejectedValue(new Error("db down")), cached: () => undefined } });
    await expect(authenticateApiKeyRequest(req({ authorization: `Bearer ${key}` }), "ingest", d)).rejects.toThrow("db down");
  });

  it("parses the Bearer header strictly", () => {
    expect(bearerToken(req({ authorization: "Bearer abc" }))).toBe("abc");
    expect(bearerToken(req({ authorization: "bearer abc" }))).toBe("abc");
    expect(bearerToken(req({ authorization: "Bearer a b" }))).toBeNull();
    expect(bearerToken(req({ authorization: "Token abc" }))).toBeNull();
    expect(bearerToken(req())).toBeNull();
  });

  it("clientIp takes the first hop only if it is a valid IP", () => {
    expect(clientIp(req({ "x-forwarded-for": "2001:db8::1, 1.2.3.4" }))).toBe("2001:db8::1");
    expect(clientIp(req({ "x-forwarded-for": "evil'; drop" }))).toBeNull();
    expect(clientIp(req())).toBeNull();
  });
});

describe("ctxFromApiKey connection retry", () => {
  const key = generateApiKey().secret;
  const connectionFailure = () => Object.assign(new NeonDbError("Error connecting to database: fetch failed"), { sourceError: new TypeError("fetch failed") });
  beforeEach(() => {
    mocks.sqlTag.mockReset();
    mocks.transaction.mockReset();
  });

  it("retries a connection failure once and then returns the context", async () => {
    mocks.sqlTag.mockRejectedValueOnce(connectionFailure()).mockResolvedValueOnce([{ project_id: PID, key_id: KID, scopes: ["ingest"] }]);
    const ctx = await ctxFromApiKey(key);
    expect(ctx).toMatchObject({ kind: "apiKey", projectIds: [PID], keyId: KID });
    expect(mocks.sqlTag).toHaveBeenCalledTimes(2);
  });

  it("surfaces a second connection failure and never retries a SQL error", async () => {
    mocks.sqlTag.mockRejectedValue(connectionFailure());
    await expect(ctxFromApiKey(key)).rejects.toBeInstanceOf(NeonDbError);
    expect(mocks.sqlTag).toHaveBeenCalledTimes(2);
    mocks.sqlTag.mockReset();
    mocks.sqlTag.mockRejectedValue(Object.assign(new NeonDbError("permission denied"), { code: "42501" }));
    await expect(ctxFromApiKey(key)).rejects.toBeInstanceOf(NeonDbError);
    expect(mocks.sqlTag).toHaveBeenCalledTimes(1);
  });

  it("returns null for an unknown key and does not query for a malformed one", async () => {
    mocks.sqlTag.mockResolvedValue([]);
    expect(await ctxFromApiKey(key)).toBeNull();
    mocks.sqlTag.mockClear();
    expect(await ctxFromApiKey("lm_nope")).toBeNull();
    expect(mocks.sqlTag).not.toHaveBeenCalled();
  });
});

describe("touchApiKey (last_used_at)", () => {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  beforeEach(() => {
    resetTouchThrottleForTests();
    stmts.length = 0;
    mocks.transaction.mockReset();
    mocks.transaction.mockImplementation(async (build: (t: (s: TemplateStringsArray, ...v: unknown[]) => unknown) => unknown[]) => {
      const t = (s: TemplateStringsArray, ...values: unknown[]) => ({ text: s.join("?"), values });
      const queries = build(t) as Array<{ text: string; values: unknown[] }>;
      stmts.push(...queries);
      return queries.map(() => []);
    });
  });

  it("writes at most once per interval per key (and not for another key's throttle)", async () => {
    const ctx = mkCtx();
    await touchApiKey(ctx);
    await touchApiKey(ctx);
    await touchApiKey(ctx);
    const updates = stmts.filter((s) => s.text.includes("update api_keys"));
    expect(updates).toHaveLength(1);
    await touchApiKey(mkCtx(["ingest"], "33333333-3333-4333-8333-333333333333"));
    expect(stmts.filter((s) => s.text.includes("update api_keys"))).toHaveLength(2);
  });

  it("only ever touches its own key id, runs under its own project scope, and skips revoked keys", async () => {
    await touchApiKey(mkCtx());
    const update = stmts.find((s) => s.text.includes("update api_keys"))!;
    expect(update.values).toContain(KID);
    expect(update.text).toContain("revoked_at is null");
    const scope = stmts.find((s) => s.text.includes("set_config"))!;
    expect(scope.values).toContain(PID);
  });

  it("never throws into the request, and retries on the next request after a failure", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("db down"));
    const ctx = mkCtx();
    await expect(touchApiKey(ctx)).resolves.toBe(false);
    mocks.transaction.mockImplementation(async (build: (t: (s: TemplateStringsArray, ...v: unknown[]) => unknown) => unknown[]) => {
      const t = (s: TemplateStringsArray, ...values: unknown[]) => ({ text: s.join("?"), values });
      stmts.push(...(build(t) as Array<{ text: string; values: unknown[] }>));
      return [[], []];
    });
    await touchApiKey(ctx);
    expect(stmts.filter((s) => s.text.includes("update api_keys"))).toHaveLength(1);
  });
});
