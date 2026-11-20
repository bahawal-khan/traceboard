import { z } from "zod";
import { contentCipherFromEnv, prepareContent, type ContentCipher, type PreparedContent } from "@/lib/ingest/content";
import { LATENCY_BOUNDS_MS, randomShard, ROLLUP_SHARDS } from "@/lib/ingest/rollup";
import { RETENTION } from "@/lib/quotas";
import type { NormalizedEvent } from "@/lib/ingest/normalize";
import { withTenant, TenantError, type ApiKeyCtx } from "@/lib/repo/tenant";
import { isMissingPartitionError, MissingPartitionError, type EventStore, type PersistResult } from "./store";

/** Wire form of one row for `jsonb_to_recordset`. Every value is text, number or null; casts happen in SQL. */
function toWire(e: NormalizedEvent, content: PreparedContent | null) {
  return {
    event_id: e.eventId,
    trace_id: e.traceId,
    span_id: e.spanId,
    parent_id: e.parentId,
    thread_id: e.threadId,
    kind: e.kind,
    name: e.name,
    model: e.model,
    provider: e.provider,
    input_tokens: e.inputTokens,
    output_tokens: e.outputTokens,
    cached_tokens: e.cachedTokens,
    latency_ms: e.latencyMs,
    ttft_ms: e.ttftMs,
    cost_usd: e.costUsd,
    status: e.status,
    error: e.error,
    prompt_hash: e.promptHash,
    args_hash: e.argsHash,
    user_id_hash: e.userIdHash,
    tags: e.tags,
    occurred_at: e.occurredAt.toISOString(),
    // Ciphertext only (or null). Plaintext content never leaves this process.
    c_in: content?.input ?? null,
    c_out: content?.output ?? null,
    c_rep: content?.report ?? null,
  };
}

/**
 * The statement returns `usage` and `budgets` as jsonb, so the driver hands back parsed JSON with
 * plain numbers (counters stay far below 2^53) instead of the int8 strings a bigint column gives.
 * This schema is the single place where that result is validated and converted.
 */
const resultSchema = z.object({
  inserted: z.coerce.number().int().min(0),
  content_stored: z.coerce.number().int().min(0),
  last_viewed_at: z.union([z.date(), z.string()]).nullable(),
  conserve: z.boolean(),
  usage: z.object({ events: z.coerce.number(), requests: z.coerce.number(), cost_micro: z.coerce.number() }),
  budgets: z.array(
    z.object({
      budget_id: z.string(),
      scope: z.enum(["project", "trace"]),
      period: z.enum(["day", "month", "run"]),
      limit_usd: z.string(),
      action: z.enum(["alert", "block"]),
      period_key: z.string(),
      spent_micro: z.coerce.number(),
    }),
  ),
});

/** 40P01 deadlock detected, 40001 serialization failure: transient, and the transaction is already rolled back. */
export function isRetryableTxError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "40P01" || code === "40001";
}

function mapError(err: unknown): unknown {
  return isMissingPartitionError(err) ? new MissingPartitionError() : err;
}

/** 50 to 150 ms, so two writers that just collided do not collide again in lockstep. */
const defaultRetryDelayMs = () => 50 + Math.random() * 100;

export interface PgEventStoreOptions {
  /** Which of the ROLLUP_SHARDS rows this write uses; random by default, injectable for tests. */
  pickShard?: () => number;
  /** Delay before the single deadlock/serialization retry. Injectable for tests. */
  retryDelayMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Cipher for opt-in content. Default: built from CONTENT_ENCRYPTION_KEY on first use. When there is
   * no cipher, content is NOT stored (fail closed); it is never stored unencrypted.
   */
  cipher?: ContentCipher | null | (() => ContentCipher | null);
}

/**
 * Postgres implementation: ONE static statement, one HTTP round trip (withTenant prepends the
 * set_config for RLS in the same transaction). Rows travel as a single jsonb parameter, so no SQL
 * text is built from data, and `project_id` comes from the context.
 *
 * Everything after the insert is computed ONLY from the rows the insert actually produced
 * (`ins`, i.e. its RETURNING), never from the request batch. A duplicate batch therefore adds nothing
 * to events, `metrics_minute`, `metrics_hourly`, `usage_daily.events/cost_micro` or `budget_usage`.
 * The one exception is `usage_daily.requests`, which counts requests (invocations), duplicates included.
 *
 * Counting rules: every inserted event adds to `calls` (all kinds); model-less events (tools, custom)
 * roll up under model ''. Minute rollups are written only for events newer than 48 h. Aggregated
 * inserts are ORDERed so concurrent writers lock rows in the same order. Unknown cost counts as 0.
 * A deadlock (40P01) or serialization failure (40001) is retried ONCE after 50-150 ms; nothing else is.
 */
