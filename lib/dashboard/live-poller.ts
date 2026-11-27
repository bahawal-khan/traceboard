import { z } from "zod";

/**
 * Client side of GET /api/dashboard/projects/[id]/live (P3.9a): framework-agnostic polling logic. No React, no window, no
 * document, no navigator, no storage: every outside thing (the HTTP call, timers, the clock, tab visibility, connectivity, random
 * numbers) is injected, so the whole state machine runs under fake timers in unit tests. The React wrapper
 * (components/dashboard/live-updates.tsx) only wires real browser objects and DOM events into it.
 *
 * STATE MACHINE (status: live | paused | ended; "hidden" and "offline" are SUSPENSIONS of live, not statuses)
 *
 *   start()            -> live; first request has NO cursor (baseline). Only the returned cursor is kept, IN MEMORY.
 *   live, runnable     -> one timer; on fire: idle check, then one request (never two at once).
 *   answer 200         -> store cursor, add counters (never from a baseline/reset answer), next delay = server pollMs
 *                         (clamped) with jitter; after EMPTY_BEFORE_BACKOFF empty answers in a row the delay doubles each
 *                         time up to the ceiling; the first non-empty answer returns it to the base.
 *   answer 400         -> drop the cursor, take a fresh baseline once (counters may be incomplete: "at least").
 *   reset:true         -> the server already answered with a fresh baseline: store it, counters "at least".
 *   answer 401 / 404   -> ended for good (no timer, no resume).
 *   answer 429         -> wait at least Retry-After (capped).
 *   503, network error, timeout, any other status, any body that fails the strict schema -> exponential back-off with a ceiling.
 *   tab hidden / offline -> cancel the request in flight (no error), no timer; visible again / online again -> ONE immediate poll.
 *   no interaction for IDLE_STOP_MS -> paused (no timer). Only resume() (the Resume button) leaves it.
 *
 * Nothing the answer contains besides the three counters, the truncated/baseline/reset flags, the cursor and pollMs is kept: the
 * `traces` array is validated only as "an array of at most N things" and dropped (the banner shows counts, never content).
 */

export const LIVE_POLLER = {
  /** Used until the server's `pollMs` is known (it matches LIVE_POLL_MS in lib/http/live-route.ts). */
  defaultPollMs: 15_000,
  /** The server's hint is honoured but never below this nor above maxPollMs (a hostile or buggy hint must not make a fast loop). */
  minPollMs: 5_000,
  maxPollMs: 60_000,
  /** Random spread of each delay: delay * (1 +/- jitterFraction). */
  jitterFraction: 0.1,
  requestTimeoutMs: 10_000,
  /** This many empty answers in a row at the base interval; every further empty answer doubles the delay. */
  emptyBeforeBackoff: 4,
  /** Ceiling of the idle back-off and of the error back-off (before jitter). */
  backoffCeilingMs: 60_000,
  /** No mouse, key, touch or scroll for this long: stop and offer Resume. */
  idleStopMs: 10 * 60_000,
  retryAfterCapMs: 60_000,
  /** Delay before the fresh baseline that follows a 400. */
  rebaselineDelayMs: 1_000,
  /** Consecutive 400s (with a cursor) without a normal answer in between before they count as errors and back off. */
  maxBadCursorStreak: 3,
  /** Longest body text parsed (a real answer is about 2 KB). */
  maxBodyChars: 65_536,
  /** Counters are clamped here and then shown as "at least". */
  counterCap: 1_000_000,
} as const;

const cursorSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const countSchema = z.number().int().min(0).max(100_000);

/**
 * The answer, validated strictly: unknown keys, wrong types, impossible combinations (a baseline that carries counts, more errors
 * than events, reset without baseline) and absurd numbers are all rejected, and a rejected body is an error, never trusted.
 */
