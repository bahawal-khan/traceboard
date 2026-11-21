import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QUOTAS, RETENTION, SIZING } from "@/lib/quotas";

/**
 * Static checks of db/migrations/0011_daily_job_sql.sql (no database needed). The SQL hard-codes its retention windows (a
 * caller cannot choose them), so these tests keep the numbers in step with lib/quotas.ts, and they guard the properties that
 * make the destructive functions safe to hand to a role: pinned search_path, explicit REVOKE FROM PUBLIC, a single grantee.
 */
const sql = readFileSync("db/migrations/0011_daily_job_sql.sql", "utf8");
const create = [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION\s+([a-z_]+)\s*\(([^)]*)\)/g)].map((m) => ({ name: m[1]!, args: m[2]!.trim() }));
const body = (fn: string) => {
  const start = sql.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${fn}\\s*\\(`));
  const next = sql.slice(start + 10).search(/\nCREATE (?:OR REPLACE )?FUNCTION /);
  return sql.slice(start, next === -1 ? undefined : start + 10 + next);
};
const names = create.map((c) => c.name);
/** The statements without comment lines (comments talk about PUBLIC and app_rw on purpose). */
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("0011 daily job SQL: retention constants match lib/quotas.ts", () => {
  it("events: 14 days, in the purge function, the drop policy and the cutoff guard", () => {
    expect(body("purge_expired_events")).toContain(`retention CONSTANT interval := INTERVAL '${RETENTION.eventsDays} days'`);
    expect(body("event_partition_is_droppable")).toContain(`INTERVAL '${RETENTION.eventsDays} days'`);
  });
  it("rollups: 48 hours, 90 days, 400 days, 7 day keys and 2 month keys", () => {
    const b = body("purge_rollups");
    expect(b).toContain(`now() - INTERVAL '${RETENTION.minuteRollupsHours} hours'`);
    expect(b).toContain(`now() - INTERVAL '${RETENTION.hourlyRollupsDays} days'`);
    expect(b).toContain(`::date - ${RETENTION.usageDailyDays}`);
    expect(b).toContain(`::date - ${RETENTION.budgetDayKeysDays},`);
    expect(b).toContain(`- INTERVAL '${RETENTION.budgetMonthKeysMonths} months'`);
  });
  it("storage guard: the events budget is database size x events share", () => {
    const budget = SIZING.databaseBytes * SIZING.eventsShare;
    expect(budget).toBe(600_000_000);
    expect(body("storage_report")).toContain(`${budget}::bigint`);
    expect(body("storage_report")).toContain(`/ ${budget}.0`);
  });
  it("the content cap is a parameter, not a default baked into SQL (one place: QUOTAS)", () => {
    expect(QUOTAS.contentRowsPerDayPerProject).toBe(200);
    expect(body("content_slots_left")).toContain("content_slots_left(p_project_id uuid, p_cap int)");
    expect(body("content_slots_left")).not.toMatch(/p_cap int\s+DEFAULT/i);
    expect(body("content_slots_left")).not.toContain("200");
  });
});

describe("0011 daily job SQL: every function is locked down", () => {
  it("creates the expected functions and nothing unreviewed", () => {
    expect(names.sort()).toEqual([
      "content_slots_left", "drop_old_event_partitions", "event_partition_is_droppable", "events_partition_health", "job_ensure_partitions",
      "purge_expired_content", "purge_expired_events", "purge_orphaned_content", "purge_rollups", "storage_report",
    ]);
  });
  it("pins search_path on every function", () => {
    for (const c of create) expect(body(c.name), c.name).toContain("SET search_path = pg_catalog, public");
  });
  it("every function except the cap helper and the pure policy is SECURITY DEFINER", () => {
    for (const c of create.filter((f) => !["content_slots_left", "event_partition_is_droppable"].includes(f.name))) expect(body(c.name), c.name).toContain("SECURITY DEFINER");
    expect(body("content_slots_left")).not.toContain("SECURITY DEFINER"); // invoker rights: RLS applies
  });
  it("revokes EXECUTE from PUBLIC explicitly for every function it creates, and for ensure_event_partitions", () => {
    for (const c of create) expect(sql, c.name).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${c.name}\\([^)]*\\) FROM PUBLIC;`));
    expect(sql).toContain("REVOKE ALL ON FUNCTION ensure_event_partitions(date, int) FROM PUBLIC;");
  });
  it("takes EXECUTE away from app_rw on the 0005 functions", () => {
    expect(sql).toContain("REVOKE ALL ON FUNCTION ensure_event_partitions(date, int) FROM app_rw;");
    expect(sql).toContain("REVOKE ALL ON FUNCTION drop_old_event_partitions() FROM app_rw;");
  });
  it("grants EXECUTE to app_job on every job function, and to app_rw ONLY on content_slots_left", () => {
    const grants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION ([a-z_]+)\([^)]*\) TO ([a-z_]+);/g)].map((m) => `${m[1]}:${m[2]}`);
    const toRw = grants.filter((g) => g.endsWith(":app_rw"));
    expect(toRw).toEqual(["content_slots_left:app_rw"]);
    for (const n of names.filter((x) => x !== "content_slots_left")) expect(grants, n).toContain(`${n}:app_job`);
    expect(grants.filter((g) => !g.endsWith(":app_job") && !g.endsWith(":app_rw"))).toEqual([]); // nobody else, and never PUBLIC
    expect(code).not.toMatch(/GRANT[^;]*\bTO PUBLIC\b/i);
  });
  it("gives app_job no table privilege except app_state (select, insert, update)", () => {
    const tableGrants = [...sql.matchAll(/GRANT ([A-Z, ]+) ON (?!FUNCTION)([a-z_]+) TO app_job;/g)].map((m) => `${m[2]}:${m[1]}`);
    expect(tableGrants).toEqual(["app_state:SELECT, INSERT, UPDATE"]);
  });
  it("maintenance policies are for the migrator role only", () => {
    const policies = [...sql.matchAll(/CREATE POLICY (\w+) ON %I FOR (\w+) TO (\w+) USING \(true\)/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}`);
    expect(policies.sort()).toEqual(["maintenance_delete:DELETE:migrator", "maintenance_select:SELECT:migrator"]);
    expect(code).not.toMatch(/CREATE POLICY[^;]*TO (app_rw|PUBLIC|app_job)/i);
    expect(code).not.toMatch(/FOR (ALL|UPDATE|INSERT)/); // never wider than select/delete
  });
});

describe("0011 daily job SQL: bounded, idempotent, no caller-chosen windows", () => {
  it("every purge function validates its batch size (1..50000) and deletes through a LIMITed ctid subselect", () => {
    for (const f of ["purge_expired_events", "purge_expired_content", "purge_orphaned_content", "purge_rollups"]) {
      expect(body(f), f).toMatch(/p_batch < 1 OR p_batch > 50000/);
    }
    for (const f of ["purge_expired_content", "purge_orphaned_content", "purge_rollups"]) expect(body(f), f).toMatch(/ctid = ANY \(ARRAY\(/);
    expect(body("purge_expired_events")).toContain("LIMIT $2");
    expect((body("purge_rollups").match(/LIMIT p_batch/g) ?? []).length).toBe(4); // one bounded statement per rollup table
    expect((body("purge_rollups").match(/GET DIAGNOSTICS/g) ?? []).length).toBe(4);
  });
  it("purge_expired_events only accepts a cutoff at or before the retention boundary", () => {
    const b = body("purge_expired_events");
    expect(b).toContain("IF v_cutoff > v_newest THEN");
    expect(b).toContain("p_cutoff timestamptz DEFAULT NULL");
  });
  it("the drop policy never qualifies the current or next month (month guard) and the cutoff stays at 14 days", () => {
    const b = body("event_partition_is_droppable");
    expect(b).toContain("p_upper <= (date_trunc('month', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')");
    expect(body("drop_old_event_partitions")).toContain("event_partition_is_droppable(r.upper_bound, now())");
    expect(body("drop_old_event_partitions")).toContain("SET lock_timeout");
  });
  it("fails loudly, before changing anything, when the app_job role does not exist", () => {
    const head = sql.slice(0, sql.indexOf("ALTER TABLE usage_daily"));
    expect(head).toContain("rolname = 'app_job'");
    expect(head).toContain("RAISE EXCEPTION 'role app_job does not exist");
  });
  it("the partition functions take no caller-chosen retention", () => {
    expect(body("drop_old_event_partitions")).toContain("drop_old_event_partitions() RETURNS int");
    expect(body("job_ensure_partitions")).toContain(", 2)"); // current and next month only
    expect(body("job_ensure_partitions")).toContain("date_trunc('month', now() AT TIME ZONE 'UTC')");
  });
  it("dynamic SQL uses identifiers from the catalog through %I only, never caller input", () => {
    for (const m of sql.matchAll(/EXECUTE format\(([^;]*?)\)(?: USING[^;]*)?;/g)) {
      expect(m[1], "format string").not.toMatch(/\|\|/);
      expect(m[1]).not.toMatch(/%s/);
    }
    expect(sql).not.toMatch(/^\s+EXECUTE\s+(?!format)/m); // no dynamic SQL built any other way
  });
  it("every purge function validates its batch to 1..50000, so a caller can never ask for an unbounded delete", () => {
    for (const fn of ["purge_expired_events", "purge_expired_content", "purge_orphaned_content", "purge_rollups"]) {
      expect(body(fn), fn).toContain("p_batch IS NULL OR p_batch < 1 OR p_batch > 50000 THEN"); // " THEN" so 500000 does not match
    }
    expect(sql.match(/p_batch > 50000 THEN/g)).toHaveLength(4);
  });
  it("the orphan check keys on project AND event id", () => {
    expect(body("purge_orphaned_content")).toContain("e.project_id = c.project_id AND e.event_id = c.event_id");
  });
  it("is registered in the drizzle journal after 0010", () => {
    const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.tag === "0011_daily_job_sql")).toMatchObject({ idx: 11 });
    const snap = JSON.parse(readFileSync("db/migrations/meta/0011_snapshot.json", "utf8")) as { prevId: string; tables: Record<string, { columns: Record<string, unknown> }> };
    const prev = JSON.parse(readFileSync("db/migrations/meta/0010_snapshot.json", "utf8")) as { id: string };
    expect(snap.prevId).toBe(prev.id);
    expect(snap.tables["public.usage_daily"]!.columns).toHaveProperty("content_rows");
  });
});
