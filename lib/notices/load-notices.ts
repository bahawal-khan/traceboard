import type { ProjectNotices } from "@/lib/dashboard/project-notices";
import { logger, type Logger } from "@/lib/logger";
import { NotFoundError } from "@/lib/repo/errors";
import { readProjectStatus } from "@/lib/repo/quota-status";
import type { SessionCtx } from "@/lib/repo/tenant";

/**
 * The notices for a project page, or null. NEVER throws: a failed read must not break the page, so it renders without notices.
 * A project that is not the caller's gives null too (the page's own lookup answers not-found). The log carries a generic label
 * only: no error text, no ids, no counts. Lives outside lib/dashboard on purpose: that folder is shared with the static demo
 * and must not import lib/repo (tests/demo-static.test.ts).
 */
export async function loadProjectNotices(
  ctx: SessionCtx,
  projectId: string,
  deps: { read?: typeof readProjectStatus; log?: Logger } = {},
): Promise<ProjectNotices | null> {
  try {
    const s = await (deps.read ?? readProjectStatus)(ctx, projectId);
    return { eventsToday: s.eventsToday, eventsLimit: s.eventsLimit, conserve: s.conserve };
  } catch (e) {
    if (!(e instanceof NotFoundError)) (deps.log ?? logger).warn("project notices unavailable", { route: "project.notices", outcome: "read_failed" });
    return null;
  }
}