export const liveAnswerSchema = z
  .strictObject({
    cursor: cursorSchema,
    baseline: z.boolean(),
    reset: z.boolean(),
    truncated: z.boolean(),
    newEvents: countSchema,
    newErrors: countSchema,
    newTraces: countSchema,
    traces: z.array(z.unknown()).max(50),
    pollMs: z.number().int().min(1_000).max(600_000),
  })
  .refine((b) => !b.reset || b.baseline, "reset implies baseline")
  .refine((b) => !b.baseline || (b.newEvents === 0 && b.newErrors === 0 && b.newTraces === 0 && !b.truncated), "a baseline carries no counts")
  .refine((b) => b.newErrors <= b.newEvents && b.newTraces <= b.newEvents, "subsets cannot exceed events");
export type LiveAnswer = z.infer<typeof liveAnswerSchema>;

export type LiveStatus = "live" | "paused" | "ended";
export type LiveEndReason = "session_ended" | "not_found";

export interface LiveSnapshot {
  status: LiveStatus;
  /** Set only when status is "ended". */
  endReason: LiveEndReason | null;
  /** Counted since the page was loaded or last refreshed. */
  newEvents: number;
  newErrors: number;
  /** Summed over polls: a trace that gets events in two polls is counted twice, so this is an upper bound. Not shown today. */
  newTraces: number;
  /** The numbers are a lower bound: the server truncated an answer, a cursor was lost, or a counter hit its cap. */
  atLeast: boolean;
}

export const INITIAL_LIVE_SNAPSHOT: LiveSnapshot = { status: "live", endReason: null, newEvents: 0, newErrors: 0, newTraces: 0, atLeast: false };

/** The minimum of a Response the poller reads. */
export interface LiveResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface LivePollerDeps {
  /** The HTTP call (injected so tests need no network). Named fetchFn on purpose. */
  fetchFn: (url: string, init: { signal: AbortSignal; headers: Record<string, string>; cache: "no-store" }) => Promise<LiveResponseLike>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  /** Uniform in [0, 1). Anything else is clamped. */
  random: () => number;
  isVisible: () => boolean;
  isOnline: () => boolean;
  /** Path of the endpoint WITHOUT query, for example /api/dashboard/projects/<id>/live. */
  endpoint: string;
}

type Outcome =
  | { kind: "ok"; answer: LiveAnswer }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "bad_request" }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "error"; retryAfterMs: number | null };

