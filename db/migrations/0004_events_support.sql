CREATE TABLE "budget_usage" (
	"project_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"spent_micro" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "budget_usage_project_id_budget_id_period_key_pk" PRIMARY KEY("project_id","budget_id","period_key")
);
--> statement-breakpoint
CREATE TABLE "event_content" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"input_text" text,
	"output_text" text,
	"redaction_report" jsonb,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics_hourly" (
	"project_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"shard" smallint DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micro" bigint DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"lat_sum_ms" bigint DEFAULT 0 NOT NULL,
	"lat_b0" integer DEFAULT 0 NOT NULL,
	"lat_b1" integer DEFAULT 0 NOT NULL,
	"lat_b2" integer DEFAULT 0 NOT NULL,
	"lat_b3" integer DEFAULT 0 NOT NULL,
	"lat_b4" integer DEFAULT 0 NOT NULL,
	"lat_b5" integer DEFAULT 0 NOT NULL,
	"lat_b6" integer DEFAULT 0 NOT NULL,
	"lat_b7" integer DEFAULT 0 NOT NULL,
	"lat_b8" integer DEFAULT 0 NOT NULL,
	"lat_b9" integer DEFAULT 0 NOT NULL,
	"lat_b10" integer DEFAULT 0 NOT NULL,
	"lat_b11" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "metrics_hourly_project_id_bucket_model_shard_pk" PRIMARY KEY("project_id","bucket","model","shard")
);
--> statement-breakpoint
CREATE TABLE "metrics_minute" (
	"project_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"shard" smallint DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micro" bigint DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"lat_sum_ms" bigint DEFAULT 0 NOT NULL,
	"lat_b0" integer DEFAULT 0 NOT NULL,
	"lat_b1" integer DEFAULT 0 NOT NULL,
	"lat_b2" integer DEFAULT 0 NOT NULL,
	"lat_b3" integer DEFAULT 0 NOT NULL,
	"lat_b4" integer DEFAULT 0 NOT NULL,
	"lat_b5" integer DEFAULT 0 NOT NULL,
	"lat_b6" integer DEFAULT 0 NOT NULL,
	"lat_b7" integer DEFAULT 0 NOT NULL,
	"lat_b8" integer DEFAULT 0 NOT NULL,
	"lat_b9" integer DEFAULT 0 NOT NULL,
	"lat_b10" integer DEFAULT 0 NOT NULL,
	"lat_b11" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "metrics_minute_project_id_bucket_model_shard_pk" PRIMARY KEY("project_id","bucket","model","shard")
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"events" bigint DEFAULT 0 NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"cost_micro" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_project_id_day_pk" PRIMARY KEY("project_id","day")
);
--> statement-breakpoint
ALTER TABLE "budget_usage" ADD CONSTRAINT "budget_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_usage" ADD CONSTRAINT "budget_usage_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_content" ADD CONSTRAINT "event_content_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_hourly" ADD CONSTRAINT "metrics_hourly_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_minute" ADD CONSTRAINT "metrics_minute_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_content_project_idx" ON "event_content" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "event_content_expires_idx" ON "event_content" USING btree ("expires_at");