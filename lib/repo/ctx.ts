import { auth } from "@clerk/nextjs/server";
import { getSql } from "@/lib/db/client";
import { hashApiKey, looksLikeApiKey } from "@/lib/api-key";
import { retryOnConnectionError } from "@/lib/errors/connection";
import { issueCtx, runScoped, type ApiKeyCtx, type DemoCtx, type SessionCtx } from "./tenant";

/** Owner id of the synthetic demo project. Clerk user ids never look like this. */
export const DEMO_OWNER_ID = "system:demo";

/** Validated Clerk session -> context scoped to the projects this user owns. null if signed out or the user holds no slot. */
export async function ctxFromSession(): Promise<SessionCtx | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const [rows, slot] = await runScoped({ ownerId: userId, projectIds: [], readOnly: false }, (t) => [
    t`select id from projects where owner_id = ${userId}`,
    t`select 1 as ok from app_users`, // RLS: only the caller's own row is visible
  ]);
  // No slot = never passed the MAX_USERS check on first dashboard load: no data access.
  if (slot.length === 0) return null;
  return issueCtx<SessionCtx>({
    kind: "session",
    ownerId: userId,
    projectIds: rows.map((r) => r.id as string),
    readOnly: false,
  });
}

/**
 * Raw API key -> context for its one project. null for malformed, unknown or revoked keys.
 * Uncached; request handlers go through `ApiKeyAuthenticator` (lib/api-key-auth.ts).
 */
export async function ctxFromApiKey(rawKey: string | null | undefined): Promise<ApiKeyCtx | null> {
  if (!rawKey || !looksLikeApiKey(rawKey)) return null;
  // Ingest hot path: one retry on a connection-level failure (never on SQL errors). Safe to repeat: read-only.
  const hash = hashApiKey(rawKey);
  const rows = await retryOnConnectionError(() => getSql()`select project_id, key_id, scopes from lookup_key(${hash})`);
  const row = rows[0];
  if (!row) return null;
  return issueCtx<ApiKeyCtx>({
    kind: "apiKey",
    ownerId: null,
    projectIds: [row.project_id as string],
    keyId: row.key_id as string,
    scopes: row.scopes as string[],
    readOnly: false,
  });
}

/** Public synthetic demo project: read-only. Empty scope (fail closed) if no demo project exists. */
export async function ctxDemo(): Promise<DemoCtx> {
  const [rows] = await runScoped({ ownerId: DEMO_OWNER_ID, projectIds: [], readOnly: true }, (t) => [
    t`select id from projects where owner_id = ${DEMO_OWNER_ID} and is_demo`,
  ]);
  return issueCtx<DemoCtx>({
    kind: "demo",
    ownerId: null,
    projectIds: rows.map((r) => r.id as string),
    readOnly: true,
  });
}
