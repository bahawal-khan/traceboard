import { describe, expect, it, vi } from "vitest";
import { cleanupOwners } from "@/tests/db/helpers/cleanup";

type Stmt = { text: string; values: unknown[] };
const tagged = (strings: TemplateStringsArray, ...values: unknown[]): Stmt => ({ text: strings.join("?"), values });

function fakeSql(failures: Array<(txIndex: number) => boolean> = []) {
  const transactions: Stmt[][] = [];
  const sql = {
    transaction: vi.fn(async (build: (t: typeof tagged) => Stmt[]) => {
      const stmts = build(tagged);
      transactions.push(stmts);
      if (failures.some((f) => f(transactions.length))) throw new Error("boom");
      return stmts.map(() => []);
    }),
  };
  return { sql: sql as never, transactions, calls: sql.transaction };
}

describe("cleanupOwners", () => {
  it("does nothing for no users", async () => {
    const { sql, calls } = fakeSql();
    await cleanupOwners(sql, []);
    expect(calls).not.toHaveBeenCalled();
  });

  it("removes ALL users in a single transaction (one round trip), each with its own context, delete and slot release", async () => {
    const { sql, calls, transactions } = fakeSql();
    await cleanupOwners(sql, ["u1", "u2", "u3"]);
    expect(calls).toHaveBeenCalledTimes(1);
    const stmts = transactions[0]!;
    expect(stmts).toHaveLength(9);
    ["u1", "u2", "u3"].forEach((u, i) => {
      const [ctx, del, release] = stmts.slice(i * 3, i * 3 + 3) as [Stmt, Stmt, Stmt];
      expect(ctx.text).toContain("set_config('app.owner_id'");
      expect(ctx.text).toContain("set_config('app.project_ids', ''");
      expect(ctx.values).toEqual([u]);
      expect(del.text).toBe("delete from projects where owner_id = ?");
      expect(del.values).toEqual([u]);
      expect(release.text).toBe("select release_user_slot()");
    });
  });

  it("falls back to one transaction per user when the batch fails, and cleans every user it can", async () => {
    const { sql, calls, transactions } = fakeSql([(n) => n === 1]); // only the batch fails
    await cleanupOwners(sql, ["u1", "u2"]);
    expect(calls).toHaveBeenCalledTimes(3); // the batch, then u1, then u2
    expect(transactions[1]!.map((s) => s.values[0])).toContain("u1");
    expect(transactions[2]!.map((s) => s.values[0])).toContain("u2");
  });

  it("rethrows the first error if a user still cannot be cleaned, after trying all of them", async () => {
    const { sql, calls } = fakeSql([(n) => n <= 2]); // the batch and u1 fail, u2 works
    await expect(cleanupOwners(sql, ["u1", "u2"])).rejects.toThrow("boom");
    expect(calls).toHaveBeenCalledTimes(3);
  });
});
