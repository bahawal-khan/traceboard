import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/repo/threads.ts against a mocked driver: statement shape, bound parameters, clamping, cursor strictness, mapping and the
 * not-found behaviour. The real database (RLS, aggregation, IDOR, pagination) is tests/db/threads.test.ts, run by the owner.
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

import { InvalidCursorError, NotFoundError } from "@/lib/repo/errors";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";
import { encodeCursor } from "@/lib/repo/traces";
import { THREAD_LIMITS, decodeThreadCursor, encodeThreadCursor, listThreads, listThreadsTolerant, threadListItemSchema } from "@/lib/repo/threads";

const HOUR = 3_600_000;
const PID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 10, 21, 12, 30, 0);
const ctx = issueCtx<SessionCtx>({ kind: "session", ownerId: "user_a", projectIds: [PID], readOnly: false });
const projectRow = [{ id: PID }];
const range = { fromMs: NOW - 24 * HOUR, toMs: NOW };

const row = (over: Record<string, unknown> = {}) => ({
  scanned: 10, truncated: false, thread_id: "th-1", started_at_ms: String(NOW - 60_000), last_active_ms: String(NOW - 1000),
  last_text: "2026-11-21T12:29:59.123456Z", traces: "3", spans: "9", errors: "1", tokens: "321", cost_micro: "1500", unpriced: "0",
  ...over,
});
const emptyPage = { scanned: 0, truncated: false, thread_id: null, started_at_ms: null, last_active_ms: null, last_text: null, traces: null, spans: null, errors: null, tokens: null, cost_micro: null, unpriced: null };
const list = (rows: unknown[], opts: Record<string, unknown> = {}) => {
  m.results = [projectRow, rows];
  return listThreads(ctx, PID, { range, nowMs: NOW, ...opts });
};
const stmt = () => m.transactions[0]![2]!;

beforeEach(() => {
  m.results = [];
  m.transactions = [];
});

