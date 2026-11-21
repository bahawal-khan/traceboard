// Quick preflight (a few `select 1` round trips): how far away is the test database? Run it BEFORE a long DB test run.
// Reads DATABASE_URL from .env.local like the tests do. It only runs `select 1`.
import { neon } from "@neondatabase/serverless";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may come from the shell */
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (.env.local or the shell).");
  process.exit(1);
}
const { configureLocalNeon } = await import("../db/neon-local.mjs");
configureLocalNeon(url);
const sql = neon(url);
const times = [];
for (let i = 0; i < 8; i++) {
  const t0 = performance.now();
  await sql`select 1`;
  times.push(performance.now() - t0);
}
const first = times[0];
const warm = times.slice(1).sort((a, b) => a - b);
const median = warm[Math.floor(warm.length / 2)];
console.log(`first request ${first.toFixed(0)} ms (includes connection setup / compute wake-up)`);
console.log(`warm round trip: min ${warm[0].toFixed(0)} ms, median ${median.toFixed(0)} ms, max ${warm.at(-1).toFixed(0)} ms`);
const verdict = median < 40 ? "fast (local or same region): a full DB run should take about as long as CI (a few minutes)"
  : median < 150 ? "moderate: expect a full DB run well above CI time"
  : "slow: every DB test step is a round trip, so the run is dominated by latency (see docs: use a local Postgres or a closer region)";
console.log(`=> ${verdict}`);
console.log(`DB tests make hundreds of round trips per file: total time is roughly (round trips x ${median.toFixed(0)} ms). Measure them: npm run test:db:timed`);
