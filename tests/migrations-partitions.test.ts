import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Static guard (no database): the migration that pre-creates event partitions must stay in place. */
describe("event partitions migration (P2.3)", () => {
  const dir = "db/migrations";
  const file = readdirSync(dir).find((f) => /^\d{4}_ingest_partitions\.sql$/.test(f));

  it("exists and creates the current UTC month plus the next three", () => {
    expect(file).toBeDefined();
    const sql = readFileSync(`${dir}/${file}`, "utf8");
    expect(sql).toMatch(/ensure_event_partitions\(\s*\(date_trunc\('month', now\(\) AT TIME ZONE 'UTC'\)\)::date,\s*4\s*\)/);
  });

  it("is registered in the drizzle journal", () => {
    const journal = JSON.parse(readFileSync(`${dir}/meta/_journal.json`, "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain(file!.replace(/\.sql$/, ""));
  });
});

/**
 * Static guard (no database): the live reader's index (P3.8a). It must be created on the PARTITIONED PARENT, like every other
 * events index in 0005, so Postgres attaches it to every existing partition and to every partition created later by
 * ensure_event_partitions / job_ensure_partitions (CREATE TABLE ... PARTITION OF inherits the parent's indexes).
 */
describe("events received_at index migration (P3.8a)", () => {
  const dir = "db/migrations";
  const file = "0013_events_received_idx.sql";
  const code = () =>
    readFileSync(`${dir}/${file}`, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
  const indexStatements = (sql: string) => sql.match(/create\s+(?:unique\s+)?index[^;]*;/gi) ?? [];

  it("creates exactly one index, on the parent table, on (project_id, received_at, id) in that order", () => {
    const stmts = indexStatements(code());
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.replace(/\s+/g, " ")).toBe("CREATE INDEX events_project_received_idx ON events (project_id, received_at, id);");
    expect(code()).not.toMatch(/\b(drop|alter|delete|update|insert)\b/i);
  });

  it("follows the pattern of the existing events indexes: parent table, no partition name, no CONCURRENTLY (not allowed on a partitioned table, and the runner uses a transaction)", () => {
    const stmts = indexStatements(code());
    expect(stmts[0]).not.toMatch(/concurrently/i);
    expect(stmts[0]).not.toMatch(/events_y\d{4}m\d{2}/);
    const base = readFileSync(`${dir}/0005_events_partitions_rls.sql`, "utf8");
    expect(base).toMatch(/CREATE INDEX events_project_time_idx ON events \(project_id, occurred_at DESC\);/);
    expect(base).toMatch(/CREATE INDEX events_project_trace_idx ON events \(project_id, trace_id\);/);
  });

  it("no migration or function creates indexes partition by partition, so the parent's index is the only mechanism for new partitions", () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(`${dir}/${f}`, "utf8").replace(/^\s*--.*$/gm, "");
      expect(sql, f).not.toMatch(/CREATE\s+INDEX[^;]*ON\s+(?:public\.)?events_y/i);
      expect(sql, f).not.toMatch(/CREATE\s+INDEX[^;]*format\(/i);
    }
  });

  it("is registered in the journal after the previous migration, and its snapshot chains to the previous snapshot", () => {
    const journal = JSON.parse(readFileSync(`${dir}/meta/_journal.json`, "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
    const i = journal.entries.findIndex((e) => e.tag === file.replace(/\.sql$/, ""));
    expect(i).toBeGreaterThan(0);
    expect(journal.entries[i]!.idx).toBe(13);
    expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
    const prev = JSON.parse(readFileSync(`${dir}/meta/0012_snapshot.json`, "utf8")) as { id: string };
    const snap = JSON.parse(readFileSync(`${dir}/meta/0013_snapshot.json`, "utf8")) as { id: string; prevId: string };
    expect(snap.prevId).toBe(prev.id);
    expect(snap.id).not.toBe(prev.id);
  });
});
