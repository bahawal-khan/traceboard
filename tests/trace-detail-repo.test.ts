import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

/**
 * lib/repo/trace-detail.ts against a mocked driver: statement shape, bound parameters, window, trace-id validation, mapping and
 * the single not-found behaviour. The real database (RLS, IDOR) is tests/db/trace-detail.test.ts, run by the owner.
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

import { NotFoundError } from "@/lib/repo/errors";
import { issueCtx, type SessionCtx } from "@/lib/repo/tenant";
import { TRACE_DETAIL_LIMITS, getTrace, spanRowSchema, traceDetailWindow, traceIdSchema } from "@/lib/repo/trace-detail";

const HOUR = 3_600_000;
const PID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 10, 21, 12, 30, 0);
const ctx = issueCtx<SessionCtx>({ kind: "session", ownerId: "user_a", projectIds: [PID], readOnly: false });
const projectRow = [{ id: PID }];

const row = (o: Record<string, unknown> = {}) => ({
  span_key: "sp-1", parent_id: null, name: "agent.run", kind: "agent", model: null, status: "ok", latency_ms: 120, input_tokens: null, output_tokens: null,
  cached_tokens: null, cost_micro: null, unpriced: false, start_us: String(NOW * 1000 + 123), ...o,
});
const get = (rows: unknown[], traceId = "tr-1", opts: Record<string, unknown> = {}) => {
  m.results = [projectRow, rows];
  return getTrace(ctx, PID, traceId, { nowMs: NOW, ...opts });
};
const stmt = () => m.transactions[0]![2]!;

beforeEach(() => {
  m.results = [];
  m.transactions = [];
});

describe("the statement", () => {
  it("is ONE static template; project, trace id, window and cap are bound parameters", async () => {
    await get([row()], "tr-9");
    const w = traceDetailWindow(NOW);
    expect(m.transactions[0]).toHaveLength(3); // set_config, project check, spans
    expect(stmt().values).toEqual([PID, "tr-9", new Date(w.fromMs).toISOString(), new Date(w.toMs).toISOString(), TRACE_DETAIL_LIMITS.maxSpans + 1]);
    for (const v of [PID, "tr-9", "2026-11"]) expect(stmt().sql).not.toContain(v);
    expect(stmt().sql).not.toMatch(/limit \d/);
  });
  it("matches project AND trace id AND both time bounds, oldest first", async () => {
    await get([row()]);
    expect(stmt().sql).toMatch(/from events where project_id = \?::uuid and trace_id = \?::text and occurred_at >= \?::timestamptz and occurred_at < \?::timestamptz order by occurred_at asc, event_id asc limit \?::int$/);
  });
  it("selects metadata only: no content, no error text, no tags, no hashes", async () => {
    await get([row()]);
    const cols = /select (.+?) from events/.exec(stmt().sql)![1]!;
    expect(cols).toContain("status");
    expect(stmt().sql).not.toMatch(/event_content|input_text|output_text|prompt_hash|args_hash|user_id_hash|\btags\b|redaction|\berror\b|thread_id|select \*/);
  });
  it("the cost column is NULL when the event has no cost: the statement never coalesces it to 0", async () => {
    await get([row()]);
    expect(stmt().sql).toContain("round(cost_usd * 1000000)::bigint::text as cost_micro");
    expect(stmt().sql).not.toMatch(/coalesce\(\s*(round\()?cost_usd/i);
    expect(stmt().sql).toContain("(cost_usd is null and model is not null and model <> '') as unpriced");
  });
  it("hostile ids stay values: a trace id with SQL in it is bound, never part of the text", async () => {
    const evil = "x'; drop table events; --";
    await get([row()], evil);
    expect(stmt().values).toContain(evil);
    expect(stmt().sql).not.toContain("drop table");
  });
});

describe("window and cap", () => {
  it("14 days back from the end of the current hour, 24 hours ahead of it, whole hours", () => {
    const w = traceDetailWindow(NOW);
    const hourEnd = Date.UTC(2026, 10, 21, 13);
    expect(w).toEqual({ fromMs: hourEnd - 14 * 24 * HOUR, toMs: hourEnd + 24 * HOUR });
    expect(w.fromMs % HOUR).toBe(0);
    expect(() => traceDetailWindow(Number.NaN)).toThrow(RangeError);
  });
  it("the cap is 2,000 and the hook can only lower it", async () => {
    expect(TRACE_DETAIL_LIMITS.maxSpans).toBe(2_000);
    const capOf = async (spanCap: number) => {
      m.transactions = [];
      await get([row()], "tr-1", { spanCap });
      return stmt().values.at(-1);
    };
    expect(await capOf(5)).toBe(6);
    expect(await capOf(10_000_000)).toBe(2_001);
    expect(await capOf(Number.NaN)).toBe(2);
    expect(await capOf(-3)).toBe(2);
  });
  it("one row past the cap: the extra row is dropped and truncated is true; exactly the cap is not truncated", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => row({ span_key: `s${i}` }));
    const over = await get(rows, "tr-1", { spanCap: 3 });
    expect(over.truncated).toBe(true);
    expect(over.spans.map((s) => s.key)).toEqual(["s0", "s1", "s2"]);
    const exact = await get(rows.slice(0, 3), "tr-1", { spanCap: 3 });
    expect(exact.truncated).toBe(false);
    expect(exact.spans).toHaveLength(3);
  });
});

