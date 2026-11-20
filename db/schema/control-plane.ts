import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Control plane (docs/DATA_MODEL.md section 1). RLS lives in the custom SQL migration. */

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(), // Clerk user id
    name: text("name").notNull(),
    captureContent: boolean("capture_content").notNull().default(false),
    contentRetentionDays: integer("content_retention_days").notNull().default(7),
    isDemo: boolean("is_demo").notNull().default(false),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("projects_owner_idx").on(t.ownerId)],
);

const projectId = () =>
  uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" });

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: projectId(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    check("project_members_role_check", sql`${t.role} in ('owner','member')`),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectId(),
    keyHash: text("key_hash").notNull().unique(), // sha256 hex; the key itself is never stored
    prefix: text("prefix").notNull(),
    name: text("name").notNull().default(""), // optional label chosen by the user; empty = unnamed
    scopes: text("scopes").array().notNull().default(sql`ARRAY['ingest']::text[]`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_project_idx").on(t.projectId)],
);

export const providerKeys = pgTable(
  "provider_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectId(),
    provider: text("provider").notNull(),
    ciphertext: text("ciphertext").notNull(), // base64 of AES-256-GCM output (P5)
    nonce: text("nonce").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    last4: text("last4").notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("provider_keys_project_idx").on(t.projectId)],
);

/** Global price list: read-only for the app role. */
export const modelPrices = pgTable("model_prices", {
  model: text("model").primaryKey(),
  provider: text("provider").notNull(),
  inputPer1m: numeric("input_per_1m").notNull(),
  outputPer1m: numeric("output_per_1m").notNull(),
  cachedInputPer1m: numeric("cached_input_per_1m"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectId(),
    scope: text("scope").notNull(),
    period: text("period").notNull(),
    limitUsd: numeric("limit_usd").notNull(),
    action: text("action").notNull(),
  },
  (t) => [
    index("budgets_project_idx").on(t.projectId),
    check("budgets_scope_check", sql`${t.scope} in ('project','trace')`),
    check("budgets_period_check", sql`${t.period} in ('day','month','run')`),
    check("budgets_action_check", sql`${t.action} in ('alert','block')`),
  ],
);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectId(),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    message: text("message").notNull(),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("alerts_project_created_idx").on(t.projectId, t.createdAt.desc())],
);

/** Append-only. Owner-scoped (no project_id: it must outlive a deleted project). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_owner_created_idx").on(t.ownerId, t.createdAt.desc())],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: projectId(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("jobs_project_idx").on(t.projectId),
    index("jobs_claim").on(t.status, t.runAfter),
    check("jobs_status_check", sql`${t.status} in ('queued','running','done','failed')`),
  ],
);
