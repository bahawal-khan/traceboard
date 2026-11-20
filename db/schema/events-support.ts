import { bigint, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid, date } from "drizzle-orm/pg-core";
import { budgets, projects } from "./control-plane";

/**
 * Tables next to the partitioned `events` table (docs/DATA_MODEL.md sections 2-3, 6).
 * `events` itself is a partitioned table, which Drizzle cannot model: it lives in
 * custom SQL (migration 0005). RLS and grants are in custom SQL as well.
 */
const projectId = () =>
  uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" });

/** Opt-in content capture only (truncated + redacted before it gets here). */
export const eventContent = pgTable(
  "event_content",
  {
    eventId: uuid("event_id").notNull(),
    projectId: projectId(),
    /** AES-256-GCM ciphertext ("v1.<keyVersion>.<iv>.<ct>.<tag>"); never plaintext (lib/crypto.ts). */
    inputText: text("input_text"),
    outputText: text("output_text"),
    redactionReport: jsonb("redaction_report"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // (project_id, event_id): two tenants may legitimately use the same event id; a global key on
    // event_id alone would let one tenant's row block another's insert.
    primaryKey({ columns: [t.projectId, t.eventId] }),
    index("event_content_project_idx").on(t.projectId),
    index("event_content_expires_idx").on(t.expiresAt),
  ],
);

const n = (name: string) => integer(name).notNull().default(0);
const big = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);

/** 12 log-spaced latency buckets; p50/p95 are derived from these counts (approximate, documented). */
const rollupColumns = () => ({
  projectId: projectId(),
  bucket: timestamp("bucket", { withTimezone: true }).notNull(),
  model: text("model").notNull().default(""),
  shard: smallint("shard").notNull().default(0),
  calls: n("calls"),
  inputTokens: big("input_tokens"),
  outputTokens: big("output_tokens"),
  costMicro: big("cost_micro"),
  errors: n("errors"),
  latSumMs: big("lat_sum_ms"),
  latB0: n("lat_b0"),
  latB1: n("lat_b1"),
  latB2: n("lat_b2"),
  latB3: n("lat_b3"),
  latB4: n("lat_b4"),
  latB5: n("lat_b5"),
  latB6: n("lat_b6"),
  latB7: n("lat_b7"),
  latB8: n("lat_b8"),
  latB9: n("lat_b9"),
  latB10: n("lat_b10"),
  latB11: n("lat_b11"),
});

/** Kept 48 h. */
export const metricsMinute = pgTable("metrics_minute", rollupColumns(), (t) => [
  primaryKey({ columns: [t.projectId, t.bucket, t.model, t.shard] }),
]);

/** Kept long. */
export const metricsHourly = pgTable("metrics_hourly", rollupColumns(), (t) => [
  primaryKey({ columns: [t.projectId, t.bucket, t.model, t.shard] }),
]);

export const usageDaily = pgTable(
  "usage_daily",
  {
    projectId: projectId(),
    day: date("day").notNull(),
    events: big("events"),
    /** Ingest requests (Vercel invocations are the scarcest free-tier resource). */
    requests: big("requests"),
    costMicro: big("cost_micro"),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.day] })],
);

export const budgetUsage = pgTable(
  "budget_usage",
  {
    projectId: projectId(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    periodKey: text("period_key").notNull(), // '2026-11-17', '2026-11', or a trace id
    spentMicro: big("spent_micro"),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.budgetId, t.periodKey] })],
);
