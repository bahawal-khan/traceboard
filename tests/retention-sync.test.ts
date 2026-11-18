import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RETENTION } from "@/lib/quotas";

/** The SQL function hard-codes the retention; this keeps it in step with lib/quotas.ts. */
describe("event retention constant", () => {
  const sql = readFileSync("db/migrations/0005_events_partitions_rls.sql", "utf8");

  it("matches RETENTION.eventsDays in lib/quotas.ts", () => {
    expect(sql).toContain(`retention CONSTANT interval := INTERVAL '${RETENTION.eventsDays} days'`);
  });

  it("drop_old_event_partitions takes no arguments and is granted without any", () => {
    expect(sql).toContain("CREATE FUNCTION drop_old_event_partitions() RETURNS int");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION drop_old_event_partitions() TO app_rw;");
    expect(sql).not.toMatch(/drop_old_event_partitions\(\s*(int|integer|p_)/i);
  });
});
