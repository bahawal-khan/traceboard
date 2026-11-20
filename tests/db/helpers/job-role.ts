import { neon } from "@neondatabase/serverless";

/**
 * Connections for the roles that are NOT app_rw. Since migration 0011 only the job role (app_job) and the migrator
 * (the owner) may execute the partition and purge functions; app_rw may not.
 */
export function jobUrl(): string {
  const u = process.env.JOB_DATABASE_URL;
  if (!u) {
    throw new Error(
      "JOB_DATABASE_URL is not set. Since P2.11a the daily-job functions are executable only by the app_job role: " +
        "set APP_JOB_PASSWORD, run `npm run db:setup-roles`, then `npm run db:migrate`, and put the app_job connection string in JOB_DATABASE_URL.",
    );
  }
  return u;
}
export const jobSql = () => neon(jobUrl());

export function adminUrl(): string {
  const u = process.env.MIGRATION_DATABASE_URL;
  if (!u) throw new Error("MIGRATION_DATABASE_URL is not set (the migrator owns the tables; some tests need it to prepare data).");
  return u;
}
export const adminSql = () => neon(adminUrl());

/**
 * Restores the previous UTC month and the next four (earlier runs may have dropped now-expired partitions). Uses the job role,
 * the production caller, and falls back to the migrator so a setup without JOB_DATABASE_URL still gets partitions.
 */
export async function ensureEventPartitions(): Promise<void> {
  const url = process.env.JOB_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("Neither JOB_DATABASE_URL nor MIGRATION_DATABASE_URL is set: app_rw cannot create partitions since migration 0011.");
  await neon(url)`select ensure_event_partitions((date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date, 5)`;
}
