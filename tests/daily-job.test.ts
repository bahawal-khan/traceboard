import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@/lib/logger";
import { DAILY_JOB, runDailyJob, storageLevel, type JobStore } from "@/lib/jobs/daily";
import { isCronAuthorized } from "@/lib/jobs/cron-auth";
import { createDailyJobHandler } from "@/lib/jobs/handler";

const SECRET = "s3cret-cron-value-0123456789";
const h = (authorization?: string) => new Headers(authorization ? { authorization } : {});
const health = { currentPartition: "events_y2026m11", currentExists: true, nextPartition: "events_y2026m12", nextExists: true, partitionCount: 3 };
const report = { databaseBytes: 1, eventsBytes: 3e8, contentBytes: 1, rollupBytes: 1, eventsBudgetBytes: 6e8, eventsRatio: 0.5 };

/** A store whose purges drain `n` rows per table in `batch`-sized calls. */
function fakeStore(over: Partial<JobStore> = {}, pending = { events: 0, content: 0, orphans: 0, rollups: 0 }): JobStore & { calls: string[] } {
  const calls: string[] = [];
  const drain = (k: keyof typeof pending) => async (batch: number) => {
    calls.push(k);
    const n = Math.min(batch, pending[k]);
    pending[k] -= n;
    return n;
  };
  const store: JobStore & { calls: string[] } = {
    calls,
    ensurePartitions: async () => (calls.push("ensure"), 1),
    partitionHealth: async () => (calls.push("health"), health),
    purgeExpiredEvents: drain("events"),
    purgeExpiredContent: drain("content"),
    purgeOrphanedContent: drain("orphans"),
    purgeRollups: async (batch) => {
      const n = await drain("rollups")(batch);
      return { minute: n, hourly: 0, budget: 0, usage: 0 };
    },
    dropOldPartitions: async () => (calls.push("drop"), 0),
    storageReport: async () => (calls.push("storage"), report),
    ...over,
  };
  return store;
}

describe("isCronAuthorized", () => {
  it("accepts exactly the secret as a bearer token", () => {
    expect(isCronAuthorized(h(`Bearer ${SECRET}`), SECRET)).toBe(true);
    expect(isCronAuthorized(h(`bearer   ${SECRET}`), SECRET)).toBe(true);
  });
  it("rejects missing, wrong, prefix, extended, non-bearer and empty credentials", () => {
    for (const a of [undefined, "", "Bearer", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, `Basic ${SECRET}`, SECRET, `Bearer wrong-secret-value-123456`, `Bearer ${SECRET} extra`]) {
      expect(isCronAuthorized(h(a), SECRET), String(a)).toBe(false);
    }
  });
  it("fails closed when the secret is unset, empty or shorter than 16 characters", () => {
    for (const s of [undefined, "", "short"]) {
      expect(isCronAuthorized(h(`Bearer ${s ?? ""}`), s)).toBe(false);
      expect(isCronAuthorized(h(), s)).toBe(false);
    }
  });
  it("does not accept an API key or a Clerk-looking token", () => {
    expect(isCronAuthorized(h(`Bearer lm_${"A".repeat(43)}`), SECRET)).toBe(false);
  });
});

