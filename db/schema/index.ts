import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Global (non-tenant) key/value state: conserve flags, last DB-size estimate.
 * Holds no tenant data, so it has no project_id and no RLS.
 */
export const appState = pgTable("app_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