describe("the statement", () => {
  it("is ONE static template: project, window and every limit are bound parameters, never part of the text", async () => {
    await list([emptyPage], { cursor: encodeThreadCursor({ lastActive: "2026-11-21T12:00:00.000001Z", threadId: "th-9" }), limit: 20 });
    const { sql, values } = stmt();
    expect(m.transactions[0]).toHaveLength(3); // set_config, project check, list
    expect(values).toEqual([
      PID,
      new Date(Date.UTC(2026, 10, 20, 12)).toISOString(),
      new Date(Date.UTC(2026, 10, 21, 13)).toISOString(),
      THREAD_LIMITS.maxScanRows + 1,
      THREAD_LIMITS.maxScanRows,
      "2026-11-21T12:00:00.000001Z", "2026-11-21T12:00:00.000001Z", "th-9",
      21,
      THREAD_LIMITS.maxScanRows,
    ]);
    for (const v of [PID, "th-9", "2026-11-21"]) expect(sql).not.toContain(v);
    expect(sql).not.toMatch(/limit \d/);
  });

  it("filters by project, BOTH time bounds and a non-null thread id before anything else", async () => {
    await list([emptyPage]);
    expect(stmt().sql).toMatch(/from events where project_id = \?::uuid and occurred_at >= \?::timestamptz and occurred_at < \?::timestamptz and thread_id is not null order by occurred_at desc limit \?::int/);
  });

  it("reads only structural columns: no content, error text, tags or hashes", async () => {
    await list([emptyPage]);
    const scan = /with scan as \( select (.+?) from events/.exec(stmt().sql)![1]!;
    expect(scan.split(", ")).toEqual(["thread_id", "trace_id", "status", "model", "input_tokens", "output_tokens", "cost_usd", "occurred_at"]);
    expect(stmt().sql).not.toMatch(/event_content|input_text|output_text|prompt_hash|args_hash|user_id_hash|\btags\b|select \* from events/);
    expect(stmt().sql).not.toMatch(/\bjoin\b.*\bevent_content\b/);
  });

  it("orders by last activity then thread id, descending, in the keyset comparison and in the page", async () => {
    await list([emptyPage]);
    expect(stmt().sql).toContain("(last_at, thread_id) < (?::timestamptz, ?::text)");
    expect(stmt().sql).toContain("order by last_at desc, thread_id desc limit ?::int");
  });

  it("the cost sum never coalesces to 0; unpriced counts only events that have a model", async () => {
    await list([emptyPage]);
    expect(stmt().sql).toContain("sum(cost_usd) as cost");
    expect(stmt().sql).toContain("count(*) filter (where cost_usd is null and model is not null and model <> '') as unpriced");
  });

  it("the scan cap sits above the real worst case (quota x retention) and is applied in SQL", async () => {
    expect(THREAD_LIMITS.maxScanRows).toBeGreaterThan(1_900 * 14);
    expect(THREAD_LIMITS.maxScanRows).toBeLessThan(60_000);
    await list([emptyPage]);
    expect(stmt().sql).toContain("where b.scanned <= ?::int or s.occurred_at > b.oldest");
  });
});

describe("window and page size", () => {
  it("clamps a 90-day request to 14 days and never reads beyond the current hour", async () => {
    const r = await list([emptyPage], { range: { fromMs: 0, toMs: NOW + 365 * 24 * HOUR } });
    expect(r.window.toMs).toBe(Date.UTC(2026, 10, 21, 13));
    expect(r.window.toMs - r.window.fromMs).toBe(14 * 24 * HOUR);
    expect(r.window.clamped).toBe(true);
  });
  it("an inverted range is an empty window, not an error and not a wide read", async () => {
    const r = await list([emptyPage], { range: { fromMs: NOW, toMs: NOW - 10 * HOUR } });
    expect(r.window.toMs - r.window.fromMs).toBe(0);
  });
  it("a non-finite range is refused before any database call", async () => {
    await expect(listThreads(ctx, PID, { range: { fromMs: Number.NaN, toMs: NOW }, nowMs: NOW })).rejects.toThrow(RangeError);
    expect(m.transactions).toHaveLength(0);
  });
  it("page size: default 50, at most 100, at least 1; junk falls back to the default (one extra row is fetched)", async () => {
    const fetched = async (limit?: number) => {
      m.transactions = [];
      await list([emptyPage], { limit });
      return stmt().values.at(-2);
    };
    expect(await fetched(undefined)).toBe(51);
    expect(await fetched(100)).toBe(101);
    expect(await fetched(10_000)).toBe(101);
    expect(await fetched(0)).toBe(2);
    expect(await fetched(-5)).toBe(2);
    expect(await fetched(7.9)).toBe(8);
    expect(await fetched(Number.NaN)).toBe(51);
    expect(await fetched(Number.POSITIVE_INFINITY)).toBe(51);
  });
  it("the scan cap hook can only LOWER the cap: a bigger or junk value is ignored", async () => {
    const capOf = async (scanCap: number) => {
      m.transactions = [];
      await list([emptyPage], { scanCap });
      return [stmt().values[3], stmt().values[4]];
    };
    expect(await capOf(5)).toEqual([6, 5]);
    expect(await capOf(10_000_000)).toEqual([THREAD_LIMITS.maxScanRows + 1, THREAD_LIMITS.maxScanRows]);
    expect(await capOf(Number.NaN)).toEqual([2, 1]);
    expect(await capOf(-3)).toEqual([2, 1]);
  });
});

describe("cursor", () => {
  const good = { lastActive: "2026-11-21T12:29:59.123456Z", threadId: "th-1" };
  const enc = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const ok = { k: "th", v: 1, s: good.lastActive, t: "x" };
  it("round-trips, and is opaque (url-safe, no padding)", () => {
    const c = encodeThreadCursor(good);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeThreadCursor(c)).toEqual(good);
  });
  it("round-trips odd but valid thread ids (unicode, quotes, spaces)", () => {
    for (const threadId of ["сессия-1", "a'b\"c", "with space", "x".repeat(128), "💬"]) {
      expect(decodeThreadCursor(encodeThreadCursor({ ...good, threadId }))).toEqual({ ...good, threadId });
    }
  });
  const bad: Array<[string, string]> = [
    ["empty", ""],
    ["not base64url", "not a cursor!"],
    ["padding", encodeThreadCursor(good) + "=="],
    ["not json", enc("hello")],
    ["json null", enc("null")],
    ["json array", enc("[1,2]")],
    ["a TRACE cursor", encodeCursor({ start: good.lastActive, traceId: "tr-1" })],
    ["missing kind", enc({ v: 1, s: good.lastActive, t: "x" })],
    ["wrong kind", enc({ ...ok, k: "tr" })],
    ["missing field", enc({ k: "th", v: 1, s: good.lastActive })],
    ["extra field", enc({ ...ok, u: 1 })],
    ["wrong version", enc({ ...ok, v: 2 })],
    ["time is a number", enc({ ...ok, s: 1_700_000_000_000 })],
    ["time without microseconds", enc({ ...ok, s: "2026-11-21T12:29:59.123Z" })],
    ["time with an offset", enc({ ...ok, s: "2026-11-21T12:29:59.123456+02:00" })],
    ["time that rolls over (Feb 31)", enc({ ...ok, s: "2026-02-31T12:29:59.123456Z" })],
    ["time with hour 25", enc({ ...ok, s: "2026-11-21T25:29:59.123456Z" })],
    ["time before 2000", enc({ ...ok, s: "1999-11-21T12:29:59.123456Z" })],
    ["time after 2100", enc({ ...ok, s: "2101-11-21T12:29:59.123456Z" })],
    ["sql in the time", enc({ ...ok, s: "2026-11-21'; drop table events;--" })],
    ["empty thread id", enc({ ...ok, t: "" })],
    ["thread id over 128", enc({ ...ok, t: "x".repeat(129) })],
    ["thread id with a NUL", enc({ ...ok, t: "a\u0000b" })],
    ["thread id with a newline", enc({ ...ok, t: "a\nb" })],
    ["thread id is a number", enc({ ...ok, t: 5 })],
    ["huge", "A".repeat(100_000)],
  ];
  it.each(bad)("rejects %s with InvalidCursorError, and no database call is made", async (_name, raw) => {
    expect(() => decodeThreadCursor(raw)).toThrow(InvalidCursorError);
    await expect(listThreads(ctx, PID, { range, cursor: raw, nowMs: NOW })).rejects.toThrow(InvalidCursorError);
    expect(m.transactions).toHaveLength(0);
  });
  it("the error says nothing about why", () => {
    for (const [, raw] of bad) {
      try {
        decodeThreadCursor(raw);
      } catch (e) {
        expect((e as Error).message).toBe("invalid cursor");
        expect((e as Error).name).toBe("InvalidCursorError");
      }
    }
  });
  it("fuzz: random strings and random JSON never throw anything but InvalidCursorError", () => {
    let seed = 20261124;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const alphabet = 'abcXYZ019_-=+/{}[]":,\\ \n\u0000é';
    for (let i = 0; i < 600; i++) {
      const len = Math.floor(rnd() * 80);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      for (const raw of [s, Buffer.from(s).toString("base64url"), Buffer.from(JSON.stringify({ k: "th", v: 1, s, t: s })).toString("base64url")]) {
        try {
          decodeThreadCursor(raw);
        } catch (e) {
          expect(e).toBeInstanceOf(InvalidCursorError);
        }
      }
    }
  });
  it("a hostile but well-formed thread id is bound as a value, never put into the statement", async () => {
    const evil = "x'; drop table events; --";
    await list([emptyPage], { cursor: encodeThreadCursor({ ...good, threadId: evil }) });
    expect(stmt().values).toContain(evil);
    expect(stmt().sql).not.toContain("drop table");
  });
});

