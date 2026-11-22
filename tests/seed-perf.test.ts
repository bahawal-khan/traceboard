import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clampWindow } from "@/lib/repo/metrics";
import { TRACE_LIMITS, traceListStatement } from "@/lib/repo/traces";
import type { Tx } from "@/lib/repo/tenant";
import {
  DAYS, DEFAULT_ROWS, HOUR_WEIGHTS, MAX_ROWS, SEED_TAG, UsageError, cleanupWindows, deleteSeed, insertSeed, neededPartitions, parseArgs, planDays,
  projectCheck, scope, storageReport,
} from "../scripts/seed-perf-lib.mjs";
import { LIST_SQL, SCAN_CAP, listParams, listWindow } from "../scripts/traces-explain-sql.mjs";

/** Pure parts of scripts/seed-perf.mjs and scripts/explain-traces.mjs. The scripts themselves talk to the database and are run by the owner. */
const PID = "11111111-1111-4111-8111-111111111111";
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 22, 12, 30, 0); // a Sunday

type Rec = { sql: string; values: unknown[] };
const rec = ((s: TemplateStringsArray, ...v: unknown[]): Rec => ({ sql: s.join("?").replace(/\s+/g, " ").trim(), values: v })) as unknown as Tx;
const recN = ((s: TemplateStringsArray, ...v: unknown[]) => ({ text: s.reduce((a, p, i) => a + p + (i < v.length ? `$${i + 1}` : ""), "").replace(/\s+/g, " ").trim(), values: v })) as unknown as Tx;
const q = (x: unknown) => x as Rec;

describe("parseArgs", () => {
  it("requires a UUID project, defaults to 30,000 rows, lowercases the id", () => {
    expect(parseArgs(["--project", PID.toUpperCase()])).toEqual({ project: PID, rows: DEFAULT_ROWS, cleanup: false, analyze: false, dryRun: false });
    expect(parseArgs([`--project=${PID}`, "--rows=100000", "--dry-run"])).toMatchObject({ project: PID, rows: 100_000, dryRun: true });
    expect(DEFAULT_ROWS).toBe(30_000);
  });
  it.each([
    [[]], [["--rows", "5"]], [["--project"]], [["--project", "not-a-uuid"]], [["--project", PID, "--rows", "0"]],
    [["--project", PID, "--rows", String(MAX_ROWS + 1)]], [["--project", PID, "--rows", "12abc"]], [["--project", PID, "--rows", "1e5"]],
    [["--project", PID, "--rows", "-4"]], [["--project", PID, "--bogus"]], [["--project", PID, "--rows"]],
    [["--project", PID, "--cleanup", "--analyze"]], [["--project", PID, "--cleanup", "--dry-run"]], [["--project", "--cleanup"]],
  ])("rejects %j with a usage error", (argv) => {
    expect(() => parseArgs(argv as string[])).toThrow(UsageError);
  });
  it("accepts --cleanup and --analyze alone", () => {
    expect(parseArgs(["--project", PID, "--cleanup"]).cleanup).toBe(true);
    expect(parseArgs(["--project", PID, "--analyze"]).analyze).toBe(true);
  });
});

