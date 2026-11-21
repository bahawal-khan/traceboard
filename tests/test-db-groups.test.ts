import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allDbTests, buildVitestArgs, loadGroups, resolveFiles, validateGroups } from "../scripts/test-db-lib.mjs";

const groups = loadGroups() as Record<string, string[]>;

describe("db test groups (tests/db/groups.json)", () => {
  it("partition the db test files exactly: every file in exactly one group, none unknown", () => {
    expect(validateGroups(groups)).toEqual([]);
    const listed = Object.values(groups).flat().sort();
    expect(listed).toEqual(allDbTests());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("validateGroups reports a file in no group, in two groups, and an unknown name", () => {
    const files = ["a", "b", "c"];
    expect(validateGroups({ x: ["a"], y: ["b"] }, files)).toEqual(["tests/db/c.test.ts is in no group (add it to tests/db/groups.json)"]);
    expect(validateGroups({ x: ["a", "b"], y: ["b", "c"] }, files)).toEqual(['"b" is in both "x" and "y"']);
    expect(validateGroups({ x: ["a", "b", "c", "ghost"] }, files)).toEqual(['group "x" lists "ghost", which is not a file in tests/db']);
  });

  it("resolves a group, a single file (with or without path and suffix), and all", () => {
    expect(resolveFiles("jobs", groups)).toEqual(["tests/db/daily-job.test.ts", "tests/db/storage-guard.test.ts"]);
    expect(resolveFiles("rls", groups)).toEqual(["tests/db/rls.test.ts"]);
    expect(resolveFiles("tests/db/roles.test.ts", groups)).toEqual(["tests/db/roles.test.ts"]);
    expect(resolveFiles("all", groups)).toEqual([]);
    expect(() => resolveFiles("nope", groups)).toThrow(/unknown selector/);
  });

  it("always runs the db PROJECT with vitest (serial files, global setup, retry setup), and never adds a parallelism option", () => {
    expect(buildVitestArgs(["tests/db/rls.test.ts"], ["-t", "x"])).toEqual(["vitest", "run", "--project", "db", "tests/db/rls.test.ts", "-t", "x"]);
    expect(buildVitestArgs([])).toEqual(["vitest", "run", "--project", "db"]);
    const runner = readFileSync("scripts/test-db.mjs", "utf8");
    expect(runner).not.toMatch(/Promise\.all|--pool|--poolOptions|maxWorkers|--no-isolate|fileParallelism/);
    expect(runner.match(/spawnSync\("npx"/g)).toHaveLength(1); // exactly one vitest process per invocation
  });

  it("the db project stays serial in vitest.config.mts, and the plain test:db script is unchanged", () => {
    const cfg = readFileSync("vitest.config.mts", "utf8");
    expect(cfg).toMatch(/name: "db"[\s\S]*fileParallelism: false/);
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    expect(scripts["test:db"]).toBe("vitest run --project db");
    expect(scripts.test).toBe("vitest run");
  });

  it("has one npm script per group, plus the timed full run", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    for (const g of Object.keys(groups)) expect(scripts[`test:db:${g}`]).toBe(`node scripts/test-db.mjs ${g}`);
    expect(scripts["test:db:timed"]).toBe("node scripts/test-db.mjs all --timing");
  });
});
