import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { getEnv } from "@/lib/env";

/**
 * The ONLY place the runtime db driver is created. Import this from lib/repo/*
 * only (ESLint enforces it). Connects as `app_rw` via the pooled DATABASE_URL.
 * HTTP driver: each call is stateless; tenant queries run through
 * withTenant() (P1.5), which batches set_config + queries in one transaction.
 */
let sql: NeonQueryFunction<false, false> | undefined;

export function getSql(): NeonQueryFunction<false, false> {
  sql ??= neon(getEnv().DATABASE_URL);
  return sql;
}
