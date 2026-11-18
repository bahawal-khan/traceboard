import { auth } from "@clerk/nextjs/server";
import { getSql } from "@/lib/db/client";
import { hashApiKey, looksLikeApiKey } from "@/lib/api-key";
import { issueCtx, runScoped, type ApiKeyCtx, type DemoCtx, type SessionCtx } from "./tenant";

/** Owner id of the synthetic demo project. Clerk user ids never look like this. */
export const DEMO_OWNER_ID = "system:demo";

/** Validated Clerk session -> context scoped to the projects this user owns. null if signed out. */
export async function ctxFromSession(): Promise<SessionCtx | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const [rows] = await runScoped({ ownerId: userId, projectIds: [], readOnly: false }, (t) => [
    t`select id from projects where owner_id = ${userId}`,
  ]);
  return issueCtx<SessionCtx>({
    kind: "session",
    ownerId: userId,
    projectIds: rows.map((r) => r.id as string),
    readOnly: false,
  });
}

/** Raw API key -> context for its one project. null for malformed, unknown or revoked keys. */
export async function ctxFromApiKey(rawKey: string | null | undefined): Promise<ApiKeyCtx | null> {
  if (!rawKey || !looksLikeApiKey(rawKey)) return null;
  const rows = await getSql()`select project_id, key_id, scopes from lookup_key(${hashApiKey(rawKey)})`;
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