describe("runDailyJob", () => {
  it("runs the steps in order and reports a clean, complete run on an empty database", async () => {
    const s = fakeStore();
    const r = await runDailyJob(s);
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(s.calls).toEqual(["ensure", "health", "events", "content", "orphans", "rollups", "drop", "storage"]);
    expect(r.storage.level).toBe("ok");
  });

  it("loops in batches until a short batch, and totals the deleted rows", async () => {
    const s = fakeStore({}, { events: 12_345, content: 0, orphans: 0, rollups: 0 });
    const r = await runDailyJob(s, { batch: 5_000 });
    expect(r.purge.events).toMatchObject({ deleted: 12_345, calls: 3, drained: true, status: "ok" });
  });

  it("an exact multiple of the batch costs one extra call (the empty batch proves it is drained)", async () => {
    const s = fakeStore({}, { events: 10_000, content: 0, orphans: 0, rollups: 0 });
    const r = await runDailyJob(s, { batch: 5_000 });
    expect(r.purge.events).toMatchObject({ deleted: 10_000, calls: 3, drained: true });
  });

  it("stops on the time budget, reports complete=false (not a failure), and never calls after the deadline", async () => {
    let t = 1_000_000;
    const s = fakeStore({}, { events: 1e9, content: 0, orphans: 0, rollups: 0 });
    const inner = s.purgeExpiredEvents;
    s.purgeExpiredEvents = async (b) => {
      t += 1_000; // every call "takes" one second
      return inner(b);
    };
    const r = await runDailyJob(s, { batch: 100, purgeBudgetMs: 10_000, now: () => t });
    // the events loop owns half the budget: 5 s, so exactly 5 one-second calls
    expect(r.purge.events.calls).toBe(5);
    expect(r.purge.events.drained).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
    expect(s.calls.filter((c) => c === "drop" || c === "storage")).toEqual(["drop", "storage"]); // later steps still run
  });

  it("caps the calls per loop even if the batch never comes back short", async () => {
    let n = 0;
    // Fails fast (instead of spinning forever) if the cap is ever removed: the loop records the throw as a failed step.
    const s = fakeStore({ purgeExpiredEvents: async (b) => (++n > DAILY_JOB.maxCallsPerLoop + 5 ? Promise.reject(new Error("runaway loop")) : b) });
    const r = await runDailyJob(s, { batch: 10, now: () => 0 });
    expect(r.purge.events.status).toBe("ok");
    expect(r.purge.events.calls).toBe(DAILY_JOB.maxCallsPerLoop);
    expect(r.purge.events.drained).toBe(false);
  });

  it("rollups: loops while any table returns a full batch and sums per table", async () => {
    const left = { minute: 25, hourly: 12, budget: 0, usage: 3 };
    const s = fakeStore({
      purgeRollups: async (b) => {
        const take = (k: keyof typeof left) => {
          const n = Math.min(b, left[k]);
          left[k] -= n;
          return n;
        };
        return { minute: take("minute"), hourly: take("hourly"), budget: take("budget"), usage: take("usage") };
      },
    });
    const r = await runDailyJob(s, { batch: 10 });
    expect(r.purge.rollups.byTable).toEqual({ minute: 25, hourly: 12, budget: 0, usage: 3 });
    expect(r.purge.rollups.deleted).toBe(40);
    expect(r.purge.rollups.calls).toBe(3);
    expect(r.purge.rollups.drained).toBe(true);
  });

  it("a failing step is isolated: the others still run, ok=false, and the error is generic", async () => {
    const s = fakeStore({ purgeExpiredEvents: async () => { throw new Error("connection to postgres://app_job:pw@host failed"); } });
    const r = await runDailyJob(s);
    expect(r.ok).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.purge.events).toMatchObject({ status: "error", error: "step_failed" });
    expect(s.calls).toEqual(expect.arrayContaining(["content", "orphans", "rollups", "drop", "storage"]));
    expect(JSON.stringify(r)).not.toMatch(/postgres|app_job|pw@/);
  });

  it("fails the run (ok=false) when the next partition is missing after ensure", async () => {
    const s = fakeStore({ partitionHealth: async () => ({ ...health, nextExists: false }) });
    const r = await runDailyJob(s);
    expect(r.ok).toBe(false);
    expect(r.partitions).toMatchObject({ status: "error", nextPartitionMissing: true });
    expect(s.calls).toContain("storage"); // the rest still ran
  });

  it("a failing ensure still lets purges run", async () => {
    const s = fakeStore({ ensurePartitions: async () => { throw new Error("boom"); } });
    const r = await runDailyJob(s);
    expect(r.partitions.status).toBe("error");
    expect(s.calls).toContain("events");
    expect(r.ok).toBe(false);
  });

  it("is idempotent: a second run after a drained first run deletes nothing", async () => {
    const pending = { events: 7_000, content: 300, orphans: 5, rollups: 90 };
    const s = fakeStore({}, pending);
    const first = await runDailyJob(s, { batch: 1_000 });
    const second = await runDailyJob(s, { batch: 1_000 });
    expect(first.purge.events.deleted).toBe(7_000);
    for (const l of [second.purge.events, second.purge.content, second.purge.orphanedContent, second.purge.rollups]) expect(l.deleted).toBe(0);
    expect(second.complete).toBe(true);
  });

  it("passes the batch size to every purge and logs no secrets or row data", async () => {
    const lines: string[] = [];
    const log = createLogger({}, { sink: (l) => lines.push(l), minLevel: "debug" });
    const seen: number[] = [];
    const s = fakeStore({ purgeExpiredContent: async (b) => (seen.push(b), 0) });
    await runDailyJob(s, { batch: 777, log });
    expect(seen).toEqual([777]);
    expect(lines.join("\n")).not.toMatch(new RegExp(SECRET));
  });

  it("flags storage thresholds (70% warn, 85% critical)", async () => {
    expect(storageLevel(0.69)).toBe("ok");
    expect(storageLevel(0.7)).toBe("warn");
    expect(storageLevel(0.85)).toBe("critical");
    const warn = vi.fn();
    const r = await runDailyJob(fakeStore({ storageReport: async () => ({ ...report, eventsRatio: 0.9 }) }), { log: { info() {}, warn, error() {} } });
    expect(r.storage.level).toBe("critical");
    expect(warn).toHaveBeenCalled();
  });
});

