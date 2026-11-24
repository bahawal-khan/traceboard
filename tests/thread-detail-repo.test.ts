import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/repo/thread-detail.ts against a mocked driver: statement shape, bound parameters, window, id validation, mapping, caps and
 * the single not-found behaviour. Also keeps scripts/threads-explain-sql.mjs in step with the two thread statements. The real
 * database (RLS, IDOR) is tests/db/thread-detail.test.ts, run by the owner.
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

import { parseTraceIdParam, traceDetailHref } from "@/lib/dashboard/trace-detail-view";
import { NotFoundError } from "@/lib/repo/errors";
import { THREAD_LIMITS, threadListStatement } from "@/lib/repo/threads";
import { THREAD_DETAIL_LIMITS, getThread, threadDetailStatement } from "@/lib/repo/thread-detail";
import { issueCtx, type SessionCtx, type Tx } from "@/lib/repo/tenant";
import { traceDetailWindow } from "@/lib/repo/trace-detail";
import {
  DETAIL_SCAN_CAP, DETAIL_SQL, DETAIL_TURN_CAP, LIST_SCAN_CAP, LIST_SQL, detailParams, detailWindow, listParams, listWindow,
} from "../scripts/threads-explain-sql.mjs";

const PID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 10, 21, 12, 30, 0);
const ctx = issueCtx<SessionCtx>({ kind: "session", ownerId: "user_a", projectIds: [PID], readOnly: false });
const projectRow = [{ id: PID }];

const row = (o: Record<string, unknown> = {}) => ({
  scanned: 10, truncated: false, untraced: "0", trace_id: "tr-1", started_at_ms: String(NOW - 5000), duration_ms: "850", spans: "4", errors: "1",
  tokens: "321", cost_micro: "1500", unpriced: "0", has_root: true, root_name: "agent.run", ...o,
});
const noTurns = { scanned: 3, truncated: false, untraced: "3", trace_id: null, started_at_ms: null, duration_ms: null, spans: null, errors: null, tokens: null, cost_micro: null, unpriced: null, has_root: null, root_name: null };
const get = (rows: unknown[], threadId = "th-1", opts: Record<string, unknown> = {}) => {
  m.results = [projectRow, rows];
  return getThread(ctx, PID, threadId, { nowMs: NOW, ...opts });
};
const stmt = () => m.transactions[0]![2]!;

beforeEach(() => {
  m.results = [];
  m.transactions = [];
});

