import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_RANGE, overviewState, parseRangeParam } from "@/lib/dashboard/page-state";
import { buildOverview } from "@/lib/dashboard/overview";
import { getDemoOverview } from "@/lib/demo";
import { isConnectionError } from "@/lib/errors/connection";
import { NotFoundError, LimitReachedError, isNotFoundLike } from "@/lib/repo/errors";

describe("parseRangeParam (the ?range= search parameter is user input)", () => {
  it("accepts exactly the two known ranges", () => {
    expect(parseRangeParam("24h")).toBe("24h");
    expect(parseRangeParam("7d")).toBe("7d");
  });
  it("falls back to 24h for anything else instead of failing or widening the window", () => {
    for (const bad of [undefined, "", " ", "24H", "7D", " 7d", "7d ", "30d", "90d", "1h", "all", "7", "24", "7d;24h", "../7d", "__proto__", "constructor", "null", "undefined", "0", "-1", "7d\n"]) {
      expect(parseRangeParam(bad), JSON.stringify(bad)).toBe(DEFAULT_RANGE);
    }
    expect(DEFAULT_RANGE).toBe("24h");
  });
  it("uses the first value of a repeated parameter, and falls back when that one is bad", () => {
    expect(parseRangeParam(["7d", "24h"])).toBe("7d");
    expect(parseRangeParam(["24h", "7d"])).toBe("24h");
    expect(parseRangeParam(["bogus", "7d"])).toBe("24h");
    expect(parseRangeParam([])).toBe("24h");
  });
  it("never returns anything but a known range, whatever it is given (fuzz)", () => {
    const seen = new Set<string>();
    let s = 12345;
    for (let i = 0; i < 2000; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const len = s % 9;
      let str = "";
      for (let k = 0; k < len; k++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        str += String.fromCharCode(32 + (s % 95));
      }
      seen.add(parseRangeParam(str));
    }
    expect([...seen].sort()).toEqual(["24h"]); // random text never happens to be a valid range
  });
});

describe("overviewState", () => {
  const nowMs = Date.UTC(2026, 10, 21, 12, 30);
  const base = { range: "24h" as const, nowMs, pricedModels: new Set<string>(), eventsToday: 0, eventsLimit: 1900 };
  const zeros = { errors: 0, inputTokens: 0, outputTokens: 0, costMicro: 0, latSumMs: 0, lat: new Array<number>(12).fill(0) };

  it("is empty when the window holds no events at all", () => {
    expect(overviewState(buildOverview({ ...base, rows: [] }))).toBe("empty");
  });
  it("is ready as soon as there is one event", () => {
    const o = buildOverview({ ...base, rows: [{ ...zeros, bucket: Math.floor(nowMs / 3_600_000) * 3_600_000, model: "", calls: 1 }] });
    expect(overviewState(o)).toBe("ready");
  });
  it("is ready for a window whose only events are on an unpriced model (cost unknown is not 'no data')", () => {
    const o = buildOverview({ ...base, rows: [{ ...zeros, bucket: Math.floor(nowMs / 3_600_000) * 3_600_000, model: "mystery", calls: 4 }] });
    expect(o.totals.costMicro).toBe(0);
    expect(overviewState(o)).toBe("ready");
  });
  it("only looks at the selected window: events outside it do not make it ready", () => {
    const old = { ...zeros, bucket: Date.UTC(2026, 10, 1), model: "m", calls: 50 };
    expect(overviewState(buildOverview({ ...base, rows: [old] }))).toBe("empty");
  });
  it("is ready for the demo in both ranges", () => {
    expect(overviewState(getDemoOverview("24h"))).toBe("ready");
    expect(overviewState(getDemoOverview("7d"))).toBe("ready");
  });
});

describe("isNotFoundLike: every 'no such project' is the same page; outages are not 'not found'", () => {
  it("treats the repo's NotFoundError (foreign, missing, deleted) and a malformed-id validation error as not found", () => {
    expect(isNotFoundLike(new NotFoundError())).toBe(true);
    const zodError = (() => {
      try {
        z.string().uuid().parse("not-a-uuid");
      } catch (e) {
        return e;
      }
    })();
    expect(zodError).toBeDefined();
    expect(isNotFoundLike(zodError)).toBe(true);
  });
  it("does NOT treat a database outage as not found, so it reaches the error boundary (retry, no details)", () => {
    const fetchFailed = new TypeError("fetch failed");
    expect(isConnectionError(fetchFailed)).toBe(true); // sanity: this really is the outage shape
    expect(isNotFoundLike(fetchFailed)).toBe(false);
    const neon = Object.assign(new Error("connection failed"), { name: "NeonDbError", sourceError: fetchFailed });
    expect(isConnectionError(neon)).toBe(true);
    expect(isNotFoundLike(neon)).toBe(false);
  });
  it("does not swallow other failures (SQL errors, bugs, other domain errors, non-errors)", () => {
    for (const e of [new Error("boom"), new RangeError("invalid metrics window"), new LimitReachedError("x"), Object.assign(new Error("denied"), { name: "NeonDbError", code: "42501" }), "string", null, undefined, 404]) {
      expect(isNotFoundLike(e), String(e)).toBe(false);
    }
  });
});