describe("createDailyJobHandler", () => {
  const req = (authorization?: string, method = "GET") => new Request("http://localhost/api/jobs/daily", { method, headers: authorization ? { authorization } : {} });
  const quiet = createLogger({}, { sink: () => {} });
  const mk = (over: Partial<Parameters<typeof createDailyJobHandler>[0]> = {}) => {
    const store = vi.fn(() => fakeStore());
    return { store, GET: createDailyJobHandler({ secret: () => SECRET, store, log: quiet, ...over }) };
  };

  it("answers 401 with a bare body and never builds the store (no database) without the right secret", async () => {
    const { GET, store } = mk();
    for (const a of [undefined, "Bearer nope-nope-nope-nope-1", `Bearer ${SECRET}x`]) {
      const res = await GET(req(a));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(store).not.toHaveBeenCalled();
  });

  it("answers 401 for everyone when CRON_SECRET is not configured", async () => {
    const { GET, store } = mk({ secret: () => undefined });
    expect((await GET(req("Bearer "))).status).toBe(401);
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(401);
    expect(store).not.toHaveBeenCalled();
  });

  it("runs the job with the secret: 200, JSON result, no-store, request id", async () => {
    const { GET } = mk();
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, complete: true });
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("answers 500 when a step failed, and 500 with a generic body when the run crashes", async () => {
    const failing = mk({ store: () => fakeStore({ storageReport: async () => { throw new Error("x"); } }) });
    const res = await failing.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);

    const lines: string[] = [];
    const crash = mk({ run: async () => { throw new Error(`leak ${SECRET} postgres://u:p@h/db`); }, log: createLogger({}, { sink: (l) => lines.push(l) }) });
    const res2 = await crash.GET(req(`Bearer ${SECRET}`));
    expect(res2.status).toBe(500);
    expect(await res2.json()).toEqual({ ok: false, error: "job_failed" });
    expect(lines.join("\n")).not.toMatch(/postgres:\/\/u:p/);
  });

  it("exposes GET only (no POST handler to guess at)", () => {
    expect(Object.keys(mk())).not.toContain("POST");
  });
});

