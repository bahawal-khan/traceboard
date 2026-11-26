import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/repo/live.ts against a mocked driver: statement shape, bound parameters, cursor strictness, clamps (lookback, future, cap,
 * settle), mapping, the null-cost rules and the single not-found behaviour. Also keeps scripts/live-explain-sql.mjs in step with
 * the statement. The real database (RLS, IDOR, late events, pagination) is tests/db/live.test.ts, run by the owner.
 */
const m = vi.hoisted(() => ({
  results: [] as unknown[][],
  transactions: [] as Array<Array<{ sql: string; values: unknown[] }>>,
}));

vi.mock("@/lib/db/client", () => ({
  getSql: () => ({
    transaction: (build: (t: (s: TemplateStringsArray, ...v: unknown[]) => unknown) => unknown[]) => {
      const t = (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
      m.transactions.push(build(t) as Array<{ sql: string; values: unknown[] }>);
      return Promise.resolve([[{ set_config: "x" }], ...m.results]);
    },
  }),
}));

import { TS_WINDOW_MS } from "@/lib/ingest/normalize";
import { InvalidCursorError, NotFoundError } from "@/lib/repo/errors";
import { LIVE_LIMITS, LIVE_MAX_ID, decodeLiveCursor, encodeLiveCursor, getLiveSince, liveStatement } from "@/lib/repo/live";
import { issueCtx, type SessionCtx, type Tx } from "@/lib/repo/tenant";
import { encodeCursor, traceListItemSchema } from "@/lib/repo/traces";
import { encodeThreadCursor } from "@/lib/repo/threads";
import {
  LIVE_OCCURRED_SLACK_MS, LIVE_SCAN_CAP, LIVE_SETTLE_MS, LIVE_SQL, LIVE_TRACE_LIMIT, LIVE_TRACE_LOOKBACK_MS, liveParams,
} from "../scripts/live-explain-sql.mjs";
import { HEAVY_FUZZ_TIMEOUT_MS } from "./helpers/timeouts";

const HOUR = 3_600_000;
const PID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const ctx = issueCtx<SessionCtx>({ kind: "session", ownerId: "user_a", projectIds: [PID], readOnly: false });
const projectRow = [{ id: PID }];
const GOOD = { receivedAt: "2026-11-26T11:59:00.123456Z", id: "0a1b2c3d-0000-4000-8000-0123456789ab" };
const goodCursor = () => encodeLiveCursor(GOOD);

const head = (over: Record<string, unknown> = {}) => ({
  ev_count: "0", err_count: "0", trace_count: "0", truncated: false, next_ts: "2026-11-26T11:59:59.000000Z", next_id: LIVE_MAX_ID,
  trace_id: null, started_at_ms: null, duration_ms: null, spans: null, errors: null, tokens: null, cost_micro: null, unpriced: null, has_root: null, root_name: null,
  ...over,
});
const traceRow = (over: Record<string, unknown> = {}) =>
  head({
    ev_count: "4", err_count: "1", trace_count: "2", trace_id: "tr-1", started_at_ms: String(NOW - 5000), duration_ms: "1200", spans: "3", errors: "1",
    tokens: "321", cost_micro: "1500", unpriced: "0", has_root: true, root_name: "agent.run", ...over,
  });
const live = (rows: unknown[], cursor?: string, opts: Record<string, unknown> = {}) => {
  m.results = [projectRow, rows];
  return getLiveSince(ctx, PID, cursor, { nowMs: NOW, ...opts });
};
const stmt = () => m.transactions[0]![2]!;

beforeEach(() => {
  m.results = [];
  m.transactions = [];
});

describe("the statement", () => {
  it("is ONE static template: project, cursor, bounds and every limit are bound parameters, never part of the text", async () => {
    await live([head()], goodCursor());
    const { sql, values } = stmt();
    expect(m.transactions[0]).toHaveLength(3); // set_config, project check, live
    expect(values).toEqual([
      GOOD.receivedAt, PID,
      new Date(Date.parse("2026-11-26T11:59:00.123Z") - LIVE_LIMITS.occurredSlackMs).toISOString(),
      new Date(NOW + LIVE_LIMITS.occurredSlackMs).toISOString(),
      LIVE_LIMITS.settleMs, GOOD.receivedAt, GOOD.id, LIVE_LIMITS.maxEvents + 1,
      LIVE_LIMITS.maxEvents, LIVE_LIMITS.maxEvents,
      GOOD.receivedAt, GOOD.receivedAt, GOOD.receivedAt, GOOD.id, LIVE_LIMITS.settleMs,
      LIVE_LIMITS.recentTraces, PID,
      new Date(NOW - LIVE_LIMITS.traceLookbackMs).toISOString(), new Date(NOW + LIVE_LIMITS.occurredSlackMs).toISOString(),
    ]);
    for (const v of [PID, GOOD.id, "2026-11-26"]) expect(sql).not.toContain(v);
    expect(sql).not.toMatch(/limit (?!1\b)\d/); // the only literal is the one-row `limit 1` of the last-row lookup
  });

  it("is a strict keyset on (received_at, id), ascending, bounded on BOTH sides in time and by the horizon", async () => {
    await live([head()], goodCursor());
    const s = stmt().sql;
    expect(s).toMatch(/from events where \?::timestamptz is not null and project_id = \?::uuid and occurred_at >= \?::timestamptz and occurred_at < \?::timestamptz and received_at <= now\(\) - \?::int \* interval '1 millisecond' and \(received_at, id\) > \(\?::timestamptz, \?::uuid\) order by received_at, id limit \?::int/);
    expect(s).not.toMatch(/\(received_at, id\) >= /);
  });

  it("the cursor is NOT based on the event's own timestamp: occurred_at only bounds partitions, never orders or compares", () => {
    const s = LIVE_SQL.replace(/\s+/g, " ");
    expect(s).not.toMatch(/order by[^)]*occurred_at desc limit \$8/);
    expect(s).not.toMatch(/\(occurred_at, id\)/);
    expect(s).toContain("(received_at, id) > ($6::timestamptz, $7::uuid)");
  });

  it("selects only structural columns: no content, error text, tags or hashes, and never `select *`", async () => {
    await live([head()], goodCursor());
    const s = stmt().sql;
    const noLiterals = s.replace(/'[^']*'/g, "''");
    expect(noLiterals).not.toMatch(/event_content|input_text|output_text|prompt_hash|args_hash|user_id_hash|\btags\b|\berror\b|select \*|\bevents\.\*/);
    expect(/fresh as \( select (.+?) from events/.exec(s)![1]!.split(", ")).toEqual(["id", "received_at", "trace_id", "status"]);
    // The trace summaries read the same structural columns as the trace list and nothing else.
    const used = new Set([...s.matchAll(/\be\.(\w+)/g)].map((x) => x[1]));
    expect([...used].sort()).toEqual(["cost_usd", "input_tokens", "latency_ms", "model", "name", "occurred_at", "output_tokens", "parent_id", "project_id", "status", "trace_id"]);
  });

  it("the trace summary keeps the project predicate and a bounded time range (no cross-project read through a trace id)", async () => {
    await live([head()], goodCursor());
    expect(stmt().sql).toMatch(/from events e join recent r on r\.trace_id = e\.trace_id where e\.project_id = \?::uuid and e\.occurred_at >= \?::timestamptz and e\.occurred_at < \?::timestamptz group by e\.trace_id/);
  });

  it("the cost sum never coalesces to 0; unpriced counts only events that have a model (same rule as the trace list)", async () => {
    await live([head()], goodCursor());
    expect(stmt().sql).toContain("sum(e.cost_usd) as cost");
    expect(stmt().sql).toContain("count(*) filter (where e.cost_usd is null and e.model is not null and e.model <> '') as unpriced");
  });

  it("the cap is applied in SQL twice: scan limit cap+1 proves 'more', `kept` cuts at the cap", async () => {
    await live([head()], goodCursor());
    expect(stmt().sql).toContain("from fresh order by received_at, id limit ?::int");
    expect(stmt().sql).toContain("(select count(*) from fresh) > ?::int as truncated");
  });

  it("is a pure read: one statement, no write keyword", async () => {
    await live([head()], goodCursor());
    expect(stmt().sql).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create)\b/i);
  });
});

