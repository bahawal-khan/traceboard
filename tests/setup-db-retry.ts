import { neonConfig } from "@neondatabase/serverless";
import { appendFileSync, mkdirSync } from "node:fs";
import { afterAll, expect } from "vitest";
import { configureLocalNeon } from "../db/neon-local.mjs";
import { createFetchTimer } from "./helpers/db-timing";
import { withConnectionRetry } from "./helpers/retry-fetch";

// Opt-in measurement (DB_TEST_TIMING=1, see scripts/test-db.mjs --timing): observe every request, change nothing.
const timing = process.env.DB_TEST_TIMING === "1" ? createFetchTimer() : null;
const baseFetch = globalThis.fetch.bind(globalThis);

// DB tests only: make the Neon HTTP driver retry transient connection failures.
neonConfig.fetchFunction = withConnectionRetry(timing ? timing.wrap(baseFetch) : baseFetch);

if (timing) {
  const startedAt = performance.now();
  afterAll(() => {
    const file = expect.getState().testPath ?? "unknown";
    const wallMs = performance.now() - startedAt;
    const line = JSON.stringify({ file: file.replace(process.cwd() + "/", ""), wallMs, ...timing.snapshot() });
    mkdirSync("test-results", { recursive: true });
    appendFileSync("test-results/db-timing.jsonl", line + "\n");
  });
}

// CI / local proxy: point the driver at it when DATABASE_URL uses the local host (no-op for real Neon).
configureLocalNeon(process.env.DATABASE_URL);
