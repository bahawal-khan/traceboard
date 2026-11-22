import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/repo/traces.ts against a mocked driver: statement shape, bound parameters, clamping, cursor strictness, mapping and the
 * not-found behaviour. The real database (RLS, aggregation, IDOR, pagination) is tests/db/traces.test.ts, run by the owner.
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
import { TRACE_LIMITS, decodeCursor, encodeCursor, listTraces, listTracesTolerant } from "@/lib/repo/traces";

const HOUR = 3_600_000;
const PID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 10, 21, 12, 30, 0);
const ctx = issueCtx<SessionCtx>({ kind: "session", ownerId: "user_a", projectIds: [PID], readOnly: false });
const projectRow = [{ id: PID }];
const range = { fromMs: NOW - 24 * HOUR, toMs: NOW };

const row = (over: Record<string, unknown> = {}) => ({
  scanned: 10, truncated: false, trace_id: "tr-1", started_at_ms: String(NOW - 1000), start_text: "2026-11-21T12:29:59.123456Z",
  duration_ms: "850", spans: "4", errors: "1", tokens: "321", cost_micro: "1500", unpriced: "0", has_root: true, root_name: "agent.run",
  ...over,
});
const emptyPage = { scanned: 0, truncated: false, trace_id: null, started_at_ms: null, start_text: null, duration_ms: null, spans: null, errors: null, tokens: null, cost_micro: null, unpriced: null, has_root: null, root_name: null };
const list = (rows: unknown[], opts: Record<string, unknown> = {}) => {
  m.results = [projectRow, rows];
  return listTraces(ctx, PID, { range, nowMs: NOW, ...opts });
};
const stmt = () => m.transactions[0]![2]!;

beforeEach(() => {
  m.results = [];
  m.transactions = [];
});