describe("the statement", () => {
  it("is ONE static template; project, thread, window and every limit are bound parameters", async () => {
    await get([row()], "th-9");
    const w = traceDetailWindow(NOW);
    expect(m.transactions[0]).toHaveLength(3); // set_config, project check, thread
    expect(stmt().values).toEqual([
      PID, "th-9", new Date(w.fromMs).toISOString(), new Date(w.toMs).toISOString(),
      THREAD_DETAIL_LIMITS.maxScanEvents + 1, THREAD_DETAIL_LIMITS.maxScanEvents, THREAD_DETAIL_LIMITS.maxTurns + 1, THREAD_DETAIL_LIMITS.maxScanEvents,
    ]);
    for (const v of [PID, "th-9", "2026-11"]) expect(stmt().sql).not.toContain(v);
    expect(stmt().sql).not.toMatch(/limit \d/);
  });
  it("matches project AND thread AND both time bounds, oldest first", async () => {
    await get([row()]);
    expect(stmt().sql).toMatch(/from events where project_id = \?::uuid and thread_id = \?::text and occurred_at >= \?::timestamptz and occurred_at < \?::timestamptz order by occurred_at asc limit \?::int/);
  });
  it("orders turns by start then trace id, ascending, in the page and in the result", async () => {
    await get([row()]);
    expect(stmt().sql).toContain("order by start_at asc, trace_id asc limit ?::int");
    expect(stmt().sql).toContain("order by p.start_at asc nulls last, p.trace_id asc");
  });
  it("selects metadata only: no content, no error text, no tags, no hashes", async () => {
    await get([row()]);
    const scan = /with scan as \( select (.+?) from events/.exec(stmt().sql)![1]!;
    expect(scan.split(", ")).toEqual(["trace_id", "parent_id", "name", "status", "model", "input_tokens", "output_tokens", "latency_ms", "cost_usd", "occurred_at"]);
    expect(stmt().sql).not.toMatch(/event_content|input_text|output_text|prompt_hash|args_hash|user_id_hash|\btags\b|redaction|select \* from events/);
  });
  it("the cost sum never coalesces to 0, and keeps the oldest events (drops the newest timestamp) at the cap", async () => {
    await get([row()]);
    expect(stmt().sql).toContain("sum(cost_usd) as cost");
    expect(stmt().sql).toContain("where b.scanned <= ?::int or s.occurred_at < b.newest");
  });
});

describe("id validation and the single not-found", () => {
  const same = (e: unknown) => {
    expect(e).toBeInstanceOf(NotFoundError);
    expect((e as Error).message).toBe("not found");
  };
  it("a bad thread id is NotFound before any database call", async () => {
    for (const id of ["", "x".repeat(129), "a\u0000b", "a\nb", "a\u007fb"]) await getThread(ctx, PID, id).then(() => expect.fail("should throw"), same);
    expect(m.transactions).toHaveLength(0);
  });
  it("a project outside the context or malformed: NotFound and NO database call", async () => {
    for (const id of [OTHER, "not-a-uuid", "", PID + " "]) await getThread(ctx, id, "th-1").then(() => expect.fail("should throw"), same);
    expect(m.transactions).toHaveLength(0);
  });
  it("a project that is in the context but not (or no longer) the owner's row: NotFound", async () => {
    m.results = [[], [row()]];
    await getThread(ctx, PID, "th-1", { nowMs: NOW }).then(() => expect.fail("should throw"), same);
  });
  it("an unknown thread (no event at all) is the same NotFound", async () => {
    m.results = [projectRow, []];
    await getThread(ctx, PID, "th-1", { nowMs: NOW }).then(() => expect.fail("should throw"), same);
    m.results = [projectRow, [{ ...noTurns, scanned: 0, untraced: "0" }]];
    await getThread(ctx, PID, "th-1", { nowMs: NOW }).then(() => expect.fail("should throw"), same);
  });
  it("checks the project row with the owner filter in the same transaction", async () => {
    await get([row()]);
    expect(m.transactions[0]![1]!.sql).toBe("select id from projects where id = ?::uuid and owner_id = ?");
    expect(m.transactions[0]![1]!.values).toEqual([PID, "user_a"]);
  });
  it("a hostile thread id is bound as a value", async () => {
    const evil = "x'; drop table events; --";
    await get([row()], evil);
    expect(stmt().values).toContain(evil);
    expect(stmt().sql).not.toContain("drop table");
  });
  it("odd but valid ids work (unicode, quotes, 128 characters)", async () => {
    for (const id of ["сессия", "a'b\"c", "x".repeat(128), "💬"]) expect((await get([row()], id)).threadId).toBe(id);
  });
});

describe("mapping", () => {
  it("maps rows to turns in the order the database gave", async () => {
    const r = await get([row({ trace_id: "t-a" }), row({ trace_id: "t-b", spans: "2" })]);
    expect(r.threadId).toBe("th-1");
    expect(r.turns.map((t) => t.traceId)).toEqual(["t-a", "t-b"]);
    expect(r.turns[0]).toEqual({
      traceId: "t-a", startedAtMs: NOW - 5000, durationMs: 850, spanCount: 4, errorCount: 1, totalTokens: 321, costMicro: 1500,
      costLowerBound: false, unpricedEvents: 0, rootName: "agent.run", hasRoot: true,
    });
    expect(r.truncated).toBe(false);
    expect(r.window).toEqual(traceDetailWindow(NOW));
  });
  it("cost: unknown stays null; nothing to price is 0; partial is a lower bound", async () => {
    const r = await get([
      row({ trace_id: "u", cost_micro: null, unpriced: "2" }),
      row({ trace_id: "tools", cost_micro: null, unpriced: "0" }),
      row({ trace_id: "p", cost_micro: "700", unpriced: "1" }),
    ]);
    expect(r.turns.map((t) => [t.costMicro, t.costLowerBound])).toEqual([[null, true], [0, false], [700, true]]);
  });
  it("a thread whose events have no trace id: no turns, the count of untraced events, still found", async () => {
    const r = await get([noTurns]);
    expect(r.turns).toEqual([]);
    expect(r.untracedEvents).toBe(3);
  });
  it("an orphan turn (no root) is kept, with no root name", async () => {
    const r = await get([row({ has_root: false, root_name: null })]);
    expect(r.turns[0]).toMatchObject({ hasRoot: false, rootName: null });
  });
  it("a surprise from the driver fails loudly", async () => {
    await expect(get([row({ spans: "0" })])).rejects.toThrow();
    await expect(get([row({ errors: "-1" })])).rejects.toThrow();
  });
  it("every turn's trace id is accepted by the trace detail page and survives a link round trip", async () => {
    const ids = ["tr-1", "a b/c?d#e", "сессия", "x".repeat(128), "100%", "a'b\"c<script>"];
    const r = await get(ids.map((trace_id) => row({ trace_id })));
    for (const t of r.turns) {
      const href = traceDetailHref("/dashboard/projects/p/traces", t.traceId);
      expect(href.startsWith("/dashboard/projects/p/traces/")).toBe(true);
      expect(href.slice("/dashboard/projects/p/traces/".length)).toMatch(/^[A-Za-z0-9%._~!*'()-]+$/); // one safe path segment
      expect(decodeURIComponent(href.split("/").pop()!)).toBe(t.traceId);
      expect(parseTraceIdParam(t.traceId)).toBe(t.traceId);
    }
  });
});

describe("caps", () => {
  it("the caps sit where they should and can only be LOWERED by the hooks", async () => {
    const capsOf = async (o: Record<string, unknown>) => {
      m.transactions = [];
      await get([row()], "th-1", o);
      return [stmt().values[4], stmt().values[5], stmt().values[6], stmt().values[7]];
    };
    expect(await capsOf({ scanCap: 5, turnCap: 3 })).toEqual([6, 5, 4, 5]);
    expect(await capsOf({ scanCap: 10_000_000, turnCap: 10_000_000 })).toEqual([5_001, 5_000, 201, 5_000]);
    expect(await capsOf({ scanCap: Number.NaN, turnCap: -2 })).toEqual([2, 1, 2, 1]);
  });
  it("the event cap covers a full day of the events quota with margin", () => {
    expect(THREAD_DETAIL_LIMITS.maxScanEvents).toBeGreaterThanOrEqual(1_900 * 2);
  });
  it("more turns than the turn cap: the extra row is dropped and truncated is true", async () => {
    const r = await get([row({ trace_id: "a" }), row({ trace_id: "b" }), row({ trace_id: "c" })], "th-1", { turnCap: 2 });
    expect(r.turns.map((t) => t.traceId)).toEqual(["a", "b"]);
    expect(r.truncated).toBe(true);
  });
  it("exactly the turn cap is not truncated", async () => {
    const r = await get([row({ trace_id: "a" }), row({ trace_id: "b" })], "th-1", { turnCap: 2 });
    expect(r.turns).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });
  it("the event cap flag from the statement is passed through (even with no turns)", async () => {
    expect((await get([row({ truncated: true })])).truncated).toBe(true);
    expect((await get([{ ...noTurns, truncated: true }])).truncated).toBe(true);
  });
});

describe("scripts/threads-explain-sql.mjs stays in step with lib/repo", () => {
  const recN = ((s: TemplateStringsArray, ...v: unknown[]) => ({ text: s.reduce((a, p, i) => a + p + (i < v.length ? `$${i + 1}` : ""), "").replace(/\s+/g, " ").trim(), values: v })) as unknown as Tx;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const isoIdx = new Set([1, 2]);
  const mask = (v: unknown[], iso: Set<number>) => v.map((x, i) => (iso.has(i) ? "<iso>" : x));

  it("list: same statement text and the same parameters in the same order", () => {
    const real = threadListStatement(recN, { pid: PID, fromIso: "F", toIso: "T", scanLimit: LIST_SCAN_CAP + 1, cap: LIST_SCAN_CAP, cursorLast: "S", cursorThread: "TH", fetchLimit: 51 }) as unknown as { text: string; values: unknown[] };
    expect(norm(LIST_SQL)).toBe(real.text);
    const w = listWindow(NOW);
    const p = listParams({ projectId: PID, fromMs: w.fromMs, toMs: w.toMs, cursor: { lastActive: "S", threadId: "TH" }, limit: 50 });
    expect(mask(p, isoIdx)).toEqual(mask(real.values, isoIdx));
  });
  it("detail: same statement text and the same parameters in the same order", () => {
    const real = threadDetailStatement(recN, { pid: PID, threadId: "TH", fromIso: "F", toIso: "T", scanLimit: DETAIL_SCAN_CAP + 1, cap: DETAIL_SCAN_CAP, fetchLimit: DETAIL_TURN_CAP + 1 }) as unknown as { text: string; values: unknown[] };
    expect(norm(DETAIL_SQL)).toBe(real.text);
    const w = detailWindow(NOW);
    const p = detailParams({ projectId: PID, threadId: "TH", fromMs: w.fromMs, toMs: w.toMs });
    const detailIso = new Set([2, 3]); // the thread id sits at $2, so the timestamps are $3 and $4
    expect(mask(p, detailIso)).toEqual(mask(real.values, detailIso));
  });
  it("caps and windows equal the real ones", () => {
    expect(LIST_SCAN_CAP).toBe(THREAD_LIMITS.maxScanRows);
    expect(DETAIL_SCAN_CAP).toBe(THREAD_DETAIL_LIMITS.maxScanEvents);
    expect(DETAIL_TURN_CAP).toBe(THREAD_DETAIL_LIMITS.maxTurns);
    expect(detailWindow(NOW)).toEqual(traceDetailWindow(NOW));
  });
  it("the scripts only read, and never print the environment or a connection string", () => {
    for (const f of ["scripts/explain-threads.mjs", "scripts/threads-explain-sql.mjs"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/\b(insert into|update\s+\w+\s+set|delete from|drop\s+(table|index)|truncate)\b/i);
      for (const l of s.split("\n").filter((x) => /console\.(log|error|warn|info|debug)/.test(x))) expect(l, `${f}: ${l}`).not.toMatch(/process\.env|_URL|\burl\b|password|connection string/i);
      expect(s, f).not.toMatch(/readFileSync|loadEnvFile|process\.env\)/);
    }
  });
});
