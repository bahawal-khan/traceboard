// Pure helpers for scripts/test-db.mjs (unit tested in tests/test-db-groups.test.ts).
import { readFileSync, readdirSync } from "node:fs";

export const GROUPS_FILE = "tests/db/groups.json";

export function loadGroups(path = GROUPS_FILE) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Every db test file name (without `.test.ts`), sorted. */
export function allDbTests(dir = "tests/db") {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => f.replace(/\.test\.ts$/, ""))
    .sort();
}

/**
 * The groups must PARTITION the db tests: every file in exactly one group, none unknown. A new test file that is in no group, or in
 * two, is an error here (and in the unit test), so no db test can be left out of a grouped run by accident.
 */
export function validateGroups(groups, files = allDbTests()) {
  const seen = new Map();
  const problems = [];
  for (const [name, members] of Object.entries(groups)) {
    for (const m of members) {
      if (!files.includes(m)) problems.push(`group "${name}" lists "${m}", which is not a file in tests/db`);
      if (seen.has(m)) problems.push(`"${m}" is in both "${seen.get(m)}" and "${name}"`);
      seen.set(m, name);
    }
  }
  for (const f of files) if (!seen.has(f)) problems.push(`tests/db/${f}.test.ts is in no group (add it to ${GROUPS_FILE})`);
  return problems;
}

/** The test files a selector means: a group name, "all" (empty list = the whole db project), or file names / paths. */
export function resolveFiles(selector, groups) {
  if (selector === "all") return [];
  if (groups[selector]) return groups[selector].map((f) => `tests/db/${f}.test.ts`);
  const files = allDbTests();
  const name = selector.replace(/^tests\/db\//, "").replace(/\.test\.ts$/, "");
  if (files.includes(name)) return [`tests/db/${name}.test.ts`];
  throw new Error(`unknown selector "${selector}": use all, ${Object.keys(groups).join(", ")}, or a file name from tests/db`);
}

/** vitest arguments. Always the db project (serial files, its global setup); never a --no-file-parallelism override needed. */
export function buildVitestArgs(files, extra = []) {
  return ["vitest", "run", "--project", "db", ...files, ...extra];
}