describe("the statement", () => {
  it("is ONE static template: project, window and every limit are bound parameters, never part of the text", async () => {
    await list([emptyPage], { status: "error", cursor: encodeCursor({ start: "2026-11-21T12:00:00.000001Z", traceId: "tr-9" }), limit: 20 });
    const { sql, values } = stmt();
    expect(m.transactions[0]).toHaveLength(3); // set_config, project check, list
    expect(values).toEqual([
      PID,
      new Date(Date.UTC(2026, 10, 20, 12)).toISOString(), // from: 24 h before, aligned to the hour
      new Date(Date.UTC(2026, 10, 21, 13)).toISOString(), // to: end of the current hour
      TRACE_LIMITS.maxScanRows + 1,
      TRACE_LIMITS.maxScanRows,
      "2026-11-21T12:00:00.000001Z", "2026-11-21T12:00:00.000001Z", "tr-9",
      "error", "error",
      21,
      TRACE_LIMITS.maxScanRows,
    ]);
    for (const v of [PID, "tr-9", "2026-11-21"]) expect(sql).not.toContain(v);
    expect(sql).not.toMatch(/limit \d/); // every limit is a parameter
  });

  it("filters by project and BOTH time bounds before anything else (partition pruning + project index)", async () => {
    await list([emptyPage]);
    expect(stmt().sql).toMatch(/from events where project_id = \?::uuid and occurred_at >= \?::timestamptz and occurred_at < \?::timestamptz and trace_id is not null order by occurred_at desc limit \?::int/);
  });

  it("reads only structural columns: no content, error text, tags or hashes", async () => {
    await list([emptyPage]);
    const scan = /with scan as \( select (.+?) from events/.exec(stmt().sql)![1]!;
    expect(scan.split(", ")).toEqual(["trace_id", "parent_id", "name", "status", "model", "input_tokens", "output_tokens", "latency_ms", "cost_usd", "occurred_at"]);
    expect(stmt().sql).not.toMatch(/event_content|input_text|output_text|prompt_hash|args_hash|user_id_hash|\btags\b|\bevent_id\b|select \* from events/);
    expect(stmt().sql).not.toMatch(/\bjoin\b.*\bevent_content\b/);
  });

  it("orders newest first with the trace id as tie-breaker, in the keyset comparison and in the page", async () => {
    await list([emptyPage]);
    expect(stmt().sql).toContain("(start_at, trace_id) < (?::timestamptz, ?::text)");
    expect(stmt().sql).toContain("order by start_at desc, trace_id desc limit ?::int");
  });

  it("the scan cap sits above the real worst case (quota x retention) and is applied in SQL", async () => {
    expect(TRACE_LIMITS.maxScanRows).toBeGreaterThan(1_900 * 14);
    expect(TRACE_LIMITS.maxScanRows).toBeLessThan(60_000);
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
    expect(stmt().values[2]).toBe(new Date(Date.UTC(2026, 10, 21, 13)).toISOString());
  });
  it("an inverted range is an empty window, not an error and not a wide read", async () => {
    const r = await list([emptyPage], { range: { fromMs: NOW, toMs: NOW - 10 * HOUR } });
    expect(r.window.toMs - r.window.fromMs).toBe(0);
  });
  it("a non-finite range is refused before any database call", async () => {
    await expect(listTraces(ctx, PID, { range: { fromMs: Number.NaN, toMs: NOW }, nowMs: NOW })).rejects.toThrow(RangeError);
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
});

describe("scan cap hook", () => {
  it("can only LOWER the cap: a bigger or junk value is ignored", async () => {
    const capOf = async (scanCap: number) => {
      m.transactions = [];
      await list([emptyPage], { scanCap });
      return [stmt().values[3], stmt().values[4]];
    };
    expect(await capOf(5)).toEqual([6, 5]);
    expect(await capOf(10_000_000)).toEqual([TRACE_LIMITS.maxScanRows + 1, TRACE_LIMITS.maxScanRows]);
    expect(await capOf(Number.NaN)).toEqual([2, 1]);
    expect(await capOf(-3)).toEqual([2, 1]);
  });
});

describe("cursor", () => {
  const good = { start: "2026-11-21T12:29:59.123456Z", traceId: "tr-1" };
  it("round-trips, and is opaque (url-safe, no padding)", () => {
    const c = encodeCursor(good);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c)).toEqual(good);
  });
  const enc = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const bad: Array<[string, string]> = [
    ["empty", ""],
    ["not base64url", "not a cursor!"],
    ["padding", encodeCursor(good) + "=="],
    ["not json", enc("hello")],
    ["json null", enc("null")],
    ["json array", enc("[1,2]")],
    ["missing field", enc({ v: 1, s: good.start })],
    ["extra field", enc({ v: 1, s: good.start, t: "x", u: 1 })],
    ["wrong version", enc({ v: 2, s: good.start, t: "x" })],
    ["start is a number", enc({ v: 1, s: 1_700_000_000_000, t: "x" })],
    ["start without microseconds", enc({ v: 1, s: "2026-11-21T12:29:59.123Z", t: "x" })],
    ["start with an offset", enc({ v: 1, s: "2026-11-21T12:29:59.123456+02:00", t: "x" })],
    ["start that rolls over (Feb 31)", enc({ v: 1, s: "2026-02-31T12:29:59.123456Z", t: "x" })],
    ["start with hour 25", enc({ v: 1, s: "2026-11-21T25:29:59.123456Z", t: "x" })],
    ["start before 2000", enc({ v: 1, s: "1999-11-21T12:29:59.123456Z", t: "x" })],
    ["start after 2100", enc({ v: 1, s: "2101-11-21T12:29:59.123456Z", t: "x" })],
    ["sql in the start", enc({ v: 1, s: "2026-11-21'; drop table events;--", t: "x" })],
    ["empty trace id", enc({ v: 1, s: good.start, t: "" })],
    ["trace id over 128", enc({ v: 1, s: good.start, t: "x".repeat(129) })],
    ["trace id with a NUL", enc({ v: 1, s: good.start, t: "a\u0000b" })],
    ["trace id with a newline", enc({ v: 1, s: good.start, t: "a\nb" })],
    ["huge", "A".repeat(100_000)],
  ];
  it.each(bad)("rejects %s with InvalidCursorError, and no database call is made", async (_name, raw) => {
    expect(() => decodeCursor(raw)).toThrow(InvalidCursorError);
    await expect(listTraces(ctx, PID, { range, cursor: raw, nowMs: NOW })).rejects.toThrow(InvalidCursorError);
    expect(m.transactions).toHaveLength(0);
  });
  it("the error says nothing about why (no parse details, no database text)", () => {
    for (const [, raw] of bad) {
      try {
        decodeCursor(raw);
      } catch (e) {
        expect((e as Error).message).toBe("invalid cursor");
        expect((e as Error).name).toBe("InvalidCursorError");
      }
    }
  });
  it("a hostile but well-formed trace id is bound as a value, never put into the statement", async () => {
    const evil = "x'; drop table events; --";
    await list([emptyPage], { cursor: encodeCursor({ start: good.start, traceId: evil }) });
    expect(stmt().values).toContain(evil);
    expect(stmt().sql).not.toContain("drop table");
  });
});

describe("mapping", () => {
  it("maps driver strings to numbers", async () => {
    const r = await list([row()]);
    expect(r.items).toEqual([
      { traceId: "tr-1", startedAtMs: NOW - 1000, durationMs: 850, spanCount: 4, errorCount: 1, totalTokens: 321, costMicro: 1500, costLowerBound: false, unpricedEvents: 0, rootName: "agent.run", hasRoot: true },
    ]);
    expect(r.truncated).toBe(false);
    expect(r.nextCursor).toBeNull();
  });
  it("cost: unknown stays null (never 0); a trace that needed no price is a genuine 0; a partial sum is a lower bound", async () => {
    const r = await list([
      row({ trace_id: "a", cost_micro: null, unpriced: "2" }), // everything priced-looking is unpriced
      row({ trace_id: "b", cost_micro: null, unpriced: "0" }), // tool-only trace: nothing to price
      row({ trace_id: "c", cost_micro: "700", unpriced: "1" }), // some priced, some not
      row({ trace_id: "d", cost_micro: "0", unpriced: "0" }), // a free model
    ]);
    expect(r.items.map((i) => [i.traceId, i.costMicro, i.costLowerBound, i.unpricedEvents])).toEqual([
      ["a", null, true, 2],
      ["b", 0, false, 0],
      ["c", 700, true, 1],
      ["d", 0, false, 0],
    ]);
  });
  it("an orphan trace (no root) is listed, with no root name", async () => {
    const r = await list([row({ has_root: false, root_name: null })]);
    expect(r.items[0]).toMatchObject({ hasRoot: false, rootName: null });
  });
  it("a root without a name has hasRoot true and rootName null", async () => {
    expect((await list([row({ root_name: null })])).items[0]).toMatchObject({ hasRoot: true, rootName: null });
  });
  it("an empty page still reports truncated (the one-row left join)", async () => {
    const r = await list([{ ...emptyPage, scanned: 30_601, truncated: true }]);
    expect(r.items).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toBeNull();
  });
  it("a surprise from the driver fails loudly instead of drawing a wrong row", async () => {
    await expect(list([row({ spans: "0" })])).rejects.toThrow();
    await expect(list([row({ duration_ms: "-3" })])).rejects.toThrow();
    await expect(list([row({ errors: "abc" })])).rejects.toThrow();
  });
});

describe("pagination result", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => row({ trace_id: `tr-${i}`, start_text: `2026-11-21T12:00:${String(59 - i).padStart(2, "0")}.000001Z` }));
  it("limit + 1 rows: the extra row is dropped and the cursor points at the LAST row returned", async () => {
    const r = await list(rows(4), { limit: 3 });
    expect(r.items.map((i) => i.traceId)).toEqual(["tr-0", "tr-1", "tr-2"]);
    expect(decodeCursor(r.nextCursor!)).toEqual({ start: "2026-11-21T12:00:57.000001Z", traceId: "tr-2" });
  });
  it("exactly `limit` rows is the last page: no cursor", async () => {
    const r = await list(rows(3), { limit: 3 });
    expect(r.items).toHaveLength(3);
    expect(r.nextCursor).toBeNull();
  });
  it("preserves the database order (no re-sorting in JavaScript with a different collation)", async () => {
    const r = await list([row({ trace_id: "b" }), row({ trace_id: "B" }), row({ trace_id: "a" })]);
    expect(r.items.map((i) => i.traceId)).toEqual(["b", "B", "a"]);
  });
});

