import { describe, expect, it } from "vitest";
import { checkCteOrder } from "./helpers/cte-order";

const T = ["t", "u_table"];

describe("checkCteOrder (the checker itself)", () => {
  it("accepts CTEs that only read earlier CTEs and known tables, including data-modifying ones read through RETURNING", () => {
    const sql = `with a as (select 1 as x from t), b as (insert into u_table select x from a returning 1), c as (select count(*) from b) select (select count(*) from c) from a`;
    expect(checkCteOrder(sql, T)).toEqual({ names: ["a", "b", "c"], problems: [] });
  });

  it("flags a CTE that reads one defined LATER (the P2.11c1 bug: u read c, defined after it)", () => {
    const sql = `with a as (select 1 from t), u as (insert into u_table select (select count(*) from c)), c as (insert into u_table select 1 from a returning 1) select 1 from u`;
    expect(checkCteOrder(sql, T).problems).toEqual([{ cte: "u", ref: "c", kind: "defined_later" }]);
  });

  it("flags a reference to a CTE or table that does not exist, in a CTE body and in the final select", () => {
    const sql = `with a as (select 1 from missing_cte) select 1 from a join nope n on true`;
    expect(checkCteOrder(sql, T).problems).toEqual([
      { cte: "a", ref: "missing_cte", kind: "unknown_relation" },
      { cte: "<final select>", ref: "nope", kind: "unknown_relation" },
    ]);
  });

  it("flags a self reference and a duplicate CTE name", () => {
    expect(checkCteOrder(`with a as (select 1 from a) select 1 from a`, T).problems).toContainEqual({ cte: "a", ref: "a", kind: "self_reference" });
    expect(checkCteOrder(`with a as (select 1 from t), a as (select 1 from t) select 1 from a`, T).problems).toContainEqual({ cte: "a", ref: "a", kind: "duplicate_name" });
  });

  it("ignores table functions, subselect parentheses, string literals and comments", () => {
    const sql = `with a as (select * from jsonb_to_recordset('from later_thing') as r(x int)), b as (select 1 from (select 1 from a) q -- from ghost
      ) select 1 from b`;
    expect(checkCteOrder(sql, T).problems).toEqual([]);
  });

  it("rejects text that is not a WITH statement", () => {
    expect(() => checkCteOrder("select 1", T)).toThrow(/WITH/);
  });
});