describe("trace id validation (before any database call)", () => {
  it.each([["empty", ""], ["129 characters", "x".repeat(129)], ["a NUL", "a\u0000b"], ["a newline", "a\nb"], ["a tab", "a\tb"], ["DEL", "a\u007fb"], ["a control char at the end", "abc\u001f"]])(
    "%s: NotFoundError and no database call",
    async (_n, id) => {
      await expect(getTrace(ctx, PID, id, { nowMs: NOW })).rejects.toBeInstanceOf(NotFoundError);
      expect(m.transactions).toHaveLength(0);
    },
  );
  it("everything the ingest accepts is accepted: spaces, unicode, 128 characters", () => {
    for (const ok of ["tr-1", "a b c", "трасса-1", "x".repeat(128), "t\u{1F600}", "a/b?c=d&e", "'; --"]) expect(traceIdSchema.safeParse(ok).success, ok).toBe(true);
  });
  it("a non-string trace id is refused too", async () => {
    await expect(getTrace(ctx, PID, undefined as never, { nowMs: NOW })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getTrace(ctx, PID, 42 as never, { nowMs: NOW })).rejects.toBeInstanceOf(NotFoundError);
    expect(m.transactions).toHaveLength(0);
  });
});

describe("not found is ONE answer", () => {
  const same = (e: unknown) => {
    expect(e).toBeInstanceOf(NotFoundError);
    expect((e as Error).message).toBe("not found");
    expect((e as Error).name).toBe("NotFoundError");
  };
  it("foreign project, malformed project id: no database call", async () => {
    for (const id of [OTHER, "not-a-uuid", ""]) await getTrace(ctx, id, "tr-1", { nowMs: NOW }).then(() => expect.fail("should throw"), same);
    expect(m.transactions).toHaveLength(0);
  });
  it("the project row is missing (deleted, or not the owner's)", async () => {
    m.results = [[], [row()]];
    await getTrace(ctx, PID, "tr-1", { nowMs: NOW }).then(() => expect.fail("should throw"), same);
  });
  it("no spans: the trace does not exist, belongs to another project, or is out of the window", async () => {
    m.results = [projectRow, []];
    await getTrace(ctx, PID, "tr-1", { nowMs: NOW }).then(() => expect.fail("should throw"), same);
  });
  it("checks the project row with the owner filter in the same transaction", async () => {
    await get([row()]);
    expect(m.transactions[0]![1]!.sql).toBe("select id from projects where id = ?::uuid and owner_id = ?");
    expect(m.transactions[0]![1]!.values).toEqual([PID, "user_a"]);
  });
});

describe("mapping", () => {
  it("maps strings to numbers, keeps nulls null, never invents a cost", async () => {
    const r = await get([
      row({ span_key: "a", model: "gpt-4o", input_tokens: 100, output_tokens: 20, cached_tokens: 5, cost_micro: "1500", start_us: "1763728200123456" }),
      row({ span_key: "b", model: "mystery", cost_micro: null, unpriced: true }),
      row({ span_key: "c", model: null, cost_micro: null, unpriced: false, latency_ms: null }),
      row({ span_key: "d", cost_micro: "0", model: "free" }),
    ]);
    expect(r.spans[0]).toEqual({
      key: "a", parentId: null, name: "agent.run", kind: "agent", model: "gpt-4o", isError: false, startUs: 1_763_728_200_123_456, latencyMs: 120,
      inputTokens: 100, outputTokens: 20, cachedTokens: 5, costMicro: 1500, unpriced: false,
    });
    expect(r.spans[1]).toMatchObject({ costMicro: null, unpriced: true });
    expect(r.spans[2]).toMatchObject({ costMicro: null, unpriced: false, latencyMs: null });
    expect(r.spans[3]).toMatchObject({ costMicro: 0, unpriced: false });
    expect(r.traceId).toBe("tr-1");
    expect(r.truncated).toBe(false);
  });
  it("status 'error' is a flag; anything else, including null, is not", async () => {
    const r = await get([row({ span_key: "a", status: "error" }), row({ span_key: "b", status: "ok" }), row({ span_key: "c", status: null })]);
    expect(r.spans.map((s) => s.isError)).toEqual([true, false, false]);
  });
  it("microseconds survive (the list's precision)", async () => {
    const r = await get([row({ start_us: "1763728200000001" }), row({ span_key: "b", start_us: "1763728200000002" })]);
    expect(r.spans[1]!.startUs - r.spans[0]!.startUs).toBe(1);
  });
  it("a negative latency is passed through (the tree treats it as unknown); a surprise elsewhere fails loudly", async () => {
    expect((await get([row({ latency_ms: -5 })])).spans[0]!.latencyMs).toBe(-5);
    await expect(get([row({ input_tokens: -1 })])).rejects.toThrow();
    await expect(get([row({ start_us: "abc" })])).rejects.toThrow();
    await expect(get([row({ span_key: "" })])).rejects.toThrow();
  });
  it("the span schema is strict: no free-text fields beyond names", () => {
    expect(Object.keys(spanRowSchema.shape).sort()).toEqual(
      ["cachedTokens", "costMicro", "inputTokens", "isError", "key", "kind", "latencyMs", "model", "name", "outputTokens", "parentId", "startUs", "unpriced"],
    );
  });
});
