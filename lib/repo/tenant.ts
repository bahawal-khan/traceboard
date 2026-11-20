import type { NeonQueryFunctionInTransaction, NeonQueryInTransaction } from "@neondatabase/serverless";
import { z } from "zod";
import { getSql } from "@/lib/db/client";
import { retryOnConnectionError } from "@/lib/errors/connection";

/**
 * Tenant context + withTenant(): the only door to tenant data.
 *
 * A TenantCtx can only be produced by ctxFromSession / ctxFromApiKey /
 * ctxDemo (lib/repo/ctx.ts) through `issueCtx`. The brand makes forging a
 * compile error; the WeakSet makes forging at runtime (casts) fail closed too.
 */
declare const brand: unique symbol;

interface CtxBase {
  readonly [brand]: true;
  /** Clerk user id for session contexts; null for API-key and demo contexts. */
  readonly ownerId: string | null;
  readonly projectIds: readonly string[];
  /** Demo context: every statement runs in a READ ONLY transaction. */
  readonly readOnly: boolean;
}
export interface SessionCtx extends CtxBase {
  readonly kind: "session";
  readonly ownerId: string;
  readonly readOnly: false;
}
export interface ApiKeyCtx extends CtxBase {
  readonly kind: "apiKey";
  readonly ownerId: null;
  readonly keyId: string;
  readonly scopes: readonly string[];
  readonly readOnly: false;
}
export interface DemoCtx extends CtxBase {
  readonly kind: "demo";
  readonly ownerId: null;
  readonly readOnly: true;
}
export type TenantCtx = SessionCtx | ApiKeyCtx | DemoCtx;

type Fields<T> = Omit<T, typeof brand>;

const issued = new WeakSet<object>();
const uuidList = z.array(z.string().uuid()).max(100);

/** Internal: called only by lib/repo/ctx.ts. Validates and freezes. */
export function issueCtx<T extends TenantCtx>(fields: Fields<T>): T {
  uuidList.parse(fields.projectIds);
  const ctx = Object.freeze({ ...fields, projectIds: Object.freeze([...fields.projectIds]) }) as unknown as T;
  issued.add(ctx);
  return ctx;
}

export class TenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantError";
  }
}

export type Tx = NeonQueryFunctionInTransaction<false, false>;

/**
 * Runs `set_config('app.owner_id'/'app.project_ids', ..., true)` as the first
 * statement of the SAME transaction as the queries (one HTTP round trip).
 * Without it every tenant query returns zero rows (RLS fails closed).
 * `build` must be synchronous and return the queries to run; their results
 * are returned in order (the set_config result is dropped).
 */
export async function runScoped(
  scope: { ownerId: string | null; projectIds: readonly string[]; readOnly: boolean },
  build: (t: Tx) => NeonQueryInTransaction[],
) {
  const sql = getSql();
  // One retry, connection-level failures only (never SQL errors): build() only creates query objects, so
  // running the transaction twice is safe; see retryOnConnectionError for the lost-response caveat.
  const results = await retryOnConnectionError(() =>
    sql.transaction(
      (t) => {
        const queries = build(t);
        if (!Array.isArray(queries)) throw new TenantError("withTenant: build() must synchronously return an array of queries");
        return [
          t`select set_config('app.owner_id', ${scope.ownerId ?? ""}, true), set_config('app.project_ids', ${scope.projectIds.join(",")}, true)`,
          ...queries,
        ];
      },
      { readOnly: scope.readOnly },
    ),
  );
  return results.slice(1);
}

export async function withTenant(ctx: TenantCtx, build: (t: Tx) => NeonQueryInTransaction[]) {
  if (typeof ctx !== "object" || ctx === null || !issued.has(ctx)) {
    throw new TenantError("withTenant: context was not issued by ctxFromSession/ctxFromApiKey/ctxDemo");
  }
  return runScoped(ctx, build);
}
