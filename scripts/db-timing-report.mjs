// Prints where a DB test run spent its time, from test-results/db-timing.jsonl (written when DB_TEST_TIMING=1).
// Usage: node scripts/db-timing-report.mjs [path]
import { readFileSync, existsSync } from "node:fs";

const path = process.argv[2] ?? "test-results/db-timing.jsonl";
if (!existsSync(path)) {
  console.error(`No ${path}. Run:  npm run test:db:timed   (or: node scripts/test-db.mjs all --timing)`);
  process.exit(1);
}
const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
rows.sort((a, b) => b.wallMs - a.wallMs);
const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
const f1 = (n) => n.toFixed(1);
const pad = (s, n) => String(s).padStart(n);

console.log("file".padEnd(34), pad("wall s", 7), pad("trips", 6), pad("avg ms", 7), pad("max ms", 7), pad("in DB %", 8), pad("other s", 8), pad("fail", 5));
for (const r of rows) {
  const avg = r.roundTrips ? r.totalMs / r.roundTrips : 0;
  console.log(
    r.file.replace(/^tests\/db\//, "").padEnd(34),
    pad(f1(r.wallMs / 1000), 7), pad(r.roundTrips, 6), pad(f1(avg), 7), pad(f1(r.maxMs), 7),
    pad(f1((100 * r.totalMs) / Math.max(r.wallMs, 1)), 8), pad(f1((r.wallMs - r.totalMs) / 1000), 8), pad(r.failures, 5),
  );
}
const trips = sum("roundTrips");
console.log("-".repeat(86));
console.log(
  "TOTAL".padEnd(34), pad(f1(sum("wallMs") / 1000), 7), pad(trips, 6), pad(f1(trips ? sum("totalMs") / trips : 0), 7), pad("", 7), pad(f1((100 * sum("totalMs")) / Math.max(sum("wallMs"), 1)), 8),
  pad(f1((sum("wallMs") - sum("totalMs")) / 1000), 8), pad(sum("failures"), 5),
);
console.log('\n"in DB %" = time inside requests to the database / wall time of the file. "other s" = everything else (module import, JS work, waiting).');
console.log("Slowest single requests (statement head only):");
const all = rows.flatMap((r) => r.slowest.map((s) => ({ ...s, file: r.file.replace(/^tests\/db\//, "") })));
all.sort((a, b) => b.ms - a.ms);
for (const s of all.slice(0, 8)) console.log(`  ${pad(f1(s.ms), 8)} ms  ${s.file.padEnd(26)} ${s.head}`);
if (sum("failures")) console.log(`\n${sum("failures")} request(s) failed at the connection level (each was retried by the test setup).`);