export class PgEventStore implements EventStore {
  private readonly pickShard: () => number;
  private readonly retryDelayMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cipherSource: ContentCipher | null | (() => ContentCipher | null);

  constructor(opts: PgEventStoreOptions = {}) {
    this.pickShard = opts.pickShard ?? randomShard;
    this.retryDelayMs = opts.retryDelayMs ?? defaultRetryDelayMs;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.cipherSource = opts.cipher === undefined ? contentCipherFromEnv : opts.cipher;
  }

  private cipher(): ContentCipher | null {
    return typeof this.cipherSource === "function" ? this.cipherSource() : this.cipherSource;
  }

  async persist(ctx: ApiKeyCtx, events: readonly NormalizedEvent[]): Promise<PersistResult> {
    if (!ctx.scopes.includes("ingest")) throw new TenantError("persist: key lacks the ingest scope");
    const projectId = ctx.projectIds[0];
    if (ctx.projectIds.length !== 1 || !projectId) throw new TenantError("persist: an API key context has exactly one project");
    if (events.length === 0) return { inserted: 0, contentStored: 0, usage: null, signals: null, budgets: [] };
    const hasContent = events.some((e) => e.content && (e.content.input !== undefined || e.content.output !== undefined));
    const cipher = hasContent ? this.cipher() : null; // no key: content is dropped, never stored in clear
    const payload = JSON.stringify(
      events.map((e) => toWire(e, cipher ? prepareContent(cipher, projectId, e.eventId, e.content) : null)),
    );
    const bounds = [...LATENCY_BOUNDS_MS];
    const shard = this.pickShard();
    if (!Number.isInteger(shard) || shard < 0 || shard >= ROLLUP_SHARDS) throw new Error("persist: shard out of range");

    const run = () => this.execute(ctx, projectId, payload, bounds, shard);
    try {
      return await run();
    } catch (first) {
      if (!isRetryableTxError(first)) throw mapError(first);
      // The whole statement rolled back, and rollups come only from rows the insert produced, so a
      // second attempt cannot double count. One retry only; the second failure is surfaced as is.
      await this.sleep(this.retryDelayMs());
      try {
        return await run();
      } catch (second) {
        throw mapError(second);
      }
    }
  }