describe("mapping", () => {
  it("maps driver strings to numbers", async () => {
    const r = await list([row()]);
    expect(r.items[0]).toEqual({
      threadId: "th-1", startedAtMs: NOW - 60_000, lastActiveAtMs: NOW - 1000, traceCount: 3, spanCount: 9, errorCount: 1,
      totalTokens: 321, costMicro: 1500, costLowerBound: false, unpricedEvents: 0,
    });
    expect(threadListItemSchema.safeParse(r.items[0]).success).toBe(true);
  });
  it("cost: unknown stays null (never 0); a thread that needed no price is a genuine 0; a partial sum is a lower bound", async () => {
    const r = await list([
      row({ thread_id: "unknown", cost_micro: null, unpriced: "2" }),
      row({ thread_id: "tools-only", cost_micro: null, unpriced: "0" }),
      row({ thread_id: "partial", cost_micro: "700", unpriced: "1" }),
      row({ thread_id: "free", cost_micro: "0", unpriced: "0" }),
    ]);
    const by = new Map(r.items.map((i) => [i.threadId, i]));
    expect(by.get("unknown")).toMatchObject({ costMicro: null, costLowerBound: true, unpricedEvents: 2 });
    expect(by.get("tools-only")).toMatchObject({ costMicro: 0, costLowerBound: false });
    expect(by.get("partial")).toMatchObject({ costMicro: 700, costLowerBound: true });
    expect(by.get("free")).toMatchObject({ costMicro: 0, costLowerBound: false });
  });
  it("a thread whose events have no trace id has traceCount 0 but is still listed", async () => {
    const r = await list([row({ traces: "0", spans: "2" })]);
    expect(r.items[0]).toMatchObject({ traceCount: 0, spanCount: 2 });
  });
  it("an empty page still reports truncated (the one-row left join)", async () => {
    const r = await list([{ ...emptyPage, scanned: 5000, truncated: true }]);
    expect(r.items).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toBeNull();
  });
  it("a surprise from the driver fails loudly instead of drawing a wrong row", async () => {
    await expect(list([row({ spans: "0" })])).rejects.toThrow();
    await expect(list([row({ errors: "-1" })])).rejects.toThrow();
    await expect(list([row({ thread_id: "x".repeat(200) })])).rejects.toThrow();
  });
});