describe("lib/repo/jobs.ts (static)", () => {
  it("calls only the eight job functions, with bound parameters and no string-built SQL", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/repo/jobs.ts", "utf8");
    const called = [...src.matchAll(/(?:from|select)\s+(?:[a-z_, ]+\s+from\s+)?([a-z_]+)\(/g)].map((m) => m[1]!);
    expect([...new Set(called)].sort()).toEqual(
      ["drop_old_event_partitions", "events_partition_health", "job_ensure_partitions", "purge_expired_content", "purge_expired_events", "purge_orphaned_content", "purge_rollups", "storage_report"].sort(),
    );
    expect(src).not.toMatch(/sql\(\)\s*\(|sql\.unsafe|\+\s*["'`]|getSql\b|lib\/db\/client|withTenant/);
    expect(src).toMatch(/getJobSql/);
  });
});

/** Added after mutation testing P2.11b: each test below kills a mutant that the first version of the suite let survive. */
describe("mutation survivors", () => {
  it("cron auth: the bearer scheme must start the header (no match inside a longer value)", () => {
    expect(isCronAuthorized(h(`x Bearer ${SECRET}`), SECRET)).toBe(false);
    expect(isCronAuthorized(h(`Token Bearer ${SECRET}`), SECRET)).toBe(false);
  });

  it("cron auth: compares hashes with timingSafeEqual, never with ===/startsWith on the secret", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/jobs/cron-auth.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toMatch(/timingSafeEqual\(sha256\(/);
    expect(src).not.toMatch(/===|!==|startsWith|\.includes\(|localeCompare/);
  });

  it("a failed partition drop fails the run but the storage report still runs", async () => {
    const s = fakeStore({ dropOldPartitions: async () => { throw new Error("lock timeout"); } });
    const r = await runDailyJob(s);
    expect(r.ok).toBe(false);
    expect(r.droppedPartitions).toMatchObject({ status: "error", error: "step_failed" });
    expect(s.calls).toContain("storage");
  });

  it("rollups keep looping while ANY single table (budget or usage included) returns a full batch", async () => {
    for (const key of ["minute", "hourly", "budget", "usage"] as const) {
      let left = 25;
      let calls = 0;
      const s = fakeStore({
        purgeRollups: async (b) => {
          calls += 1;
          const n = Math.min(b, left);
          left -= n;
          return { minute: 0, hourly: 0, budget: 0, usage: 0, [key]: n };
        },
      });
      const r = await runDailyJob(s, { batch: 10 });
      expect(calls, key).toBe(3);
      expect(r.purge.rollups.byTable[key], key).toBe(25);
      expect(r.purge.rollups.drained, key).toBe(true);
    }
  });

  it("every purge receives the batch size it was configured with", async () => {
    const seen: Record<string, number> = {};
    const rec = (k: string) => async (b: number) => ((seen[k] = b), 0);
    const s = fakeStore({
      purgeExpiredEvents: rec("events"),
      purgeExpiredContent: rec("content"),
      purgeOrphanedContent: rec("orphans"),
      purgeRollups: async (b) => ((seen.rollups = b), { minute: 0, hourly: 0, budget: 0, usage: 0 }),
    });
    await runDailyJob(s, { batch: 777 });
    expect(seen).toEqual({ events: 777, content: 777, orphans: 777, rollups: 777 });
  });

  it("defaults: the batch is inside the SQL limit and the purge budget fits the route's maxDuration with room to spare", async () => {
    const { readFileSync } = await import("node:fs");
    expect(DAILY_JOB.batch).toBeGreaterThanOrEqual(1);
    expect(DAILY_JOB.batch).toBeLessThanOrEqual(50_000); // purge_* raise above this
    const maxDuration = Number(/export const maxDuration = (\d+)/.exec(readFileSync("app/api/jobs/daily/route.ts", "utf8"))![1]);
    expect(DAILY_JOB.purgeBudgetMs).toBeLessThanOrEqual(maxDuration * 1000 * 0.75);
    expect(DAILY_JOB.shares.events + DAILY_JOB.shares.content + DAILY_JOB.shares.orphans).toBeLessThan(1);
  });

  it("with no options the run uses the default budget and batch (events get their share of DAILY_JOB.purgeBudgetMs)", async () => {
    let t = 0;
    const sizes: number[] = [];
    const s = fakeStore({
      purgeExpiredEvents: async (b) => {
        sizes.push(b);
        t += 1_000; // each call takes a second
        return b; // never drains
      },
    });
    const r = await runDailyJob(s, { now: () => t });
    expect(sizes[0]).toBe(DAILY_JOB.batch);
    expect(r.purge.events.calls).toBe(Math.ceil((DAILY_JOB.purgeBudgetMs * DAILY_JOB.shares.events) / 1_000));
  });
});
