import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_LIVE_SNAPSHOT, LIVE_POLLER, createLivePoller, liveAnswerSchema, parseRetryAfterMs, type LiveResponseLike,
} from "@/lib/dashboard/live-poller";

/** Everything runs under vitest fake timers; the poller gets only injected dependencies, so no network, DOM or storage exists here. */
const ENDPOINT = "/api/dashboard/projects/p1/live";
const S = 1000;

const answer = (o: Record<string, unknown> = {}) => ({
  cursor: "c1", baseline: false, reset: false, truncated: false, newEvents: 0, newErrors: 0, newTraces: 0, traces: [], pollMs: 15_000, ...o,
});
const baseline = (o: Record<string, unknown> = {}) => answer({ baseline: true, ...o });
const res = (status: number, body: unknown = "", headers: Record<string, string> = {}): LiveResponseLike => ({
  status,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const ok = (body: unknown) => res(200, body);
/** A fallback handler: this answer for polls with a cursor, a plain baseline (same cursor and pollMs) for the first one. */
const plain = (o: Record<string, unknown>) => (url: string) =>
  ok(url.includes("cursor=") ? answer(o) : baseline({ cursor: o.cursor ?? "c1", pollMs: o.pollMs ?? 15_000 }));

type Handler = (url: string, init: { signal: AbortSignal }) => Promise<LiveResponseLike> | LiveResponseLike;
const HANG: Handler = () => new Promise<LiveResponseLike>(() => undefined);

function setup(over: { random?: () => number } = {}) {
  const t0 = Date.now();
  const calls: { url: string; at: number; signal: AbortSignal }[] = [];
  const script: Handler[] = [];
  // Default: a baseline for a request without a cursor, an empty answer for one with a cursor.
  let fallback: Handler = (url) => ok(url.includes("cursor=") ? answer() : baseline());
  const env = { visible: true, online: true, random: 0.5 };
  const poller = createLivePoller({
    fetchFn: async (url, init) => {
      calls.push({ url, at: Date.now() - t0, signal: init.signal });
      return (script.shift() ?? fallback)(url, init);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    random: over.random ?? (() => env.random),
    isVisible: () => env.visible,
    isOnline: () => env.online,
    endpoint: ENDPOINT,
  });
  return {
    poller, calls, env,
    /** The next calls answer in this order, then `fallback`. */
    queue: (...h: Handler[]) => void script.push(...h),
    setFallback: (h: Handler) => void (fallback = h),
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    gaps: () => calls.slice(1).map((c, i) => c.at - calls[i]!.at),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("baseline and cursor", () => {
  it("the first call has no cursor, the next ones send the last cursor, and nothing is stored outside memory", async () => {
    const h = setup();
    h.queue(() => ok(baseline({ cursor: "base1" })), () => ok(answer({ cursor: "next2" })));
    h.poller.start();
    await h.advance(0);
    expect(h.calls.map((c) => c.url)).toEqual([ENDPOINT]);
    await h.advance(15 * S);
    await h.advance(15 * S);
    expect(h.calls.map((c) => c.url)).toEqual([ENDPOINT, `${ENDPOINT}?cursor=base1`, `${ENDPOINT}?cursor=next2`]);
    // the poller has no storage dependency to write to: the test environment has none either
    expect(typeof (globalThis as { localStorage?: unknown }).localStorage).toBe("undefined");
    h.poller.stop();
  });

  it("start is idempotent: one baseline request, not two", async () => {
    const h = setup();
    h.poller.start();
    h.poller.start();
    await h.advance(0);
    expect(h.calls).toHaveLength(1);
    h.poller.stop();
  });

  it("each request asks for JSON without caching and carries an AbortSignal", async () => {
    const seen: unknown[] = [];
    const poller = createLivePoller({
      fetchFn: async (_u, init) => (seen.push(init), ok(baseline())),
      setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(), random: () => 0.5, isVisible: () => true, isOnline: () => true, endpoint: ENDPOINT,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const init = seen[0] as { signal: AbortSignal; headers: Record<string, string>; cache: string };
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({ Accept: "application/json" });
    poller.stop();
  });
});

describe("interval, jitter, overlap, timeout", () => {
  it("uses the server's pollMs, clamped to [5 s, 60 s]", async () => {
    for (const [pollMs, expected] of [[30_000, 30_000], [1_000, 5_000], [600_000, 60_000]] as const) {
      const h = setup();
      h.setFallback(plain({ pollMs }));
      h.poller.start();
      await h.advance(expected * 2 + 100);
      expect(h.gaps()[1], String(pollMs)).toBe(expected);
      h.poller.stop();
    }
  });

  it("jitter stays within +/-10 % of the delay and survives hostile random values", async () => {
    const cases: [number, number][] = [[0, 13_500], [0.5, 15_000], [0.999999, 16_500], [-5, 13_500], [7, 16_500], [Number.NaN, 15_000]];
    for (const [r, expected] of cases) {
      const h = setup({ random: () => r });
      h.poller.start();
      await h.advance(20 * S);
      expect(h.gaps()[0], String(r)).toBeGreaterThanOrEqual(13_500);
      expect(h.gaps()[0], String(r)).toBeLessThanOrEqual(16_500);
      expect(Math.abs(h.gaps()[0]! - expected), String(r)).toBeLessThanOrEqual(1);
      h.poller.stop();
    }
  });

  it("never has two requests in flight: nothing new starts while one hangs, whatever is called", async () => {
    const h = setup();
    h.queue(HANG);
    h.poller.start();
    await h.advance(0);
    h.poller.acknowledge();
    h.poller.notifyInteraction();
    h.poller.notifyEnvironmentChange();
    h.poller.resume();
    await h.advance(LIVE_POLLER.requestTimeoutMs - 1);
    expect(h.calls).toHaveLength(1);
    h.poller.stop();
  });

  it("aborts a request after the timeout and backs off as for any error", async () => {
    const h = setup();
    h.queue(HANG);
    h.poller.start();
    await h.advance(LIVE_POLLER.requestTimeoutMs);
    expect(h.calls[0]!.signal.aborted).toBe(true);
    await h.advance(15 * S - 1);
    expect(h.calls).toHaveLength(1);
    await h.advance(1);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.url).toBe(ENDPOINT); // still no cursor: nothing was ever stored
    h.poller.stop();
  });

  it("stop aborts the request in flight, clears every timer, and a late answer changes nothing", async () => {
    const h = setup();
    let release!: (r: LiveResponseLike) => void;
    h.queue(() => new Promise<LiveResponseLike>((r) => (release = r)));
    h.poller.start();
    await h.advance(0);
    h.poller.stop();
    expect(h.calls[0]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    release(ok(answer({ newEvents: 9, newErrors: 1, newTraces: 1 })));
    await h.advance(60 * S);
    expect(h.poller.getSnapshot()).toEqual(INITIAL_LIVE_SNAPSHOT);
    expect(h.calls).toHaveLength(1);
  });
});

describe("tab visibility and connectivity", () => {
  it("does not start while hidden; becoming visible polls once at once", async () => {
    const h = setup();
    h.env.visible = false;
    h.poller.start();
    await h.advance(10 * 60 * S);
    expect(h.calls).toHaveLength(0);
    h.env.visible = true;
    h.poller.notifyVisibilityChange();
    await h.advance(0);
    expect(h.calls).toHaveLength(1);
    h.poller.stop();
  });

  it("hidden: aborts the request in flight without an error, sends nothing; visible: ONE immediate poll with the kept cursor", async () => {
    const h = setup();
    h.queue(() => ok(baseline({ cursor: "kept" })), HANG);
    h.poller.start();
    await h.advance(15 * S);
    expect(h.calls).toHaveLength(2);
    h.env.visible = false;
    h.poller.notifyVisibilityChange();
    expect(h.calls[1]!.signal.aborted).toBe(true);
    await h.advance(30 * 60 * S);
    expect(h.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    h.env.visible = true;
    h.poller.notifyVisibilityChange();
    await h.advance(0);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.url).toBe(`${ENDPOINT}?cursor=kept`);
    // visibility changes while visible do not multiply requests
    h.poller.notifyVisibilityChange();
    h.poller.notifyVisibilityChange();
    await h.advance(0);
    expect(h.calls).toHaveLength(3);
    h.poller.stop();
  });

  it("offline pauses, online resumes with one immediate poll", async () => {
    const h = setup();
    h.poller.start();
    await h.advance(0);
    h.env.online = false;
    h.poller.notifyEnvironmentChange();
    await h.advance(5 * 60 * S);
    expect(h.calls).toHaveLength(1);
    h.env.online = true;
    h.poller.notifyEnvironmentChange();
    await h.advance(0);
    expect(h.calls).toHaveLength(2);
    h.poller.stop();
  });

  it("coming back online does not count as an interaction: after 10 idle minutes offline it pauses instead of polling", async () => {
    const h = setup();
    h.poller.start();
    await h.advance(0);
    h.env.online = false;
    h.poller.notifyEnvironmentChange();
    await h.advance(LIVE_POLLER.idleStopMs + S);
    h.env.online = true;
    h.poller.notifyEnvironmentChange();
    await h.advance(0);
    expect(h.calls).toHaveLength(1);
    expect(h.poller.getSnapshot().status).toBe("paused");
    h.poller.stop();
  });

  it("hidden AND offline needs both to be undone", async () => {
    const h = setup();
    h.poller.start();
    await h.advance(0);
    h.env.visible = false;
    h.env.online = false;
    h.poller.notifyEnvironmentChange();
    h.env.visible = true;
    h.poller.notifyVisibilityChange();
    await h.advance(60 * S);
    expect(h.calls).toHaveLength(1);
    h.env.online = true;
    h.poller.notifyEnvironmentChange();
    await h.advance(0);
    expect(h.calls).toHaveLength(2);
    h.poller.stop();
  });

});

describe("idle back-off", () => {
  it("doubles after four empty answers up to the ceiling, and the first non-empty answer returns the interval to the base", async () => {
    const h = setup();
    h.queue(() => ok(baseline()), ...Array.from({ length: 6 }, () => () => ok(answer())), () => ok(answer({ newEvents: 1 })));
    h.poller.start();
    const keepAlive = setInterval(() => h.poller.notifyInteraction(), 60 * S);
    await h.advance(20 * 60 * S);
    clearInterval(keepAlive);
    const g = h.gaps();
    // baseline, 6 empty answers, then the non-empty one is call 8: gaps are 15,15,15,15,30,60,60 then 15
    expect(g.slice(0, 8)).toEqual([15, 15, 15, 15, 30, 60, 60, 15].map((s) => s * S));
    h.poller.stop();
  });

  it("the ceiling is never exceeded, even with a long streak", async () => {
    const h = setup();
    const keepAlive = setInterval(() => h.poller.notifyInteraction(), 60 * S);
    h.poller.start();
    await h.advance(60 * 60 * S);
    clearInterval(keepAlive);
    expect(Math.max(...h.gaps())).toBe(LIVE_POLLER.backoffCeilingMs);
    h.poller.stop();
  });
});

describe("idle stop and resume", () => {
  it("stops after 10 minutes without interaction, then sends nothing at all, and shows paused", async () => {
    const h = setup();
    h.poller.start();
    await h.advance(LIVE_POLLER.idleStopMs + 61 * S);
    expect(h.poller.getSnapshot().status).toBe("paused");
    const n = h.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await h.advance(3 * 60 * 60 * S);
    expect(h.calls).toHaveLength(n);
  });

  it("interaction keeps it alive, but never un-pauses it", async () => {
    const h = setup();
    const keep = setInterval(() => h.poller.notifyInteraction(), 5 * 60 * S);
    h.poller.start();
    await h.advance(60 * 60 * S);
    expect(h.poller.getSnapshot().status).toBe("live");
    clearInterval(keep);
    await h.advance(LIVE_POLLER.idleStopMs + 61 * S);
    expect(h.poller.getSnapshot().status).toBe("paused");
    const n = h.calls.length;
    h.poller.notifyInteraction();
    await h.advance(5 * 60 * S);
    expect(h.calls).toHaveLength(n);
    expect(h.poller.getSnapshot().status).toBe("paused");
  });

  it("resume polls at once with the cursor kept, goes live again, and is a no-op when not paused", async () => {
    const h = setup();
    h.setFallback(plain({ cursor: "cur" }));
    h.poller.resume(); // not started: nothing
    h.poller.start();
    await h.advance(LIVE_POLLER.idleStopMs + 61 * S);
    expect(h.poller.getSnapshot().status).toBe("paused");
    const n = h.calls.length;
    h.poller.resume();
    expect(h.poller.getSnapshot().status).toBe("live");
    await h.advance(0);
    expect(h.calls).toHaveLength(n + 1);
    expect(h.calls[n]!.url).toBe(`${ENDPOINT}?cursor=cur`);
    h.poller.resume(); // live: nothing
    await h.advance(0);
    expect(h.calls).toHaveLength(n + 1);
    h.poller.stop();
  });

  it("a tab that was hidden for hours does not pause on return (becoming visible counts as an interaction)", async () => {
    const h = setup();
    h.poller.start();
    await h.advance(0);
    h.env.visible = false;
    h.poller.notifyVisibilityChange();
    await h.advance(3 * 60 * 60 * S);
    h.env.visible = true;
    h.poller.notifyVisibilityChange();
    await h.advance(0);
    expect(h.poller.getSnapshot().status).toBe("live");
    expect(h.calls).toHaveLength(2);
    h.poller.stop();
  });
});

describe("status codes", () => {
  it("401 stops for good: ended (session), no more requests, resume does nothing", async () => {
    const h = setup();
    h.queue(() => ok(baseline()), () => res(401, { error: "unauthorized" }));
    h.poller.start();
    await h.advance(15 * S);
    expect(h.poller.getSnapshot()).toMatchObject({ status: "ended", endReason: "session_ended" });
    h.poller.resume();
    h.poller.acknowledge();
    h.env.visible = false;
    h.poller.notifyVisibilityChange();
    h.env.visible = true;
    h.poller.notifyVisibilityChange();
    await h.advance(60 * 60 * S);
    expect(h.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("404 stops for good: ended (not found)", async () => {
    const h = setup();
    h.queue(() => res(404, { error: "not_found" }));
    h.poller.start();
    await h.advance(0);
    expect(h.poller.getSnapshot()).toMatchObject({ status: "ended", endReason: "not_found" });
    await h.advance(60 * 60 * S);
    expect(h.calls).toHaveLength(1);
  });

  it("400 with a cursor drops it and takes ONE fresh baseline (no cursor) after a short delay", async () => {
    const h = setup();
    h.queue(() => ok(baseline({ cursor: "old" })), () => res(400, { error: "invalid_request" }), () => ok(baseline({ cursor: "fresh" })));
    h.poller.start();
    await h.advance(15 * S);
    expect(h.calls[1]!.url).toBe(`${ENDPOINT}?cursor=old`);
    await h.advance(LIVE_POLLER.rebaselineDelayMs);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.url).toBe(ENDPOINT);
    await h.advance(15 * S);
    expect(h.calls[3]!.url).toBe(`${ENDPOINT}?cursor=fresh`);
    h.poller.stop();
  });

  it("repeated 400s do not spin: after three in a row they back off like errors", async () => {
    const h = setup();
    h.setFallback((url) => (url.includes("cursor=") ? res(400, "") : ok(baseline({ cursor: "cc" }))));
    h.poller.start();
    await h.advance(10 * 60 * S);
    h.poller.stop();
    // never faster than the 1 s re-baseline delay, and the number of calls in 10 minutes stays small
    expect(Math.min(...h.gaps())).toBeGreaterThanOrEqual(LIVE_POLLER.rebaselineDelayMs);
    expect(h.calls.length).toBeLessThan(60);
  });

  it("400 on the baseline itself is an error with back-off, not a loop", async () => {
    const h = setup();
    h.setFallback(() => res(400, ""));
    h.poller.start();
    await h.advance(5 * 60 * S);
    expect(h.gaps().slice(0, 4)).toEqual([15, 30, 60, 60].map((s) => s * S));
    h.poller.stop();
  });

  it("reset:true stores the fresh baseline and marks counters as 'at least'", async () => {
    const h = setup();
    h.queue(() => ok(baseline({ cursor: "a" })), () => ok(baseline({ cursor: "fresh", reset: true })), () => ok(answer({ cursor: "n", newEvents: 3, newErrors: 1 })));
    h.poller.start();
    await h.advance(30 * S);
    expect(h.calls[2]!.url).toBe(`${ENDPOINT}?cursor=fresh`);
    expect(h.poller.getSnapshot()).toMatchObject({ newEvents: 3, newErrors: 1, atLeast: true });
    h.poller.stop();
  });

  it("429 waits at least Retry-After, capped at 60 s", async () => {
    const h = setup();
    h.queue(() => res(429, "", { "retry-after": "40" }));
    h.poller.start();
    await h.advance(40 * S - 1);
    expect(h.calls).toHaveLength(1);
    await h.advance(1);
    expect(h.calls).toHaveLength(2);
    h.queue(() => res(429, "", { "retry-after": "999999" }));
    await h.advance(15 * S);
    expect(h.calls).toHaveLength(3);
    await h.advance(60 * S - 1);
    expect(h.calls).toHaveLength(3);
    await h.advance(1);
    expect(h.calls).toHaveLength(4);
    h.poller.stop();
  });

  it("429 without a usable Retry-After falls back to the error back-off; a short one never speeds up polling", async () => {
    const h = setup();
    h.queue(() => res(429, "", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), () => res(429, "", { "retry-after": "1" }));
    h.poller.start();
    await h.advance(60 * S);
    expect(h.gaps()[0]).toBe(15 * S);
    expect(h.gaps()[1]).toBe(15 * S);
    h.poller.stop();
  });

  it("503 and network errors back off exponentially to the ceiling, never spin, and recover on success", async () => {
    const h = setup();
    h.queue(() => res(503, { error: "service_unavailable" }, { "retry-after": "5" }), () => { throw new TypeError("network"); }, () => res(503, ""), () => res(503, ""), () => res(503, ""));
    h.poller.start();
    await h.advance(10 * 60 * S);
    expect(h.gaps().slice(0, 5)).toEqual([15, 30, 60, 60, 60].map((s) => s * S)); // Retry-After 5 never shortens it
    expect(h.gaps().slice(5, 8)).toEqual([15, 15, 15].map((s) => s * S)); // back to normal after the first success
    h.poller.stop();
  });

  it("503 Retry-After above the computed back-off is honoured (capped)", async () => {
    const h = setup();
    h.queue(() => res(503, "", { "retry-after": "45" }));
    h.poller.start();
    await h.advance(45 * S - 1);
    expect(h.calls).toHaveLength(1);
    await h.advance(1);
    expect(h.calls).toHaveLength(2);
    h.poller.stop();
  });

  it("every other status (500, 403, 302, 418) is an error with back-off, and an error never touches counters or the cursor", async () => {
    for (const status of [500, 403, 302, 418, 204, 201]) {
      const h = setup();
      h.queue(() => ok(baseline({ cursor: "keep" })), () => res(status, answer({ newEvents: 99 })));
      h.poller.start();
      await h.advance(15 * S);
      expect(h.poller.getSnapshot(), String(status)).toEqual(INITIAL_LIVE_SNAPSHOT);
      await h.advance(15 * S);
      expect(h.calls[2]!.url, String(status)).toBe(`${ENDPOINT}?cursor=keep`);
      h.poller.stop();
    }
  });
});

describe("strict validation of the body", () => {
  const good = answer();
  const HOSTILE: [string, unknown][] = [
    ["extra key", { ...good, extra: 1 }],
    ["proto key", JSON.parse('{"cursor":"c","baseline":false,"reset":false,"truncated":false,"newEvents":0,"newErrors":0,"newTraces":0,"traces":[],"pollMs":15000,"__proto__":{"x":1}}')],
    ["missing field", (() => { const { pollMs: _p, ...rest } = good; void _p; return rest; })()],
    ["number as string", { ...good, newEvents: "5" }],
    ["negative", { ...good, newEvents: -1 }],
    ["fraction", { ...good, newEvents: 1.5 }],
    ["huge", { ...good, newEvents: 1e308 }],
    ["above the per-answer bound", { ...good, newEvents: 100_001 }],
    ["bad cursor chars", { ...good, cursor: "../../etc" }],
    ["cursor with query", { ...good, cursor: "a?b=c" }],
    ["cursor too long", { ...good, cursor: "a".repeat(201) }],
    ["empty cursor", { ...good, cursor: "" }],
    ["null cursor", { ...good, cursor: null }],
    ["baseline with counts", { ...good, baseline: true, newEvents: 3 }],
    ["baseline truncated", { ...good, baseline: true, truncated: true }],
    ["reset without baseline", { ...good, reset: true }],
    ["errors above events", { ...good, newEvents: 1, newErrors: 2 }],
    ["traces above events", { ...good, newEvents: 1, newTraces: 2 }],
    ["traces not an array", { ...good, traces: "x" }],
    ["too many traces", { ...good, traces: Array.from({ length: 51 }, () => ({})) }],
    ["pollMs zero", { ...good, pollMs: 0 }],
    ["pollMs huge", { ...good, pollMs: 1e9 }],
    ["pollMs fraction", { ...good, pollMs: 15000.5 }],
    ["truncated as string", { ...good, truncated: "true" }],
    ["array root", [good]],
    ["null root", null],
    ["string root", "ok"],
    ["number root", 5],
  ];
  for (const [name, body] of HOSTILE) {
    it(`rejects: ${name} (counts as an error, nothing is trusted)`, async () => {
      const h = setup();
      h.queue(() => ok(baseline({ cursor: "keep" })), () => res(200, JSON.stringify(body)));
      h.poller.start();
      await h.advance(15 * S);
      expect(h.poller.getSnapshot()).toEqual(INITIAL_LIVE_SNAPSHOT);
      await h.advance(15 * S); // error back-off of one step = 15 s
      expect(h.calls[2]!.url).toBe(`${ENDPOINT}?cursor=keep`);
      h.poller.stop();
    });
  }

  it("rejects non-JSON, empty and oversized bodies", async () => {
    for (const text of ["", "not json", "{", "<html></html>", " ".repeat(LIVE_POLLER.maxBodyChars + 1) + JSON.stringify(good)]) {
      const h = setup();
      h.queue(() => ok(baseline({ cursor: "keep" })), () => res(200, text));
      h.poller.start();
      await h.advance(30 * S);
      expect(h.poller.getSnapshot()).toEqual(INITIAL_LIVE_SNAPSHOT);
      expect(h.calls[2]!.url).toBe(`${ENDPOINT}?cursor=keep`);
      h.poller.stop();
    }
  });

  it("a request without a cursor must get a baseline; with a cursor, a baseline must say reset", async () => {
    const h = setup();
    h.queue(() => ok(answer({ cursor: "bad", newEvents: 5 })));
    h.poller.start();
    await h.advance(0);
    expect(h.poller.getSnapshot()).toEqual(INITIAL_LIVE_SNAPSHOT);
    await h.advance(15 * S);
    expect(h.calls[1]!.url).toBe(ENDPOINT); // the "cursor" of the bogus answer was not kept
    const g = setup();
    g.queue(() => ok(baseline({ cursor: "a" })), () => ok(baseline({ cursor: "b" })));
    g.poller.start();
    await g.advance(15 * S);
    await g.advance(15 * S);
    expect(g.calls[2]!.url).toBe(`${ENDPOINT}?cursor=a`);
    h.poller.stop();
    g.poller.stop();
  });

  it("a valid body is accepted, trace contents are dropped, and the schema is exported strict", () => {
    const parsed = liveAnswerSchema.parse({ ...good, newEvents: 1, traces: [{ traceId: "t", rootName: "secret" }] });
    expect(parsed.traces).toHaveLength(1);
    expect(liveAnswerSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });

  it("the snapshot never holds anything but counts, a status and flags", async () => {
    const h = setup();
    h.queue(() => ok(baseline()), () => ok(answer({ newEvents: 1, newTraces: 1, traces: [{ traceId: "SECRET-TRACE", rootName: "SECRET-NAME" }] })));
    h.poller.start();
    await h.advance(15 * S);
    expect(JSON.stringify(h.poller.getSnapshot())).not.toMatch(/SECRET/);
    expect(Object.keys(h.poller.getSnapshot()).sort()).toEqual(["atLeast", "endReason", "newErrors", "newEvents", "newTraces", "status"]);
    h.poller.stop();
  });
});

describe("counters", () => {
  it("accumulates across polls, ignores the baseline, and marks truncated as 'at least'", async () => {
    const h = setup();
    h.queue(
      () => ok(baseline()),
      () => ok(answer({ newEvents: 5, newErrors: 1, newTraces: 2 })),
      () => ok(answer({ newEvents: 7, newErrors: 0, newTraces: 1 })),
    );
    h.poller.start();
    await h.advance(15 * S);
    expect(h.poller.getSnapshot()).toMatchObject({ newEvents: 5, newErrors: 1, newTraces: 2, atLeast: false });
    await h.advance(15 * S);
    expect(h.poller.getSnapshot()).toMatchObject({ newEvents: 12, newErrors: 1, newTraces: 3, atLeast: false });
    h.queue(() => ok(answer({ newEvents: 1000, newErrors: 4, newTraces: 9, truncated: true })));
    await h.advance(15 * S);
    expect(h.poller.getSnapshot()).toMatchObject({ newEvents: 1012, newErrors: 5, atLeast: true });
    // "at least" stays until the counters are cleared
    await h.advance(15 * S);
    expect(h.poller.getSnapshot().atLeast).toBe(true);
    h.poller.stop();
  });

  it("clamps a runaway counter at the cap and says 'at least'", async () => {
    const h = setup();
    h.setFallback(plain({ newEvents: 100_000, newErrors: 100_000, newTraces: 100_000 }));
    const keep = setInterval(() => h.poller.notifyInteraction(), 60 * S);
    h.poller.start();
    await h.advance(60 * 60 * S);
    clearInterval(keep);
    const s = h.poller.getSnapshot();
    expect(s.newEvents).toBe(LIVE_POLLER.counterCap);
    expect(s.atLeast).toBe(true);
    h.poller.stop();
  });

  it("acknowledge zeroes the counters and the next answer counts nothing (what the new page shows is not announced again)", async () => {
    const h = setup();
    h.queue(() => ok(baseline()), () => ok(answer({ newEvents: 3, newErrors: 1 })), () => ok(answer({ newEvents: 2 })), () => ok(answer({ newEvents: 4, newErrors: 1 })));
    h.poller.start();
    await h.advance(15 * S);
    expect(h.poller.getSnapshot().newEvents).toBe(3);
    h.poller.acknowledge();
    expect(h.poller.getSnapshot()).toEqual(INITIAL_LIVE_SNAPSHOT);
    await h.advance(0); // the extra request happens at once
    expect(h.calls).toHaveLength(3);
    expect(h.poller.getSnapshot().newEvents).toBe(0); // its 2 events were discarded
    await h.advance(15 * S);
    expect(h.poller.getSnapshot()).toMatchObject({ newEvents: 4, newErrors: 1 });
    h.poller.stop();
  });

  it("subscribers hear about changes only, and can unsubscribe", async () => {
    const h = setup();
    h.queue(() => ok(baseline()), () => ok(answer()), () => ok(answer({ newEvents: 1 })));
    const seen: number[] = [];
    const off = h.poller.subscribe(() => seen.push(h.poller.getSnapshot().newEvents));
    h.poller.start();
    await h.advance(15 * S); // the baseline and an empty answer change nothing
    expect(seen).toEqual([]);
    await h.advance(15 * S);
    expect(seen).toEqual([1]);
    off();
    h.queue(() => ok(answer({ newEvents: 1 })));
    await h.advance(15 * S);
    expect(seen).toEqual([1]);
    h.poller.stop();
  });
});

describe("helpers", () => {
  it("parseRetryAfterMs accepts whole seconds only and caps", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs(" 7 ")).toBe(7000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("999999")).toBe(LIVE_POLLER.retryAfterCapMs);
    for (const bad of [null, "", "-1", "1.5", "1e3", "abc", "Wed, 21 Oct 2026 07:28:00 GMT", "1234567"]) expect(parseRetryAfterMs(bad), String(bad)).toBeNull();
  });
});