  private async execute(ctx: ApiKeyCtx, projectId: string, payload: string, bounds: number[], shard: number): Promise<PersistResult> {
    const [rows] = await withTenant(ctx, (t) => [
      t`with src as (
          select * from jsonb_to_recordset(${payload}::jsonb) as r(
            event_id text, trace_id text, span_id text, parent_id text, thread_id text, kind text, name text,
            model text, provider text, input_tokens int, output_tokens int, cached_tokens int, latency_ms int,
            ttft_ms int, cost_usd text, status text, error text, prompt_hash text, args_hash text,
            user_id_hash text, tags jsonb, occurred_at text, c_in text, c_out text, c_rep jsonb)
        ),
        ins as (
          insert into events (
            event_id, project_id, trace_id, span_id, parent_id, thread_id, kind, name, model, provider,
            input_tokens, output_tokens, cached_tokens, latency_ms, ttft_ms, cost_usd, status, error,
            prompt_hash, args_hash, user_id_hash, tags, occurred_at)
          select r.event_id::uuid, ${projectId}::uuid, r.trace_id, r.span_id, r.parent_id, r.thread_id, r.kind, r.name, r.model, r.provider,
                 r.input_tokens, r.output_tokens, r.cached_tokens, r.latency_ms, r.ttft_ms, r.cost_usd::numeric, r.status, r.error,
                 r.prompt_hash, r.args_hash, r.user_id_hash,
                 case when jsonb_typeof(r.tags) = 'array' then array(select jsonb_array_elements_text(r.tags)) else null end,
                 r.occurred_at::timestamptz
            from src r
          on conflict (project_id, event_id, occurred_at) do nothing
          returning event_id, occurred_at, trace_id, model, status, input_tokens, output_tokens, latency_ms,
                    coalesce((cost_usd * 1000000)::bigint, 0) as cost_micro
        ),
        ev as (
          select occurred_at, trace_id, coalesce(model, '') as model, status = 'error' as is_err,
                 coalesce(input_tokens, 0) as it, coalesce(output_tokens, 0) as ot, cost_micro, latency_ms,
                 case when latency_ms is null then null else width_bucket(latency_ms, ${bounds}::int[]) end as lb
            from ins
        ),
        m as (
          insert into metrics_minute (project_id, bucket, model, shard, calls, input_tokens, output_tokens, cost_micro, errors, lat_sum_ms,
                                      lat_b0, lat_b1, lat_b2, lat_b3, lat_b4, lat_b5, lat_b6, lat_b7, lat_b8, lat_b9, lat_b10, lat_b11)
          select ${projectId}::uuid, date_trunc('minute', occurred_at), model, ${shard}::smallint, count(*)::int, sum(it), sum(ot), sum(cost_micro),
                 (count(*) filter (where is_err))::int, coalesce(sum(latency_ms), 0),
                 (count(*) filter (where lb = 0))::int, (count(*) filter (where lb = 1))::int, (count(*) filter (where lb = 2))::int,
                 (count(*) filter (where lb = 3))::int, (count(*) filter (where lb = 4))::int, (count(*) filter (where lb = 5))::int,
                 (count(*) filter (where lb = 6))::int, (count(*) filter (where lb = 7))::int, (count(*) filter (where lb = 8))::int,
                 (count(*) filter (where lb = 9))::int, (count(*) filter (where lb = 10))::int, (count(*) filter (where lb = 11))::int
            from ev
           where occurred_at > now() - interval '48 hours'
           group by date_trunc('minute', occurred_at), model
           order by date_trunc('minute', occurred_at), model
          on conflict (project_id, bucket, model, shard) do update set
            calls = metrics_minute.calls + excluded.calls,
            input_tokens = metrics_minute.input_tokens + excluded.input_tokens,
            output_tokens = metrics_minute.output_tokens + excluded.output_tokens,
            cost_micro = metrics_minute.cost_micro + excluded.cost_micro,
            errors = metrics_minute.errors + excluded.errors,
            lat_sum_ms = metrics_minute.lat_sum_ms + excluded.lat_sum_ms,
            lat_b0 = metrics_minute.lat_b0 + excluded.lat_b0, lat_b1 = metrics_minute.lat_b1 + excluded.lat_b1,
            lat_b2 = metrics_minute.lat_b2 + excluded.lat_b2, lat_b3 = metrics_minute.lat_b3 + excluded.lat_b3,
            lat_b4 = metrics_minute.lat_b4 + excluded.lat_b4, lat_b5 = metrics_minute.lat_b5 + excluded.lat_b5,
            lat_b6 = metrics_minute.lat_b6 + excluded.lat_b6, lat_b7 = metrics_minute.lat_b7 + excluded.lat_b7,
            lat_b8 = metrics_minute.lat_b8 + excluded.lat_b8, lat_b9 = metrics_minute.lat_b9 + excluded.lat_b9,
            lat_b10 = metrics_minute.lat_b10 + excluded.lat_b10, lat_b11 = metrics_minute.lat_b11 + excluded.lat_b11
          returning 1
        ),
        h as (
          insert into metrics_hourly (project_id, bucket, model, shard, calls, input_tokens, output_tokens, cost_micro, errors, lat_sum_ms,
                                      lat_b0, lat_b1, lat_b2, lat_b3, lat_b4, lat_b5, lat_b6, lat_b7, lat_b8, lat_b9, lat_b10, lat_b11)
          select ${projectId}::uuid, date_trunc('hour', occurred_at), model, ${shard}::smallint, count(*)::int, sum(it), sum(ot), sum(cost_micro),
                 (count(*) filter (where is_err))::int, coalesce(sum(latency_ms), 0),
                 (count(*) filter (where lb = 0))::int, (count(*) filter (where lb = 1))::int, (count(*) filter (where lb = 2))::int,
                 (count(*) filter (where lb = 3))::int, (count(*) filter (where lb = 4))::int, (count(*) filter (where lb = 5))::int,
                 (count(*) filter (where lb = 6))::int, (count(*) filter (where lb = 7))::int, (count(*) filter (where lb = 8))::int,
                 (count(*) filter (where lb = 9))::int, (count(*) filter (where lb = 10))::int, (count(*) filter (where lb = 11))::int
            from ev
           group by date_trunc('hour', occurred_at), model
           order by date_trunc('hour', occurred_at), model
          on conflict (project_id, bucket, model, shard) do update set
            calls = metrics_hourly.calls + excluded.calls,
            input_tokens = metrics_hourly.input_tokens + excluded.input_tokens,
            output_tokens = metrics_hourly.output_tokens + excluded.output_tokens,
            cost_micro = metrics_hourly.cost_micro + excluded.cost_micro,
            errors = metrics_hourly.errors + excluded.errors,
            lat_sum_ms = metrics_hourly.lat_sum_ms + excluded.lat_sum_ms,
            lat_b0 = metrics_hourly.lat_b0 + excluded.lat_b0, lat_b1 = metrics_hourly.lat_b1 + excluded.lat_b1,
            lat_b2 = metrics_hourly.lat_b2 + excluded.lat_b2, lat_b3 = metrics_hourly.lat_b3 + excluded.lat_b3,
            lat_b4 = metrics_hourly.lat_b4 + excluded.lat_b4, lat_b5 = metrics_hourly.lat_b5 + excluded.lat_b5,
            lat_b6 = metrics_hourly.lat_b6 + excluded.lat_b6, lat_b7 = metrics_hourly.lat_b7 + excluded.lat_b7,
            lat_b8 = metrics_hourly.lat_b8 + excluded.lat_b8, lat_b9 = metrics_hourly.lat_b9 + excluded.lat_b9,
            lat_b10 = metrics_hourly.lat_b10 + excluded.lat_b10, lat_b11 = metrics_hourly.lat_b11 + excluded.lat_b11
          returning 1
        ),
        u as (
          insert into usage_daily (project_id, day, events, requests, cost_micro)
          select ${projectId}::uuid, (now() at time zone 'UTC')::date, (select count(*) from ins), 1, (select coalesce(sum(cost_micro), 0) from ins)
          on conflict (project_id, day) do update set
            events = usage_daily.events + excluded.events,
            requests = usage_daily.requests + excluded.requests,
            cost_micro = usage_daily.cost_micro + excluded.cost_micro
          returning events, requests, cost_micro
        ),
        c as (
          insert into event_content (event_id, project_id, input_text, output_text, redaction_report, expires_at)
          select distinct on (i.event_id) i.event_id, ${projectId}::uuid, s.c_in, s.c_out, s.c_rep,
                 now() + make_interval(days => least(p.content_retention_days, ${RETENTION.contentDays}::int))
            from ins i
            join src s on s.event_id::uuid = i.event_id and s.occurred_at::timestamptz = i.occurred_at
            join projects p on p.id = ${projectId}::uuid and p.capture_content
           where s.c_in is not null or s.c_out is not null
           order by i.event_id
          on conflict (project_id, event_id) do nothing
          returning 1
        ),
        bk as (
          select k.budget_id, k.period_key, sum(k.cost_micro) as spent
            from (
              select b.id as budget_id, ev.cost_micro,
                     case when b.scope = 'trace' then ev.trace_id
                          when b.period = 'day' then to_char(ev.occurred_at at time zone 'UTC', 'YYYY-MM-DD')
                          when b.period = 'month' then to_char(ev.occurred_at at time zone 'UTC', 'YYYY-MM')
                     end as period_key
                from ev
                join budgets b on b.project_id = ${projectId}::uuid
            ) k
           where k.period_key is not null
           group by k.budget_id, k.period_key
          having sum(k.cost_micro) > 0
           order by k.budget_id, k.period_key
        ),
        bu as (
          insert into budget_usage (project_id, budget_id, period_key, spent_micro)
          select ${projectId}::uuid, budget_id, period_key, spent from bk
          on conflict (project_id, budget_id, period_key) do update set
            spent_micro = budget_usage.spent_micro + excluded.spent_micro
          returning budget_id, period_key, spent_micro
        )
        select (select count(*) from ins)::int as inserted,
               (select count(*) from c)::int as content_stored,
               (select p.last_viewed_at from projects p where p.id = ${projectId}::uuid) as last_viewed_at,
               coalesce((select value = 'true'::jsonb from app_state where key = 'conserve'), false) as conserve,
               (select to_jsonb(u) from u) as usage,
               coalesce((select jsonb_agg(jsonb_build_object(
                   'budget_id', bu.budget_id, 'scope', bg.scope, 'period', bg.period, 'limit_usd', bg.limit_usd::text,
                   'action', bg.action, 'period_key', bu.period_key, 'spent_micro', bu.spent_micro))
                 from bu join budgets bg on bg.id = bu.budget_id), '[]'::jsonb) as budgets`,
    ]);
    const r = resultSchema.parse(rows[0]);
    return {
      inserted: r.inserted,
      contentStored: r.content_stored,
      signals: { lastViewedAt: r.last_viewed_at === null ? null : new Date(r.last_viewed_at), conserve: r.conserve },
      usage: { events: r.usage.events, requests: r.usage.requests, costMicro: r.usage.cost_micro },
      budgets: r.budgets.map((b) => ({
        budgetId: b.budget_id,
        scope: b.scope,
        period: b.period,
        limitUsd: b.limit_usd,
        action: b.action,
        periodKey: b.period_key,
        spentMicro: b.spent_micro,
      })),
    };
  }
}
