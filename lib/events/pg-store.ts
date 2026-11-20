import { withTenant, TenantError, type ApiKeyCtx } from "@/lib/repo/tenant";
import type { NormalizedEvent } from "@/lib/ingest/normalize";
import { isMissingPartitionError, MissingPartitionError, type EventStore, type PersistResult } from "./store";

/** Wire form of one row for `jsonb_to_recordset`. Every value is text, number or null; casts happen in SQL. */
function toWire(e: NormalizedEvent) {
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
  };
}

/**
 * Postgres implementation. ONE static statement and one HTTP round trip (withTenant prepends the
 * set_config for RLS in the same transaction). The rows travel as a single jsonb parameter, so no
 * SQL text is ever built from data. `project_id` comes from the context, not from the rows.
 * Idempotent: `unique (project_id, event_id, occurred_at)` + ON CONFLICT DO NOTHING, which also
 * skips duplicates inside the same batch. P2.4b extends this statement with rollups, usage and budgets.
 */
export class PgEventStore implements EventStore {
  async persist(ctx: ApiKeyCtx, events: readonly NormalizedEvent[]): Promise<PersistResult> {
    if (!ctx.scopes.includes("ingest")) throw new TenantError("persist: key lacks the ingest scope");
    const projectId = ctx.projectIds[0];
    if (ctx.projectIds.length !== 1 || !projectId) throw new TenantError("persist: an API key context has exactly one project");
    if (events.length === 0) return { inserted: 0 };
    const payload = JSON.stringify(events.map(toWire));

    try {
      const [rows] = await withTenant(ctx, (t) => [
        t`with ins as (
            insert into events (
              event_id, project_id, trace_id, span_id, parent_id, thread_id, kind, name, model, provider,
              input_tokens, output_tokens, cached_tokens, latency_ms, ttft_ms, cost_usd, status, error,
              prompt_hash, args_hash, user_id_hash, tags, occurred_at)
            select r.event_id::uuid, ${projectId}::uuid, r.trace_id, r.span_id, r.parent_id, r.thread_id, r.kind, r.name, r.model, r.provider,
                   r.input_tokens, r.output_tokens, r.cached_tokens, r.latency_ms, r.ttft_ms, r.cost_usd::numeric, r.status, r.error,
                   r.prompt_hash, r.args_hash, r.user_id_hash,
                   case when jsonb_typeof(r.tags) = 'array' then array(select jsonb_array_elements_text(r.tags)) else null end,
                   r.occurred_at::timestamptz
              from jsonb_to_recordset(${payload}::jsonb) as r(
                event_id text, trace_id text, span_id text, parent_id text, thread_id text, kind text, name text,
                model text, provider text, input_tokens int, output_tokens int, cached_tokens int, latency_ms int,
                ttft_ms int, cost_usd text, status text, error text, prompt_hash text, args_hash text,
                user_id_hash text, tags jsonb, occurred_at text)
            on conflict (project_id, event_id, occurred_at) do nothing
            returning 1
          )
          select count(*)::int as inserted from ins`,
      ]);
      return { inserted: Number(rows[0]?.inserted ?? 0) };
    } catch (err) {
      if (isMissingPartitionError(err)) throw new MissingPartitionError();
      throw err;
    }
  }
}
