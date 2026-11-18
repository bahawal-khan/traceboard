import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Registered users, for the MAX_USERS signup cap on the free deployment.
 * Rows are created ONLY by the claim_user_slot() SQL function (custom migration),
 * which serialises signups with an advisory lock. Global table, no project_id.
 */
export const appUsers = pgTable("app_users", {
  userId: text("user_id").primaryKey(), // Clerk user id
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
