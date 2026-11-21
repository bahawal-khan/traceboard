import { describe, expect, it } from "vitest";
import { createFetchTimer, statementHead } from "@/tests/helpers/db-timing";

describe("statementHead", () => {
  it("returns the first 60 characters of the statement, from a single query or a transaction body", () => {
    expect(statementHead(JSON.stringify({ query: "select 1", params: ["secret-param"] }))).toBe("select 1");
    expect(statementHead(JSON.stringify({ queries: [{ query: "select set_config('a', $1, true)", params: [] }, { query: "delete from x" }] }))).toBe("select set_config('a', $1, true)");
    expect(statementHead(JSON.stringify({ query: "x".repeat(200) }))).toHaveLength(60);
  });
  it("never includes parameters and tolerates anything that is not a JSON string body", () => {
    expect(statementHead(JSON.stringify({ query: "select $1", params: ["PARAM-VALUE"] }))).not.toContain("PARAM-VALUE");
    for (const v of [undefined, null, 5, {}, "", "not json", Buffer.from("x")]) expect(statementHead(v)).toBe("");
  });
  it("handles escaped quotes and newlines in the statement", () => {
    expect(statementHead(JSON.stringify({ query: 'select "a"\n  from t' }))).toBe('select \\"a\\" from t');
  });
});

describe("createFetchTimer", () => {
  const clock = (...ticks: number[]) => {
    let i = 0;
    return () => ticks[Math.min(i++, ticks.length - 1)]!;
  };

  it("counts round trips, sums and maxes their time, and keeps the 3 slowest with their statement head", async () => {
    // each call reads the clock twice (start, end): durations 10, 40, 5, 25
    const timer = createFetchTimer(clock(0, 10, 100, 140, 200, 205, 300, 325));
    const fetchFn = timer.wrap(async () => "ok");
    for (const q of ["a", "b", "c", "d"]) expect(await fetchFn("https://x/sql", { body: JSON.stringify({ query: q }) })).toBe("ok");
    const s = timer.snapshot();
    expect(s).toMatchObject({ roundTrips: 4, failures: 0, totalMs: 80, maxMs: 40 });
    expect(s.slowest).toEqual([{ ms: 40, head: "b" }, { ms: 25, head: "d" }, { ms: 10, head: "a" }]);
  });

  it("is transparent: the response is returned as is, an error is rethrown unchanged, and failures are counted", async () => {
    const timer = createFetchTimer(clock(0, 1, 2, 3, 4, 5));
    const boom = new TypeError("fetch failed");
    const response = { status: 200 };
    expect(await timer.wrap(async () => response)("u", {})).toBe(response);
    await expect(timer.wrap(async () => { throw boom; })("u", {})).rejects.toBe(boom);
    expect(timer.snapshot()).toMatchObject({ roundTrips: 2, failures: 1 });
  });

  it("passes the request through untouched", async () => {
    const seen: unknown[] = [];
    const timer = createFetchTimer();
    const init = { method: "POST", body: JSON.stringify({ query: "select 1", params: [1] }), headers: { a: "b" } };
    await timer.wrap(async (input, i) => { seen.push(input, i); return null; })("https://h/sql", init);
    expect(seen).toEqual(["https://h/sql", init]);
    expect(seen[1]).toBe(init);
  });

  it("the snapshot is a copy", async () => {
    const timer = createFetchTimer();
    await timer.wrap(async () => 1)("u", { body: JSON.stringify({ query: "q" }) });
    const s = timer.snapshot();
    s.slowest.length = 0;
    expect(timer.snapshot().slowest).toHaveLength(1);
  });
});

describe("the timing hook in tests/setup-db-retry.ts", () => {
  it("is opt-in (DB_TEST_TIMING=1), sits below the retry layer, and only writes under test-results/", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("tests/setup-db-retry.ts", "utf8");
    expect(src).toContain('process.env.DB_TEST_TIMING === "1"');
    expect(src).toMatch(/withConnectionRetry\(timing \? timing\.wrap\(baseFetch\) : baseFetch\)/); // every attempt is counted; off = the original fetch
    expect(src).toContain('"test-results/db-timing.jsonl"');
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\/test-results\/$/m);
  });
});
