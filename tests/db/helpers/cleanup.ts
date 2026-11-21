import type { NeonQueryFunction, NeonQueryFunctionInTransaction, NeonQueryInTransaction } from "@neondatabase/serverless";

type T = NeonQueryFunctionInTransaction<false, false>;
type Sql = NeonQueryFunction<false, false>;

/** The statements that remove ONE test user: their projects (cascading to every child row) and their signup slot. */
function statementsFor(t: T, owner: string): NeonQueryInTransaction[] {
  return [
    t`select set_config('app.owner_id', ${owner}, true), set_config('app.project_ids', '', true)`,
    t`delete from projects where owner_id = ${owner}`,
    t`select release_user_slot()`,
  ];
}

/**
 * Removes the data of the test users a file created, in ONE round trip (one HTTP request, one transaction) instead of one per user.
 * Each user is handled exactly as before: set the owner context, delete their projects, release their slot; set_config(..., true)
 * is transaction-local, so the next user's statements start from their own context. If the batch fails, falls back to one
 * transaction per user (the previous behaviour), so one bad user cannot leave the others' rows behind.
 */
export async function cleanupOwners(sql: Sql, owners: readonly string[]): Promise<void> {
  if (owners.length === 0) return;
  try {
    await sql.transaction((t) => owners.flatMap((owner) => statementsFor(t, owner)));
  } catch {
    let firstError: unknown;
    for (const owner of owners) {
      try {
        await sql.transaction((t) => statementsFor(t, owner));
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
