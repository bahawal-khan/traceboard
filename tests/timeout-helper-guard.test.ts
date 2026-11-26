import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as timeouts from "./helpers/timeouts";

// Test files that run ESLint, start a child process (any use of child_process, which is how Next or eslint would be spawned),
// or are slow for another reason must take their timeout from tests/helpers/timeouts.ts (one source of truth). Static and fast.

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "db" || e.name === "helpers" ? [] : testFiles(p);
    return e.name.endsWith(".test.ts") && e.name !== "timeout-helper-guard.test.ts" ? [p] : [];
  });
}

const ESLINT_IMPORT = /(?:from|import\()\s*["']eslint["']/;
const CHILD_PROCESS_IMPORT = /(?:from|import\(|require\()\s*["'](?:node:)?child_process["']/;
const USES_HELPER = /from\s+["'](?:\.\/helpers\/timeouts|@\/tests\/helpers\/timeouts)["']/;

describe("slow test tools take their timeout from tests/helpers/timeouts.ts", () => {
  const files = testFiles("tests").map((f) => ({ f, src: readFileSync(f, "utf8") }));

  it("finds the test files it is meant to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("a test file that runs ESLint or a child process imports the shared timeout helper", () => {
    const offenders = files.filter(({ src }) => (ESLINT_IMPORT.test(src) || CHILD_PROCESS_IMPORT.test(src)) && !USES_HELPER.test(src)).map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  it("a test file that starts a child process also bounds it with CHILD_KILL_TIMEOUT_MS", () => {
    const offenders = files.filter(({ src }) => CHILD_PROCESS_IMPORT.test(src) && !src.includes("CHILD_KILL_TIMEOUT_MS")).map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  it("the helper keeps the order that makes a hung child die before its test gives up, and is above the 30 s default", () => {
    expect(timeouts.CHILD_KILL_TIMEOUT_MS).toBeLessThan(timeouts.CHILD_PROCESS_TIMEOUT_MS);
    for (const v of Object.values(timeouts)) expect(v).toBeGreaterThan(30_000);
  });
});
