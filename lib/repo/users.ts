import { auth } from "@clerk/nextjs/server";
import { getSql } from "@/lib/db/client";
import { envSchema } from "@/lib/env";
import { retryOnConnectionError } from "@/lib/errors/connection";

export type SlotStatus = "signed_out" | "existing" | "created" | "full";

const capEnv = envSchema.pick({ MAX_USERS: true });

/**
 * First dashboard load: register the signed-in user, enforcing MAX_USERS atomically in the
 * database (claim_user_slot: advisory lock + count + insert in one call). Existing users always
 * keep access; only new users are refused when the cap is reached.
 * Takes no arguments on purpose: the user id comes from the validated Clerk session.
 */
export async function ensureSignedInUserSlot(): Promise<SlotStatus> {
  const { userId } = await auth();
  if (!userId) return "signed_out";
  const { MAX_USERS } = capEnv.parse(process.env);
  // claim_user_slot is idempotent per user, so one retry after a connection failure is safe.
  const rows = await retryOnConnectionError(() => getSql()`select claim_user_slot(${userId}, ${MAX_USERS}) as status`);
  const status = rows[0]?.status;
  if (status !== "existing" && status !== "created" && status !== "full") throw new Error("unexpected claim_user_slot result");
  return status;
}
