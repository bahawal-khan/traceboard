import { neon } from "@neondatabase/serverless";
import { configureLocalNeon } from "../db/neon-local.mjs";

/**
 * Runs once before the db test project. If the database cannot be reached the run stops here, loudly,
 * instead of every test file failing or being skipped one by one. It also wakes a suspended Neon
 * compute (cold start) before the first test's timeout starts. Set SKIP_DB_TESTS=1 to skip the DB
 * tests on purpose (CI before the integration job exists).
 */
const DELAYS_MS = [1_000, 2_000, 4_000];

export default async function setup() {
  if (process.env.SKIP_DB_TESTS === "1") {
    console.warn("[db tests] SKIP_DB_TESTS=1: database tests are skipped on purpose.");
    return;
  }
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* env may come from the shell */
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("[db tests] DATABASE_URL is not set. Add it to .env.local, or set SKIP_DB_TESTS=1 to skip database tests explicitly.");
  }
  configureLocalNeon(url);
  const sql = neon(url);
  let lastError: unknown;
  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
    try {
      const started = Date.now();
      await sql`select 1`;
      console.log(`[db tests] database reachable (${Date.now() - started} ms)`);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < DELAYS_MS.length) await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
    }
  }
  // Never print the connection string; the driver error text does not contain it.
  throw new Error(`[db tests] cannot reach the database after ${DELAYS_MS.length + 1} attempts (network, or Neon waking up). Last error: ${String(lastError).slice(0, 200)}`);
}