describe("not found", () => {
  const same = (e: unknown) => {
    expect(e).toBeInstanceOf(NotFoundError);
    expect((e as Error).message).toBe("not found");
  };
  it("a project outside the context, a malformed id: NotFoundError and NO database call", async () => {
    for (const id of [OTHER, "not-a-uuid", "", "11111111-1111-4111-8111-11111111111", PID + " "]) {
      await listTraces(ctx, id, { range, nowMs: NOW }).then(() => expect.fail("should throw"), same);
    }
    expect(m.transactions).toHaveLength(0);
  });
  it("a project that is in the context but not (or no longer) the owner's row: the same NotFoundError", async () => {
    m.results = [[], [emptyPage]];
    await listTraces(ctx, PID, { range, nowMs: NOW }).then(() => expect.fail("should throw"), same);
  });
  it("checks the project row with the owner filter in the same transaction", async () => {
    await list([emptyPage]);
    expect(m.transactions[0]![1]!.sql).toBe("select id from projects where id = ?::uuid and owner_id = ?");
    expect(m.transactions[0]![1]!.values).toEqual([PID, "user_a"]);
  });
  it("a bad status filter is refused before any database call", async () => {
    await expect(listTraces(ctx, PID, { range, status: "weird" as never, nowMs: NOW })).rejects.toThrow();
    expect(m.transactions).toHaveLength(0);
  });
});

