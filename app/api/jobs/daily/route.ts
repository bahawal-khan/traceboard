import { createDailyJobHandler } from "@/lib/jobs/handler";
import { createJobStore } from "@/lib/repo/jobs";

// Node runtime (node:crypto for the constant-time secret compare). Cron-only: authenticated by CRON_SECRET, never by a session.
export const runtime = "nodejs";
// Purge loops stop at 40 s (DAILY_JOB.purgeBudgetMs); the rest is partitions, drop and the report. Hobby maximum is 300 s.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export const GET = createDailyJobHandler({
  secret: () => process.env.CRON_SECRET,
  store: createJobStore,
});