describe("pagination result", () => {
  it("limit + 1 rows: the extra row is dropped and the cursor points at the LAST row returned", async () => {
    const r = await list([row({ thread_id: "a" }), row({ thread_id: "b", last_text: "2026-11-21T12:00:00.000009Z" }), row({ thread_id: "c" })], { limit: 2 });
    expect(r.items.map((i) => i.threadId)).toEqual(["a", "b"]);
    expect(decodeThreadCursor(r.nextCursor!)).toEqual({ lastActive: "2026-11-21T12:00:00.000009Z", threadId: "b" });
  });
  it("exactly `limit` rows is the last page: no cursor", async () => {
    const r = await list([row({ thread_id: "a" }), row({ thread_id: "b" })], { limit: 2 });
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).toBeNull();
  });
  it("preserves the database order (no re-sorting in JavaScript)", async () => {
    const r = await list([row({ thread_id: "b" }), row({ thread_id: "B" }), row({ thread_id: "a" })]);
    expect(r.items.map((i) => i.threadId)).toEqual(["b", "B", "a"]);
  });
});

describe("not found", () => {
  const same = (e: unknown) => {
    expect(e).toBeInstanceOf(NotFoundError);
    expect((e as Error).message).toBe("not found");
  };
  it("a project outside the context or a malformed id: NotFoundError and NO database call", async () => {
    for (const id of [OTHER, "not-a-uuid", "", "11111111-1111-4111-8111-11111111111", PID + " "]) {
      await listThreads(ctx, id, { range, nowMs: NOW }).then(() => expect.fail("should throw"), same);
    }
    expect(m.transactions).toHaveLength(0);
  });
  it("a project that is in the context but not (or no longer) the owner's row: the same NotFoundError", async () => {
    m.results = [[], [emptyPage]];
    await listThreads(ctx, PID, { range, nowMs: NOW }).then(() => expect.fail("should throw"), same);
  });
  it("checks the project row with the owner filter in the same transaction", async () => {
    await list([emptyPage]);
    expect(m.transactions[0]![1]!.sql).toBe("select id from projects where id = ?::uuid and owner_id = ?");
    expect(m.transactions[0]![1]!.values).toEqual([PID, "user_a"]);
  });
});

describe("listThreadsTolerant (a cursor straight from a URL)", () => {
  const good = encodeThreadCursor({ lastActive: "2026-11-21T12:29:59.123456Z", threadId: "th-1" });
  it("a valid cursor is used", async () => {
    m.results = [projectRow, [emptyPage]];
    const r = await listThreadsTolerant(ctx, PID, { range, nowMs: NOW, cursor: good });
    expect(r.usedCursor).toBe(true);
    expect(m.transactions).toHaveLength(1);
    expect(m.transactions[0]![2]!.values).toContain("th-1");
  });
  it("no cursor: first page, usedCursor false", async () => {
    m.results = [projectRow, [emptyPage]];
    expect((await listThreadsTolerant(ctx, PID, { range, nowMs: NOW })).usedCursor).toBe(false);
  });
  it("a forged or foreign-kind cursor gives the FIRST page with ONE database call and no error", async () => {
    m.results = [projectRow, [row()]];
    const traceCursor = encodeCursor({ start: "2026-11-21T12:29:59.123456Z", traceId: "tr-1" });
    for (const bad of ["garbage", "", "A".repeat(600), Buffer.from("{}").toString("base64url"), traceCursor]) {
      m.transactions = [];
      const r = await listThreadsTolerant(ctx, PID, { range, nowMs: NOW, cursor: bad });
      expect(r.usedCursor).toBe(false);
      expect(r.result.items).toHaveLength(1);
      expect(m.transactions).toHaveLength(1);
      expect(m.transactions[0]![2]!.values.slice(5, 8)).toEqual([null, null, null]);
    }
  });
  it("every other failure propagates: not found, a bad project id", async () => {
    m.results = [[], [emptyPage]];
    await expect(listThreadsTolerant(ctx, PID, { range, nowMs: NOW, cursor: good })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listThreadsTolerant(ctx, "nope", { range, nowMs: NOW, cursor: "garbage" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