describe("baseline, reset and clamps", () => {
  it("no cursor: a baseline, and the statement is told there is nothing to read (null cursor, so the scan is a one-time filter)", async () => {
    const r = await live([head()]);
    expect(stmt().values[0]).toBeNull();
    expect(stmt().values.slice(5, 7)).toEqual([null, null]);
    expect(r).toMatchObject({ baseline: true, reset: false, truncated: false, newEvents: 0, newErrors: 0, newTraces: 0, traces: [] });
    expect(decodeLiveCursor(r.cursor)).toEqual({ receivedAt: "2026-11-26T11:59:59.000000Z", id: LIVE_MAX_ID });
  });

  it("a cursor older than the lookback is a RESET: same baseline, reset true, the cursor is not sent to the database", async () => {
    const old = encodeLiveCursor({ receivedAt: "2026-11-26T11:44:59.000000Z", id: GOOD.id }); // 15 min + 1 s old
    const r = await live([head()], old);
    expect(r).toMatchObject({ baseline: true, reset: true, newEvents: 0, traces: [] });
    expect(stmt().values[0]).toBeNull();
    expect(JSON.stringify(stmt().values)).not.toContain("11:44:59");
  });

  it("exactly at the lookback is still a normal call; one millisecond older is a reset", async () => {
    const at = (ms: number) => encodeLiveCursor({ receivedAt: new Date(ms).toISOString().replace("Z", "000Z"), id: GOOD.id });
    expect((await live([head()], at(NOW - LIVE_LIMITS.lookbackMs))).reset).toBe(false);
    m.transactions = [];
    expect((await live([head()], at(NOW - LIVE_LIMITS.lookbackMs - 1))).reset).toBe(true);
  });

  it("a cursor from the future (beyond the clock-skew tolerance) is forged: InvalidCursorError, no database call", async () => {
    const future = encodeLiveCursor({ receivedAt: new Date(NOW + LIVE_LIMITS.futureToleranceMs + 1000).toISOString().replace("Z", "000Z"), id: GOOD.id });
    await expect(live([head()], future)).rejects.toThrow(InvalidCursorError);
    expect(m.transactions).toHaveLength(0);
    const nearFuture = encodeLiveCursor({ receivedAt: new Date(NOW + 5000).toISOString().replace("Z", "000Z"), id: GOOD.id });
    await expect(live([head()], nearFuture)).resolves.toMatchObject({ reset: false });
  });

  it("the occurred_at bounds are the ingest window plus slack around the cursor and now", async () => {
    expect(LIVE_LIMITS.occurredSlackMs).toBe(TS_WINDOW_MS + HOUR);
    await live([head()], goodCursor());
    const [from, to] = [Date.parse(String(stmt().values[2])), Date.parse(String(stmt().values[3]))];
    expect(to - NOW).toBe(25 * HOUR);
    expect(Date.parse("2026-11-26T11:59:00.123Z") - from).toBe(25 * HOUR);
  });

  it("the row cap hook can only LOWER the cap: a bigger or junk value is ignored", async () => {
    const capOf = async (scanCap: number) => {
      m.transactions = [];
      await live([head()], goodCursor(), { scanCap });
      return [stmt().values[7], stmt().values[8], stmt().values[9]];
    };
    expect(await capOf(5)).toEqual([6, 5, 5]);
    expect(await capOf(10_000_000)).toEqual([LIVE_LIMITS.maxEvents + 1, LIVE_LIMITS.maxEvents, LIVE_LIMITS.maxEvents]);
    expect(await capOf(Number.NaN)).toEqual([LIVE_LIMITS.maxEvents + 1, LIVE_LIMITS.maxEvents, LIVE_LIMITS.maxEvents]);
    expect(await capOf(-3)).toEqual([2, 1, 1]);
  });

  it("the settle hook can only SHORTEN the lag, never below 0 and never above the constant", async () => {
    const lagOf = async (settleMs: number) => {
      m.transactions = [];
      await live([head()], goodCursor(), { settleMs });
      return [stmt().values[4], stmt().values[14]];
    };
    expect(await lagOf(0)).toEqual([0, 0]);
    expect(await lagOf(500)).toEqual([500, 500]);
    expect(await lagOf(60_000)).toEqual([LIVE_LIMITS.settleMs, LIVE_LIMITS.settleMs]);
    expect(await lagOf(-5)).toEqual([0, 0]);
    expect(await lagOf(Number.NaN)).toEqual([LIVE_LIMITS.settleMs, LIVE_LIMITS.settleMs]);
  });

  it("a non-finite clock is refused before any database call", async () => {
    await expect(getLiveSince(ctx, PID, goodCursor(), { nowMs: Number.NaN })).rejects.toThrow(RangeError);
    expect(m.transactions).toHaveLength(0);
  });

  it("limits are sane for the free plan: settle lag under 2 s, cap well above a day's quota share, few traces", () => {
    expect(LIVE_LIMITS.settleMs).toBeLessThanOrEqual(2_000);
    expect(LIVE_LIMITS.lookbackMs).toBe(15 * 60_000);
    expect(LIVE_LIMITS.maxEvents).toBeGreaterThanOrEqual(500);
    expect(LIVE_LIMITS.recentTraces).toBeLessThanOrEqual(10);
  });
});

