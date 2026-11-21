import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { configureLocalNeon } from "@/db/neon-local.mjs";
import { z } from "zod";

/**
 * Driver for the daily job ONLY, connecting as `app_job` (JOB_DATABASE_URL, pooled host). app_job has no table privilege
 * and can execute only the job functions (migration 0011). Import this from lib/repo/jobs.ts only; never from a request path.
 * Reads only JOB_DATABASE_URL so unrelated missing secrets do not break the job.
 */
const jobEnv = z.object({ JOB_DATABASE_URL: z.string().min(1) });

let sql: NeonQueryFunction<false, false> | undefined;

export function getJobSql(): NeonQueryFunction<false, false> {
  if (!sql) {
    const { JOB_DATABASE_URL } = jobEnv.parse(process.env);
    configureLocalNeon(JOB_DATABASE_URL);
    sql = neon(JOB_DATABASE_URL);
  }
  return sql;
}
