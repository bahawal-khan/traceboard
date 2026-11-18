import { QUOTAS } from "@/lib/quotas";
import { createProjectInput, projectId, renameProjectInput } from "@/lib/validation/projects";
import { LimitReachedError, NotFoundError } from "./errors";
import { withTenant, type SessionCtx } from "./tenant";

export interface Project {
  id: string;
  name: string;
  captureContent: boolean;
  contentRetentionDays: number;
  createdAt: string;
}

// Row mapper: timestamptz may arrive as Date or string depending on the driver; normalise to ISO.
function toProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    captureContent: r.capture_content as boolean,
    contentRetentionDays: Number(r.content_retention_days),
    createdAt: new Date(r.created_at as string | Date).toISOString(),
  };
}

/** Only session contexts (a signed-in owner) may manage projects; API-key and demo contexts cannot compile here. */
export async function listProjects(ctx: SessionCtx): Promise<Project[]> {
  const [rows] = await withTenant(ctx, (t) => [
    t`select id, name, capture_content, content_retention_days, created_at
        from projects where owner_id = ${ctx.ownerId} order by created_at desc`,
  ]);
  return rows.map(toProject);
}

export async function getProject(ctx: SessionCtx, id: string): Promise<Project> {
  const pid = projectId.parse(id);
  const [rows] = await withTenant(ctx, (t) => [
    t`select id, name, capture_content, content_retention_days, created_at
        from projects where id = ${pid}::uuid and owner_id = ${ctx.ownerId}`,
  ]);
  if (!rows[0]) throw new NotFoundError();
  return toProject(rows[0]);
}

/**
 * Creates a project if the owner is under QUOTAS.projectsPerUser. The per-owner advisory lock
 * (taken first, in the same transaction) serialises concurrent creates so two requests cannot both
 * take the last slot; the count and the insert are one statement, and the audit row is written by
 * the same statement only when the insert happened.
 */
export async function createProject(ctx: SessionCtx, input: unknown, ip: string | null = null): Promise<Project> {
  const { name } = createProjectInput.parse(input);
  const owner = ctx.ownerId;
  const [, rows] = await withTenant(ctx, (t) => [
    t`select pg_advisory_xact_lock(hashtextextended(${owner}::text, 1))`,
    t`with ins as (
        insert into projects (owner_id, name)
        select ${owner}::text, ${name}::text
         where (select count(*) from projects where owner_id = ${owner}::text) < ${QUOTAS.projectsPerUser}::int
        returning id, name, capture_content, content_retention_days, created_at
      ), aud as (
        insert into audit_log (owner_id, action, target, ip)
        select ${owner}::text, 'project.create', id::text, ${ip}::text from ins
      )
      select * from ins`,
  ]);
  if (!rows[0]) throw new LimitReachedError("projects_per_user");
  return toProject(rows[0]);
}

export async function renameProject(ctx: SessionCtx, id: string, input: unknown): Promise<Project> {
  const pid = projectId.parse(id);
  const { name } = renameProjectInput.parse(input);
  const [rows] = await withTenant(ctx, (t) => [
    t`update projects set name = ${name}::text
       where id = ${pid}::uuid and owner_id = ${ctx.ownerId}
      returning id, name, capture_content, content_retention_days, created_at`,
  ]);
  if (!rows[0]) throw new NotFoundError();
  return toProject(rows[0]);
}

/**
 * Hard delete: foreign keys cascade to keys, budgets, alerts, jobs, events, content, rollups and
 * usage. The audit row (owner-scoped, so it outlives the project) is written by the same statement.
 */
export async function deleteProject(ctx: SessionCtx, id: string, ip: string | null = null): Promise<void> {
  const pid = projectId.parse(id);
  const owner = ctx.ownerId;
  const [rows] = await withTenant(ctx, (t) => [
    t`with del as (
        delete from projects where id = ${pid}::uuid and owner_id = ${owner}::text returning id
      ), aud as (
        insert into audit_log (owner_id, action, target, ip)
        select ${owner}::text, 'project.delete', id::text, ${ip}::text from del
      )
      select id from del`,
  ]);
  if (!rows[0]) throw new NotFoundError();
}