describe("result shape", () => {
  it("counts, flags, cursor and trace summaries (the trace list item shape)", async () => {
    const r = await live(
      [traceRow(), traceRow({ trace_id: "tr-0", spans: "1", errors: "0", cost_micro: "0", has_root: false, root_name: null })],
      goodCursor(),
    );
    expect(r).toMatchObject({ baseline: false, reset: false, truncated: false, newEvents: 4, newErrors: 1, newTraces: 2 });
    expect(r.traces).toHaveLength(2);
    expect(r.traces[0]).toEqual({
      traceId: "tr-1", startedAtMs: NOW - 5000, durationMs: 1200, spanCount: 3, errorCount: 1, totalTokens: 321, costMicro: 1500,
      costLowerBound: false, unpricedEvents: 0, rootName: "agent.run", hasRoot: true,
    });
    for (const t of r.traces) expect(traceListItemSchema.safeParse(t).success).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["baseline", "cursor", "newErrors", "newEvents", "newTraces", "reset", "traces", "truncated"]);
  });

  it("the cursor of a truncated answer is whatever the statement says (the last row counted), and truncated is passed through", async () => {
    const r = await live([traceRow({ truncated: true, next_ts: "2026-11-26T11:59:30.000123Z", next_id: "0a1b2c3d-0000-4000-8000-0123456789ff" })], goodCursor());
    expect(r.truncated).toBe(true);
    expect(decodeLiveCursor(r.cursor)).toEqual({ receivedAt: "2026-11-26T11:59:30.000123Z", id: "0a1b2c3d-0000-4000-8000-0123456789ff" });
  });

  it("the empty path: zero counts, no traces, a cursor that moved to the horizon", async () => {
    const r = await live([head({ next_ts: "2026-11-26T11:59:59.000000Z" })], goodCursor());
    expect(r).toMatchObject({ newEvents: 0, newErrors: 0, newTraces: 0, traces: [], truncated: false, baseline: false });
    expect(decodeLiveCursor(r.cursor).receivedAt).toBe("2026-11-26T11:59:59.000000Z");
  });

  it("cost rules: unknown stays null, a lower bound is flagged, a tool-only trace is a real 0, never an invented 0", async () => {
    const r = await live(
      [
        traceRow({ trace_id: "unknown", cost_micro: null, unpriced: "2" }),
        traceRow({ trace_id: "partial", cost_micro: "1500", unpriced: "1" }),
        traceRow({ trace_id: "tools", cost_micro: null, unpriced: "0" }),
        traceRow({ trace_id: "free", cost_micro: "0", unpriced: "0" }),
      ],
      goodCursor(),
    );
    const by = new Map(r.traces.map((t) => [t.traceId, t]));
    expect(by.get("unknown")).toMatchObject({ costMicro: null, costLowerBound: true, unpricedEvents: 2 });
    expect(by.get("partial")).toMatchObject({ costMicro: 1500, costLowerBound: true, unpricedEvents: 1 });
    expect(by.get("tools")).toMatchObject({ costMicro: 0, costLowerBound: false });
    expect(by.get("free")).toMatchObject({ costMicro: 0, costLowerBound: false });
  });

  it("never returns more than the columns of the statement: a row that carries content columns does not leak them", async () => {
    const r = await live([traceRow({ input_text: "SECRET", error: "SECRET", prompt_hash: "SECRET", tags: ["SECRET"] })], goodCursor());
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("a statement that returns no row at all is an internal error, not a silent empty answer", async () => {
    await expect(live([], goodCursor())).rejects.toThrow(/no row/);
  });
});

describe("not found: ONE identical error for every 'cannot read' case", () => {
  const errOf = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return e as Error;
    }
    return null;
  };
  it("a project outside the context, a malformed id and a project the database does not show are the same NotFoundError", async () => {
    m.results = [projectRow, [head()]];
    const foreign = await errOf(() => getLiveSince(ctx, OTHER, undefined, { nowMs: NOW }));
    const malformed = await errOf(() => getLiveSince(ctx, "not-a-uuid", undefined, { nowMs: NOW }));
    expect(m.transactions).toHaveLength(0); // neither reached the database
    m.results = [[], [head()]];
    const missing = await errOf(() => getLiveSince(ctx, PID, undefined, { nowMs: NOW }));
    for (const e of [foreign, malformed, missing]) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect(e!.message).toBe("not found");
    }
    expect(foreign!.message).toBe(missing!.message);
  });
  it("a bad cursor on a foreign project is still NotFound (the cursor is not an oracle for project existence)", async () => {
    expect(await errOf(() => getLiveSince(ctx, OTHER, "garbage", { nowMs: NOW }))).toBeInstanceOf(NotFoundError);
    expect(m.transactions).toHaveLength(0);
  });
});

