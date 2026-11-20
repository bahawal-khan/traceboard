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
