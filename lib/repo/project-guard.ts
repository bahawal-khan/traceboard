import { projectId } from "@/lib/validation/projects";
import { NotFoundError } from "./errors";
import type { SessionCtx, Tx } from "./tenant";

/**
 * The "is this my project" steps shared by the dashboard readers (metrics, traces). One place, so every reader gives the
 * SAME answer for a project that is not yours, does not exist, was deleted, or whose id is not a UUID: NotFoundError.
 */

/** The project row, visible only to its owner (RLS plus the explicit owner filter, like getProject). */
export function projectSelect(t: Tx, ctx: SessionCtx, pid: string) {
  return t`select id from projects where id = ${pid}::uuid and owner_id = ${ctx.ownerId}`;
}

/** A malformed id is "not found", exactly like a missing or foreign one. */
export function parseProjectId(id: string): string {
  const parsed = projectId.safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}

/** Cheap pre-check, no database: a project outside the context's own list can never be read. Same error as a missing one. */
export function assertInContext(ctx: SessionCtx, pid: string): void {
  if (!ctx.projectIds.includes(pid)) throw new NotFoundError();
}