describe("cursor", () => {
  const enc = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const ok = { k: "lv", v: 1, s: GOOD.receivedAt, i: GOOD.id };
  it("round-trips, and is opaque (url-safe, no padding)", () => {
    const c = encodeLiveCursor(GOOD);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLiveCursor(c)).toEqual(GOOD);
  });
  it("accepts the maximum id (it has no uuid version or variant bits)", () => {
    expect(decodeLiveCursor(encodeLiveCursor({ ...GOOD, id: LIVE_MAX_ID })).id).toBe(LIVE_MAX_ID);
  });
  const bad: Array<[string, string]> = [
    ["empty", ""],
    ["not base64url", "not a cursor!"],
    ["padding", encodeLiveCursor(GOOD) + "=="],
    ["not json", enc("hello")],
    ["json null", enc("null")],
    ["json array", enc("[1,2]")],
    ["a TRACE cursor", encodeCursor({ start: GOOD.receivedAt, traceId: "tr-1" })],
    ["a THREAD cursor", encodeThreadCursor({ lastActive: GOOD.receivedAt, threadId: "th-1" })],
    ["missing kind", enc({ v: 1, s: GOOD.receivedAt, i: GOOD.id })],
    ["wrong kind", enc({ ...ok, k: "th" })],
    ["missing id", enc({ k: "lv", v: 1, s: GOOD.receivedAt })],
    ["missing time", enc({ k: "lv", v: 1, i: GOOD.id })],
    ["extra field", enc({ ...ok, u: 1 })],
    ["wrong version", enc({ ...ok, v: 2 })],
    ["time is a number", enc({ ...ok, s: 1_700_000_000_000 })],
    ["time without microseconds", enc({ ...ok, s: "2026-11-26T11:59:00.123Z" })],
    ["time with an offset", enc({ ...ok, s: "2026-11-26T11:59:00.123456+02:00" })],
    ["time that rolls over (Feb 31)", enc({ ...ok, s: "2026-02-31T11:59:00.123456Z" })],
    ["time with hour 25", enc({ ...ok, s: "2026-11-26T25:59:00.123456Z" })],
    ["time before 2000", enc({ ...ok, s: "1999-11-26T11:59:00.123456Z" })],
    ["time after 2100", enc({ ...ok, s: "2101-11-26T11:59:00.123456Z" })],
    ["sql in the time", enc({ ...ok, s: "2026-11-26'; drop table events;--" })],
    ["id is not a uuid", enc({ ...ok, i: "not-a-uuid" })],
    ["id with uppercase", enc({ ...ok, i: GOOD.id.toUpperCase() })],
    ["id with sql", enc({ ...ok, i: "0a1b2c3d-0000-4000-8000-0123456789ab'; --" })],
    ["id is a number", enc({ ...ok, i: 5 })],
    ["id too short", enc({ ...ok, i: GOOD.id.slice(0, -1) })],
    ["huge", "A".repeat(100_000)],
  ];
  it.each(bad)("rejects %s with InvalidCursorError, and no database call is made", async (_name, raw) => {
    expect(() => decodeLiveCursor(raw)).toThrow(InvalidCursorError);
    await expect(getLiveSince(ctx, PID, raw, { nowMs: NOW })).rejects.toThrow(InvalidCursorError);
    expect(m.transactions).toHaveLength(0);
  });
  it("the error says nothing about why", () => {
    for (const [, raw] of bad) {
      try {
        decodeLiveCursor(raw);
      } catch (e) {
        expect((e as Error).message).toBe("invalid cursor");
        expect((e as Error).name).toBe("InvalidCursorError");
      }
    }
  });
  it("an empty-string cursor is not 'no cursor': it is invalid (the route decides what an absent parameter means)", async () => {
    await expect(getLiveSince(ctx, PID, "", { nowMs: NOW })).rejects.toThrow(InvalidCursorError);
  });
  it(
    "fuzz: random strings and every single-character edit of a real cursor either decode to exactly what they say or throw InvalidCursorError",
    () => {
      const good = encodeLiveCursor(GOOD);
      const alphabet = "AZaz09-_=+/ \u0000{}\"'";
      let seed = 20261126;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const check = (raw: string) => {
        try {
          const c = decodeLiveCursor(raw);
          // anything accepted must be well formed AND re-encode to a cursor that decodes to the same thing
          expect(c.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
          expect(c.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
          expect(decodeLiveCursor(encodeLiveCursor(c))).toEqual(c);
        } catch (e) {
          expect(e).toBeInstanceOf(InvalidCursorError);
        }
      };
      for (let i = 0; i < good.length; i++) for (const ch of alphabet) check(good.slice(0, i) + ch + good.slice(i + 1));
      for (let i = 0; i < 3000; i++) check(Array.from({ length: 1 + Math.floor(rnd() * 90) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(""));
      for (let i = 0; i < good.length; i++) check(good.slice(0, i));
    },
    HEAVY_FUZZ_TIMEOUT_MS,
  );
});

describe("scripts/live-explain-sql.mjs stays in step with lib/repo/live.ts", () => {
  const recN = ((s: TemplateStringsArray, ...v: unknown[]) => ({ text: s.reduce((a, p, i) => a + p + (i < v.length ? `$${i + 1}` : ""), "").replace(/\s+/g, " ").trim(), values: v })) as unknown as Tx;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const isoIdx = new Set([2, 3, 17, 18]);
  const mask = (v: unknown[]) => v.map((x, i) => (isoIdx.has(i) ? "<iso>" : x));

  it("same statement text and the same parameters in the same order, with and without a cursor", () => {
    for (const cursor of [{ receivedAt: GOOD.receivedAt, id: GOOD.id, ms: Date.parse("2026-11-26T11:59:00.123Z") }, null]) {
      const real = liveStatement(recN, {
        pid: PID, cursorTs: cursor?.receivedAt ?? null, cursorId: cursor?.id ?? null, settleMs: LIVE_SETTLE_MS, fromIso: "F", toIso: "T",
        scanLimit: LIVE_SCAN_CAP + 1, cap: LIVE_SCAN_CAP, traceLimit: LIVE_TRACE_LIMIT, traceFromIso: "TF",
      }) as unknown as { text: string; values: unknown[] };
      expect(norm(LIVE_SQL)).toBe(real.text);
      const p = liveParams({ projectId: PID, nowMs: NOW, cursor });
      expect(p).toHaveLength(real.values.length);
      expect(mask(p)).toEqual(mask(real.values));
    }
  });
  it("the timestamp parameters are the ones the real reader computes", async () => {
    await live([head()], goodCursor());
    const p = liveParams({ projectId: PID, nowMs: NOW, cursor: { ...GOOD, ms: Date.parse("2026-11-26T11:59:00.123Z") } });
    expect(p).toEqual(stmt().values);
  });
  it("caps and windows equal the real ones", () => {
    expect(LIVE_SCAN_CAP).toBe(LIVE_LIMITS.maxEvents);
    expect(LIVE_SETTLE_MS).toBe(LIVE_LIMITS.settleMs);
    expect(LIVE_TRACE_LIMIT).toBe(LIVE_LIMITS.recentTraces);
    expect(LIVE_OCCURRED_SLACK_MS).toBe(LIVE_LIMITS.occurredSlackMs);
    expect(LIVE_TRACE_LOOKBACK_MS).toBe(LIVE_LIMITS.traceLookbackMs);
  });
  it("the scripts only read, and never print the environment or a connection string", () => {
    for (const f of ["scripts/explain-live.mjs", "scripts/live-explain-sql.mjs"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/\b(insert into|update\s+\w+\s+set|delete from|drop\s+(table|index)|truncate)\b/i);
      for (const l of s.split("\n").filter((x) => /console\.(log|error|warn|info|debug)/.test(x))) expect(l, `${f}: ${l}`).not.toMatch(/process\.env|_URL|\burl\b|password|connection string/i);
      expect(s, f).not.toMatch(/readFileSync|loadEnvFile|process\.env\)/);
    }
  });
});
