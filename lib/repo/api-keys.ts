import { generateApiKey } from "@/lib/api-key";
import { QUOTAS } from "@/lib/quotas";
import { projectId } from "@/lib/validation/projects";
import { createApiKeyInput, keyId } from "@/lib/validation/api-keys";
import { LimitReachedError, NotFoundError } from "./errors";
import { withTenant, type SessionCtx } from "./tenant";

/** Everything the dashboard may know about a key. The secret and the hash never appear here. */
export interface ApiKeyMeta {
  id: string;
  /** User-chosen label; empty string when the key is unnamed (the UI then shows the prefix). */
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * Project-scoped child resources require the project to be inside the context's scope. A context is
 * built per request (ctxFromSession) and is immutable, so a project created AFTER the context was
 * made is not in it: RLS would reject the write (or hide rows). Fail closed up front with "not found"
 * instead of a confusing database error or a silently empty list. Callers needing a project they
 * just created must build a fresh context (every route and page already does, per request).
 * This is an early guard only: RLS stays the independent second layer.
 */
function requireInScope(ctx: SessionCtx, pid: string): void {
  if (!ctx.projectIds.includes(pid)) throw new NotFoundError();
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());

function toMeta(r: Record<string, unknown>): ApiKeyMeta {
  return {
    id: r.id as string,
    name: (r.name as string | null) ?? "",
    prefix: r.prefix as string,
    scopes: r.scopes as string[],
    lastUsedAt: iso(r.last_used_at),
    revokedAt: iso(r.revoked_at),
    createdAt: iso(r.created_at)!,
  };
}

export interface CreatedApiKey {
  key: ApiKeyMeta;
  /** The raw key. Returned once, by this call only. */
  secret: string;
}

/**
 * Creates a key for a project the caller owns, if the project has fewer than QUOTAS.keysPerProject
 * ACTIVE (not revoked) keys. A per-project advisory lock (first statement, same transaction)
 * serialises concurrent creates; the ownership check, the count and the insert are one statement,
 * and the audit row is written by that statement only when the insert happened.
 * Only the sha256 hash and a short display prefix are stored.
 */
export async function createApiKey(ctx: SessionCtx, project: string, input: unknown, ip: string | null = null): Promise<CreatedApiKey> {
  const pid = projectId.parse(project);
  const { scopes, name } = createApiKeyInput.parse(input ?? {});
  requireInScope(ctx, pid);
  const gen = generateApiKey();
  const owner = ctx.ownerId;
  const [, rows] = await withTenant(ctx, (t) => [
    t`select pg_advisory_xact_lock(hashtextextended(${pid}::text, 2))`,
    t`with p as (
        select id from projects where id = ${pid}::uuid and owner_id = ${owner}::text
      ), ins as (
        insert into api_keys (project_id, key_hash, prefix, scopes, name)
        select p.id, ${gen.hash}::text, ${gen.prefix}::text, ${scopes}::text[], ${name}::text
          from p
         where (select count(*) from api_keys where project_id = p.id and revoked_at is null) < ${QUOTAS.keysPerProject}::int
        returning id, name, prefix, scopes, last_used_at, revoked_at, created_at
      ), aud as (
        insert into audit_log (owner_id, action, target, ip)
        select ${owner}::text, 'api_key.create', id::text, ${ip}::text from ins
      )
      select (select count(*)::int from p) as project_found,
             ins.id, ins.name, ins.prefix, ins.scopes, ins.last_used_at, ins.revoked_at, ins.created_at
        from (select 1) x left join ins on true`,
  ]);
  const row = rows[0];
  if (!row || row.project_found === 0) throw new NotFoundError();
  if (row.id == null) throw new LimitReachedError("keys_per_project");
  return { key: toMeta(row), secret: gen.secret };
}

export async function listApiKeys(ctx: SessionCtx, project: string): Promise<ApiKeyMeta[]> {
  const pid = projectId.parse(project);
  requireInScope(ctx, pid);
  const [owned, rows] = await withTenant(ctx, (t) => [
    t`select 1 as ok from projects where id = ${pid}::uuid and owner_id = ${ctx.ownerId}`,
    t`select id, name, prefix, scopes, last_used_at, revoked_at, created_at
        from api_keys where project_id = ${pid}::uuid order by created_at desc`,
  ]);
  if (owned.length === 0) throw new NotFoundError();
  return rows.map(toMeta);
}

/**
 * Revokes a key of a project the caller owns. Idempotent: revoking an already revoked key succeeds
 * without a second audit row. A key id that does not belong to that project is "not found".
 */
export async function revokeApiKey(ctx: SessionCtx, project: string, key: string, ip: string | null = null): Promise<void> {
  const pid = projectId.parse(project);
  const kid = keyId.parse(key);
  requireInScope(ctx, pid);
  const owner = ctx.ownerId;
  const [rows] = await withTenant(ctx, (t) => [
    t`with k as (
        select id, revoked_at from api_keys
         where id = ${kid}::uuid and project_id = ${pid}::uuid
           and exists (select 1 from projects where id = ${pid}::uuid and owner_id = ${owner}::text)
      ), upd as (
        update api_keys set revoked_at = now()
         where id in (select id from k where revoked_at is null)
        returning id
      ), aud as (
        insert into audit_log (owner_id, action, target, ip)
        select ${owner}::text, 'api_key.revoke', id::text, ${ip}::text from upd
      )
      select (select count(*)::int from k) as found`,
  ]);
  if (!rows[0] || rows[0].found === 0) throw new NotFoundError();
}
