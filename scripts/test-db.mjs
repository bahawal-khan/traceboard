// Runs the database tests, all of them or one named group, ALWAYS one vitest process and one file at a time (the tests share one
// database; running them in parallel would break their isolation and is deliberately not offered).
//
//   node scripts/test-db.mjs all                  # same as `npm run test:db`
//   node scripts/test-db.mjs ingest|security|control|jobs
//   node scripts/test-db.mjs event-content        # one file
//   node scripts/test-db.mjs jobs --timing        # also record round trips and print where the time went
//   node scripts/test-db.mjs ingest -- -t "cap"   # arguments after -- go to vitest
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { buildVitestArgs, loadGroups, resolveFiles, validateGroups } from "./test-db-lib.mjs";

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const own = dash === -1 ? argv : argv.slice(0, dash);
const extra = dash === -1 ? [] : argv.slice(dash + 1);
const timing = own.includes("--timing");
const selectors = own.filter((a) => a !== "--timing");

const groups = loadGroups();
const problems = validateGroups(groups);
if (problems.length) {
  console.error("tests/db/groups.json is out of date:\n - " + problems.join("\n - "));
  process.exit(2);
}
if (selectors.length === 0) {
  console.error(`usage: node scripts/test-db.mjs <all|${Object.keys(groups).join("|")}|file> [--timing] [-- vitest args]`);
  process.exit(2);
}

let files = [];
try {
  for (const s of selectors) {
    const f = resolveFiles(s, groups);
    if (f.length === 0) {
      files = []; // "all" wins: no file filter
      break;
    }
    files.push(...f);
  }
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(2);
}

const env = { ...process.env };
if (timing) {
  env.DB_TEST_TIMING = "1";
  rmSync("test-results/db-timing.jsonl", { force: true });
}
const started = Date.now();
const run = spawnSync("npx", buildVitestArgs(files, extra), { stdio: "inherit", env });
console.log(`\n[test-db] ${selectors.join("+")}: ${((Date.now() - started) / 1000).toFixed(1)} s wall, exit ${run.status}`);
if (timing) spawnSync(process.execPath, ["scripts/db-timing-report.mjs"], { stdio: "inherit" });
process.exit(run.status ?? 1);