/** Retry-After as whole seconds only ("5"); a date or anything else is ignored. Capped. */
export function parseRetryAfterMs(raw: string | null): number | null {
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return null;
  return Math.min(Number(raw.trim()) * 1000, LIVE_POLLER.retryAfterCapMs);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function createLivePoller(deps: LivePollerDeps) {
  const L = LIVE_POLLER;
  let snap: LiveSnapshot = INITIAL_LIVE_SNAPSHOT;
  const listeners = new Set<() => void>();

  let started = false;
  let suspended = false; // hidden or offline
  let cursor: string | null = null;
  let pollMs: number = L.defaultPollMs;
  let emptyStreak = 0;
  let errorStreak = 0;
  let badCursorStreak = 0;
  let discardNext = false;
  let lastInteractionMs = deps.now();
  let timer: unknown = null;
  let generation = 0;
  let inFlight: { controller: AbortController; timeout: unknown } | null = null;

  const basePoll = () => clamp(pollMs, L.minPollMs, L.maxPollMs);
  const ceiling = () => Math.max(L.backoffCeilingMs, basePoll());

  function jitter(ms: number): number {
    const r = deps.random();
    const u = Number.isFinite(r) ? clamp(r, 0, 1) : 0.5;
    return Math.round(ms * (1 + (u * 2 - 1) * L.jitterFraction));
  }
  /** Delay after a normal answer: the base, doubled for every empty answer beyond the allowed streak, up to the ceiling. */
  function idleDelay(): number {
    const extra = emptyStreak - L.emptyBeforeBackoff + 1;
    const raw = extra > 0 ? basePoll() * 2 ** Math.min(extra, 16) : basePoll();
    return jitter(Math.min(raw, ceiling()));
  }
  function errorDelay(retryAfterMs: number | null): number {
    const raw = Math.min(basePoll() * 2 ** Math.min(Math.max(errorStreak - 1, 0), 16), ceiling());
    return Math.max(jitter(raw), retryAfterMs ?? 0); // Retry-After is a floor: never shortened by jitter
  }

  function set(next: Partial<LiveSnapshot>) {
    const merged = { ...snap, ...next };
    if ((Object.keys(merged) as (keyof LiveSnapshot)[]).every((k) => merged[k] === snap[k])) return;
    snap = merged;
    for (const l of [...listeners]) l();
  }

  const runnable = () => started && snap.status === "live" && !suspended;
  function clearTimer() {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
  }
  function schedule(ms: number) {
    clearTimer();
    if (!runnable()) return;
    timer = deps.setTimeout(tick, Math.max(0, ms));
  }
  /** Abort the request in flight (if any) and make its late answer irrelevant. */
  function cancel() {
    generation++;
    const f = inFlight;
    inFlight = null;
    if (f) {
      deps.clearTimeout(f.timeout);
      f.controller.abort();
    }
  }

  function tick() {
    timer = null;
    if (!runnable() || inFlight) return;
    if (deps.now() - lastInteractionMs >= L.idleStopMs) {
      set({ status: "paused" });
      return;
    }
    void poll();
  }

  async function request(sent: string | null, controller: AbortController): Promise<Outcome> {
    const url = sent === null ? deps.endpoint : `${deps.endpoint}?cursor=${sent}`;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const res = await Promise.race([deps.fetchFn(url, { signal: controller.signal, headers: { Accept: "application/json" }, cache: "no-store" }), aborted]);
    switch (res.status) {
      case 200: {
        const text = await Promise.race([res.text(), aborted]);
        if (typeof text !== "string" || text.length > L.maxBodyChars) return { kind: "error", retryAfterMs: null };
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          return { kind: "error", retryAfterMs: null };
        }
        const parsed = liveAnswerSchema.safeParse(raw);
        return parsed.success ? { kind: "ok", answer: parsed.data } : { kind: "error", retryAfterMs: null };
      }
      case 401:
        return { kind: "unauthorized" };
      case 404:
        return { kind: "not_found" };
      case 400:
        return { kind: "bad_request" };
      case 429:
        return { kind: "rate_limited", retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")) };
      default:
        return { kind: "error", retryAfterMs: res.status === 503 ? parseRetryAfterMs(res.headers.get("retry-after")) : null };
    }
  }

  async function poll() {
    const gen = ++generation;
    const controller = new AbortController();
    const sent = cursor;
    const timeout = deps.setTimeout(() => controller.abort(), L.requestTimeoutMs);
    inFlight = { controller, timeout };
    let outcome: Outcome;
    try {
      outcome = await request(sent, controller);
    } catch {
      outcome = { kind: "error", retryAfterMs: null }; // network error, timeout abort, anything thrown
    } finally {
      deps.clearTimeout(timeout);
    }
    if (gen !== generation) return; // cancelled meanwhile (hidden, offline, stopped, resumed): its answer is irrelevant
    inFlight = null;
    apply(outcome, sent);
  }

  function failure(retryAfterMs: number | null) {
    errorStreak++;
    schedule(errorDelay(retryAfterMs));
  }

  function end(reason: LiveEndReason) {
    clearTimer();
    cancel();
    set({ status: "ended", endReason: reason });
  }

  function apply(o: Outcome, sent: string | null) {
    switch (o.kind) {
      case "unauthorized":
        return end("session_ended");
      case "not_found":
        return end("not_found");
      case "rate_limited":
        if (o.retryAfterMs === null) return failure(null);
        return schedule(Math.max(idleDelay(), o.retryAfterMs));
      case "error":
        return failure(o.retryAfterMs);
      case "bad_request":
        if (sent === null) return failure(null); // the baseline itself was refused: not a cursor problem
        cursor = null;
        badCursorStreak++;
        set({ atLeast: true });
        if (badCursorStreak >= L.maxBadCursorStreak) return failure(null);
        return schedule(L.rebaselineDelayMs);
      case "ok":
        return applyAnswer(o.answer, sent);
    }
  }

  function applyAnswer(a: LiveAnswer, sent: string | null) {
    // A request without a cursor must be answered with a baseline, and a baseline for a request WITH a cursor must say reset.
    if ((sent === null && !a.baseline) || (sent !== null && a.baseline && !a.reset)) return failure(null);
    errorStreak = 0;
    pollMs = a.pollMs;
    cursor = a.cursor;
    const discard = discardNext;
    discardNext = false;
    if (a.baseline) {
      if (a.reset) set({ atLeast: true });
    } else {
      badCursorStreak = 0;
      if (a.newEvents === 0) emptyStreak++;
      else emptyStreak = 0;
      if (!discard && a.newEvents > 0) {
        const cap = L.counterCap;
        const events = snap.newEvents + a.newEvents;
        const errors = snap.newErrors + a.newErrors;
        const traces = snap.newTraces + a.newTraces;
        set({
          newEvents: Math.min(events, cap),
          newErrors: Math.min(errors, cap),
          newTraces: Math.min(traces, cap),
          atLeast: snap.atLeast || a.truncated || events > cap || errors > cap || traces > cap,
        });
      }
    }
    schedule(idleDelay());
  }

  function wake() {
    if (!runnable() || inFlight) return;
    schedule(0);
  }

  function environmentChanged() {
    if (!started || snap.status === "ended") return;
    const ok = deps.isVisible() && deps.isOnline();
    if (!ok) {
      suspended = true;
      clearTimer();
      cancel();
      return;
    }
    if (suspended) {
      suspended = false;
      emptyStreak = 0;
      errorStreak = 0;
      wake();
    }
  }

  return {
    getSnapshot: (): LiveSnapshot => snap,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Begin polling (the first request is the baseline). Idempotent. */
    start() {
      if (started) return;
      started = true;
      suspended = !(deps.isVisible() && deps.isOnline());
      lastInteractionMs = deps.now();
      if (!suspended) schedule(0);
    },
    /** Abort everything and clear the timer (unmount). The poller can be started again. */
    stop() {
      started = false;
      clearTimer();
      cancel();
    },
    /** Call on mouse, key, touch and scroll events. Cheap on purpose. Never resumes a paused poller by itself. */
    notifyInteraction() {
      lastInteractionMs = deps.now();
    },
    /** Call on `visibilitychange`. Hidden: cancel and wait. Visible: counts as an interaction and polls once at once. */
    notifyVisibilityChange() {
      if (deps.isVisible()) lastInteractionMs = deps.now();
      environmentChanged();
    },
    /** Call on `online` and `offline`. Reads the injected state. */
    notifyEnvironmentChange: environmentChanged,
    /** The Resume button: only from `paused`. Polls once at once with the cursor kept (the server answers reset if it is too old). */
    resume() {
      if (!started || snap.status !== "paused") return;
      lastInteractionMs = deps.now();
      emptyStreak = 0;
      errorStreak = 0;
      set({ status: "live" });
      wake();
    },
    /**
     * The page now shows what the server has (Refresh clicked, or another page of the project opened): zero the counters and make
     * the next answer count nothing, so events the new page already shows are not announced again. One extra request when live.
     */
    acknowledge() {
      discardNext = true;
      set({ newEvents: 0, newErrors: 0, newTraces: 0, atLeast: false });
      wake();
    },
  };
}

export type LivePoller = ReturnType<typeof createLivePoller>;
