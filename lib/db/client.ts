import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { configureLocalNeon } from "@/db/neon-local.mjs";
import { envSchema } from "@/lib/env";

/**
 * The ONLY place the runtime db driver is created. Import this from lib/repo/*
 * only (ESLint enforces it). Connects as `app_rw` via the pooled DATABASE_URL.
 * HTTP driver: each call is stateless; tenant queries run through
 * withTenant(), which batches set_config + queries in one transaction.
 * Reads only DATABASE_URL, so unrelated missing secrets do not break data access.
 */
const dbEnv = envSchema.pick({ DATABASE_URL: true });

let sql: NeonQueryFunction<false, false> | undefined;

export function getSql(): NeonQueryFunction<false, false> {
  if (!sql) {
    const { DATABASE_URL } = dbEnv.parse(process.env);
    configureLocalNeon(DATABASE_URL); // no-op unless the host is the local CI/dev proxy
    sql = neon(DATABASE_URL);
  }
  return sql;
}