describe("planDays", () => {
  const seeded = (n: number) => {
    let x = n;
    return () => ((x = (x * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  };
  it("adds up to EXACTLY the requested rows, for odd sizes too", () => {
    for (const rows of [1, 13, 14, 15, 999, 30_000, 100_000, 26_601]) {
      for (const seed of [1, 7, 99]) {
        const plan = planDays(rows, NOW, seeded(seed));
        expect(plan).toHaveLength(DAYS);
        expect(plan.reduce((a, d) => a + d.budget, 0), `${rows}/${seed}`).toBe(rows);
        expect(plan.every((d) => Number.isInteger(d.budget) && d.budget >= 0)).toBe(true);
      }
    }
  });
  it("covers a contiguous range that sits inside listTraces' 14-day window and never touches the future", () => {
    const plan = planDays(30_000, NOW);
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.fromMs).toBeCloseTo(plan[i - 1]!.toMs, -1);
    expect(plan.at(-1)!.toMs).toBeLessThanOrEqual(NOW - 60_000);
    expect(plan[0]!.fromMs).toBeGreaterThanOrEqual(listWindow(NOW).fromMs + HOUR);
  });
  it("has the shape of real traffic: weekend slices are lighter than weekday slices", () => {
    const plan = planDays(100_000, NOW, () => 0.5);
    const dow = (d: { fromMs: number; toMs: number }) => new Date((d.fromMs + d.toMs) / 2).getUTCDay();
    const weekend = plan.filter((d) => [0, 6].includes(dow(d))).map((d) => d.budget);
    const weekday = plan.filter((d) => ![0, 6].includes(dow(d))).map((d) => d.budget);
    expect(weekend.length).toBeGreaterThan(0);
    expect(Math.max(...weekend)).toBeLessThan(Math.min(...weekday));
  });
  it("the hour curve is not flat and has 24 entries", () => {
    expect(HOUR_WEIGHTS).toHaveLength(24);
    expect(Math.max(...HOUR_WEIGHTS) / Math.min(...HOUR_WEIGHTS)).toBeGreaterThan(5);
  });
  it("names the monthly partitions the window touches", () => {
    expect(neededPartitions(Date.UTC(2026, 10, 10), Date.UTC(2026, 10, 22))).toEqual(["events_y2026m11"]);
    expect(neededPartitions(Date.UTC(2026, 9, 25), Date.UTC(2026, 10, 8))).toEqual(["events_y2026m10", "events_y2026m11"]);
    expect(neededPartitions(Date.UTC(2026, 11, 25), Date.UTC(2027, 0, 8))).toEqual(["events_y2026m12", "events_y2027m01"]);
  });
});

describe("the seed statement", () => {
  const stmt = q(insertSeed(rec, { pid: PID, fromIso: "2026-11-21T00:00:00.000Z", toIso: "2026-11-22T00:00:00.000Z", budget: 2_000, hourWeights: HOUR_WEIGHTS.join(",") }));
  it("writes ONLY the events table, nothing else, and never deletes or updates", () => {
    expect([...stmt.sql.matchAll(/\binsert into (\w+)/g)].map((m) => m[1])).toEqual(["events"]);
    expect(stmt.sql).not.toMatch(/\b(delete|update|drop|truncate|alter|grant)\b/i);
  });
  it("binds the project, window, budget, weights and tag; none is part of the text", () => {
    expect(stmt.values).toEqual([PID, "2026-11-21T00:00:00.000Z", "2026-11-22T00:00:00.000Z", 2_000, HOUR_WEIGHTS.join(","), SEED_TAG]);
    expect(stmt.sql).not.toContain(PID);
    expect(stmt.sql).not.toContain(SEED_TAG);
  });
  it("tags every row, uses the one project for every row, and keeps timestamps in the past of the window end", () => {
    expect(stmt.sql).toContain("array[w.tag]");
    expect(stmt.sql).toContain("select gen_random_uuid(), w.pid,");
    expect(stmt.sql).toMatch(/least\(w\.wt, date_trunc/); // slots never extend past the window end
  });
  it("produces the mix the measurement needs: roots, orphans, failures, unpriced models, 1 to 12 spans", () => {
    for (const piece of ["r_orphan < 0.05", "r_fail < 0.07", "'acme-internal-7b'", "least(11.99", "'lost-'", "-ln(1 - random())"]) expect(stmt.sql).toContain(piece);
  });
  it("leaves the cost of the unpriced model and of non-LLM spans NULL", () => {
    expect(stmt.sql).toContain("when kind = 'llm' and model_ <> 'acme-internal-7b'");
  });
});

describe("the cleanup statement", () => {
  const stmt = q(deleteSeed(rec, { pid: PID, fromIso: "2026-11-01T00:00:00.000Z", toIso: "2026-11-02T00:00:00.000Z" }));
  it("is ONE delete on events, fenced by the project AND the tag AND a time window", () => {
    expect(stmt.sql).toMatch(/^with d as \( delete from events where project_id = \?::uuid and tags @> array\[\?\]::text\[\] and occurred_at >= \?::timestamptz and occurred_at < \?::timestamptz returning 1 \) select count\(\*\)::int as n from d$/);
    expect(stmt.values).toEqual([PID, SEED_TAG, "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"]);
    expect((stmt.sql.match(/delete from/g) ?? []).length).toBe(1);
  });
  it("scopes the transaction to exactly the one project", () => {
    const s = q(scope(rec, PID));
    expect(s.values).toEqual([PID]);
    expect(s.sql).toContain("set_config('app.project_ids', ?, true)");
    expect(s.sql).toContain("set_config('app.owner_id', '', true)");
  });
  it("windows cover the whole seed range and the next hour, are contiguous and each is one day", () => {
    const ws = cleanupWindows(NOW);
    expect(ws[0]!.fromMs).toBeLessThan(NOW - 14 * 24 * HOUR);
    expect(ws.at(-1)!.toMs).toBeGreaterThanOrEqual(NOW);
    for (let i = 1; i < ws.length; i++) expect(ws[i]!.fromMs).toBe(ws[i - 1]!.toMs);
    expect(ws.every((w) => w.toMs - w.fromMs === 24 * HOUR)).toBe(true);
  });
  it("the report and the project check only read", () => {
    for (const s of [q(projectCheck(rec, PID)), q(storageReport(rec, PID))]) expect(s.sql).not.toMatch(/\b(insert|update|delete|drop|truncate)\b/i);
    expect(q(storageReport(rec, PID)).sql).toContain("pg_partition_tree('events')");
  });
});

describe("the scripts", () => {
  const files = ["scripts/seed-perf.mjs", "scripts/seed-perf-lib.mjs", "scripts/explain-traces.mjs", "scripts/traces-explain-sql.mjs"];
  const src = Object.fromEntries(files.map((f) => [f, readFileSync(f, "utf8")]));
  it("never print or log the environment, a connection string or a password", () => {
    for (const [f, s] of Object.entries(src)) {
      const logs = s.split("\n").filter((l) => /console\.(log|error|warn|info|debug)/.test(l));
      for (const l of logs) expect(l, `${f}: ${l}`).not.toMatch(/process\.env|_URL|\burl\b|password|connection string|JSON\.stringify\(process/i);
      expect(s, f).not.toMatch(/readFileSync|loadEnvFile|process\.env\)/); // credentials only by name, only from the environment
    }
  });
  it("the only DELETE in any script is the fenced one in the lib, and nothing drops or truncates", () => {
    expect((src["scripts/seed-perf-lib.mjs"]!.match(/delete from/g) ?? []).length).toBe(1);
    for (const f of ["scripts/seed-perf.mjs", "scripts/explain-traces.mjs", "scripts/traces-explain-sql.mjs"]) expect(src[f], f).not.toMatch(/delete from|\bdrop\s+(table|partition|index)|\btruncate\s+table/i);
    expect(src["scripts/seed-perf.mjs"]).not.toMatch(/\bgrant\b|\balter\b/i);
  });
  it("cleanup runs as the migrator, the seed as app_rw, and the project is required before anything is written", () => {
    const s = src["scripts/seed-perf.mjs"]!;
    expect(s).toMatch(/args\.cleanup\)[\s\S]*connect\("MIGRATION_DATABASE_URL"\)[\s\S]*requireProject/);
    expect(s).toMatch(/const sql = connect\("DATABASE_URL"\);\nawait requireProject\(sql\)/);
    expect(s).toContain("is_demo");
  });
});

describe("explain-traces stays in step with lib/repo/traces.ts", () => {
  const args = { pid: PID, fromIso: "F", toIso: "T", scanLimit: SCAN_CAP + 1, cap: SCAN_CAP, cursorStart: "S", cursorTrace: "TR", status: "error", fetchLimit: 51 };
  const real = traceListStatement(recN, args) as unknown as { text: string; values: unknown[] };
  it("has the same statement text (placeholders numbered in order)", () => {
    expect(LIST_SQL.replace(/\s+/g, " ").trim()).toBe(real.text);
  });
  it("passes the same parameters in the same order", () => {
    const w = listWindow(NOW);
    const p = listParams({ projectId: PID, fromMs: w.fromMs, toMs: w.toMs, cursor: { start: "S", traceId: "TR" }, status: "error", limit: 50 });
    expect(p.map((v, i) => (i === 1 || i === 2 ? "<iso>" : v))).toEqual(real.values.map((v, i) => (i === 1 || i === 2 ? "<iso>" : v)));
  });
  it("uses the same scan cap and the same 14-day window as listTraces", () => {
    expect(SCAN_CAP).toBe(TRACE_LIMITS.maxScanRows);
    const w = listWindow(NOW);
    const c = clampWindow({ fromMs: NOW - 14 * 24 * HOUR, toMs: NOW }, { bucketMs: TRACE_LIMITS.bucketMs, maxWindowMs: TRACE_LIMITS.maxWindowMs, nowMs: NOW });
    expect(w).toEqual({ fromMs: c.fromMs, toMs: c.toMs });
  });
  it("the first page binds null cursor and null status", () => {
    const p = listParams({ projectId: PID, fromMs: 0, toMs: 1 });
    expect(p.slice(5, 11)).toEqual([null, null, null, null, null, 51]);
  });
});
