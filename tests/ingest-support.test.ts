import { describe, expect, it, vi } from "vitest";
import type { BudgetUsageRow, UsageToday } from "@/lib/events/store";
import { budgetVerdict, usdTextToMicro } from "@/lib/guard/verdict";
import { flushHintMs } from "@/lib/ingest/hint";
import { UsageGate } from "@/lib/ingest/quota";
import { FLUSH_HINT_MS } from "@/lib/quotas";
import { issueCtx, type ApiKeyCtx } from "@/lib/repo/tenant";

const PID = "11111111-1111-4111-8111-111111111111";
const ctx = issueCtx<ApiKeyCtx>({ kind: "apiKey", ownerId: null, projectIds: [PID], keyId: "22222222-2222-4222-8222-222222222222", scopes: ["ingest"], readOnly: false });
const usage = (events: number, requests: number): UsageToday => ({ events, requests, costMicro: 0 });

describe("UsageGate", () => {
  const T0 = Date.parse("2026-11-20T10:00:00Z");
  const limits = { eventsPerDay: 100, requestsPerDay: 10 };

  it("allows under both limits and reads usage once per ttl", async () => {
    let t = T0;
    const read = vi.fn(async () => usage(5, 2));
    const g = new UsageGate(read, limits, { now: () => t });
    expect(await g.check(ctx)).toEqual({ ok: true });
    expect(await g.check(ctx)).toEqual({ ok: true });
    expect(read).toHaveBeenCalledTimes(1);
    t += 10_001;
    await g.check(ctx);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("refuses at the events limit and at the requests limit, saying which, with seconds until UTC midnight", async () => {
    const t = Date.parse("2026-11-20T23:59:00Z");
    const ev = await new UsageGate(async () => usage(100, 1), limits, { now: () => t }).check(ctx);
    expect(ev).toEqual({ ok: false, reason: "events", retryAfterSec: 60 });
    const rq = await new UsageGate(async () => usage(1, 10), limits, { now: () => t }).check(ctx);
    expect(rq).toMatchObject({ ok: false, reason: "requests" });
    expect(await new UsageGate(async () => usage(99, 9), limits, { now: () => t }).check(ctx)).toEqual({ ok: true });
  });

  it("treats 'no row yet today' as zero", async () => {
    expect(await new UsageGate(async () => null, limits).check(ctx)).toEqual({ ok: true });
  });

  it("is refreshed by record() without another read, so a busy instance hardly queries usage", async () => {
    const read = vi.fn(async () => usage(0, 0));
    const g = new UsageGate(read, limits, { now: () => T0 });
    await g.check(ctx);
    g.record(PID, usage(100, 3));
    expect(await g.check(ctx)).toMatchObject({ ok: false, reason: "events" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh count on a new UTC day", async () => {
    let t = Date.parse("2026-11-20T23:59:59Z");
    const read = vi.fn().mockResolvedValueOnce(usage(100, 1)).mockResolvedValueOnce(null);
    const g = new UsageGate(read, limits, { now: () => t });
    expect((await g.check(ctx)).ok).toBe(false);
    t = Date.parse("2026-11-21T00:00:01Z");
    expect((await g.check(ctx)).ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("propagates a read failure (the route answers 503) and caches nothing", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(usage(0, 0));
    const g = new UsageGate(read, limits);
    await expect(g.check(ctx)).rejects.toThrow("db down");
    expect((await g.check(ctx)).ok).toBe(true);
  });
});

describe("flushHintMs", () => {
  const now = Date.parse("2026-11-20T10:00:00Z");
  it("conserve mode wins over everything", () => {
    expect(flushHintMs({ lastViewedAt: new Date(now), conserve: true }, now)).toBe(FLUSH_HINT_MS.conserve);
  });
  it("is 1 s while someone is watching and falls back after the live window", () => {
    expect(flushHintMs({ lastViewedAt: new Date(now - 5_000), conserve: false }, now)).toBe(1000);
    const idle = flushHintMs({ lastViewedAt: new Date(now - FLUSH_HINT_MS.liveWindow - 1), conserve: false }, now, () => 0);
    expect(idle).toBe(FLUSH_HINT_MS.idleMin);
  });
  it("is 10-15 s otherwise, including with no signals", () => {
    expect(flushHintMs(null, now, () => 0)).toBe(10_000);
    expect(flushHintMs(null, now, () => 1)).toBe(15_000);
    expect(flushHintMs({ lastViewedAt: null, conserve: false }, now, () => 0.5)).toBe(12_500);
    for (let i = 0; i < 200; i++) {
      const h = flushHintMs(null, now);
      expect(h).toBeGreaterThanOrEqual(10_000);
      expect(h).toBeLessThanOrEqual(15_000);
    }
  });
});

describe("budgetVerdict", () => {
  const row = (o: Partial<BudgetUsageRow>): BudgetUsageRow => ({
    budgetId: "b1", scope: "project", period: "day", limitUsd: "5", action: "alert", periodKey: "2026-11-20", spentMicro: 0, ...o,
  });
  it("is ok with nothing touched or under the limit", () => {
    expect(budgetVerdict([])).toEqual({ status: "ok", exceeded: [] });
    expect(budgetVerdict([row({ spentMicro: 4_999_999 })]).status).toBe("ok");
  });
  it("alerts at or over an alert budget, blocks at or over a block budget, and block wins", () => {
    expect(budgetVerdict([row({ spentMicro: 5_000_000 })]).status).toBe("alert");
    const v = budgetVerdict([row({ spentMicro: 6_000_000 }), row({ budgetId: "b2", action: "block", spentMicro: 5_000_000 })]);
    expect(v.status).toBe("block");
    expect(v.exceeded).toHaveLength(2);
    expect(v.exceeded[1]).toMatchObject({ budget_id: "b2", action: "block", limit_micro: 5_000_000, spent_micro: 5_000_000, period_key: "2026-11-20" });
  });
  it("converts limits robustly and ignores unusable ones", () => {
    expect(usdTextToMicro("5")).toBe(5_000_000);
    expect(usdTextToMicro("0.25")).toBe(250_000);
    expect(usdTextToMicro("5.000000")).toBe(5_000_000);
    for (const bad of ["", "abc", "0", "-1"]) expect(usdTextToMicro(bad), bad).toBeNull();
    expect(budgetVerdict([row({ limitUsd: "abc", spentMicro: 999 })]).status).toBe("ok");
  });
});