describe("listTracesTolerant (a cursor straight from a URL)", () => {
  const good = encodeCursor({ start: "2026-11-21T12:29:59.123456Z", traceId: "tr-1" });
  it("a valid cursor is used", async () => {
    m.results = [projectRow, [emptyPage]];
    const r = await listTracesTolerant(ctx, PID, { range, nowMs: NOW, cursor: good });
    expect(r.usedCursor).toBe(true);
    expect(m.transactions).toHaveLength(1);
    expect(m.transactions[0]![2]!.values).toContain("tr-1");
  });
  it("no cursor: first page, usedCursor false", async () => {
    m.results = [projectRow, [emptyPage]];
    expect((await listTracesTolerant(ctx, PID, { range, nowMs: NOW })).usedCursor).toBe(false);
  });
  it("a forged cursor gives the FIRST page (no cursor parameter), with ONE database call and no error", async () => {
    m.results = [projectRow, [row()]];
    for (const bad of ["garbage", "", "A".repeat(600), Buffer.from("{}").toString("base64url")]) {
      m.transactions = [];
      const r = await listTracesTolerant(ctx, PID, { range, nowMs: NOW, cursor: bad });
      expect(r.usedCursor).toBe(false);
      expect(r.result.items).toHaveLength(1);
      expect(m.transactions).toHaveLength(1);
      expect(m.transactions[0]![2]!.values.slice(5, 8)).toEqual([null, null, null]);
    }
  });
  it("every other failure propagates: not found, a bad project id, a bad status", async () => {
    m.results = [[], [emptyPage]];
    await expect(listTracesTolerant(ctx, PID, { range, nowMs: NOW, cursor: good })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listTracesTolerant(ctx, "nope", { range, nowMs: NOW, cursor: "garbage" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listTracesTolerant(ctx, PID, { range, nowMs: NOW, status: "x" as never })).rejects.toThrow();
  });
});
