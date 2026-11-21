# TraceBoard

Open-source LLM observability and evaluation: live traces, cost and latency, agent loop guard, and trustworthy evals.
It is built to fit the free tiers of Vercel (Hobby) and Neon (Free), with nothing else to run.

**Status: under active development.** Working today: accounts and projects, API keys, the ingest API, the OTLP endpoint,
the Python SDK, retention and storage protection (a daily job), and the security model below. Not built yet: the dashboard
views for traces and live data, the Guard, datasets and experiments, judges. Numbers in this README are measured unless it
says otherwise; anything not measured is not stated.

## Send data in 2 minutes

You need an API key (it starts with `lm_`): sign in, create a project, then create a key under the project's API keys. The key
is shown once; only its SHA-256 hash is stored. Keep it in an environment variable or a secret store, never in source control.

Pick one way to attach an app. All of them use the same key as a bearer token.

| Way | When | Code you add |
|---|---|---|
| Python SDK | Python apps using OpenAI or Anthropic | 3 lines ([SDK guide](./sdk/python/README.md)) |
| OTLP | anything already instrumented with OpenTelemetry (LangChain, LangGraph, OpenAI or Anthropic instrumentors) | none: exporter environment variables only |
| HTTP | any other language | one `POST` ([ingest API](#ingest-api)) |

### Python SDK

Standard library only, Python 3.9 to 3.15. It never raises into your app, never blocks on the network, and hashes prompts and
arguments before anything leaves your process.

```bash
pip install ./sdk/python                    # from this repository; not on PyPI yet
export LLM_MONITOR_API_KEY=...              # your lm_ key (set it in your shell or secret store; do not paste it in code)
export LLM_MONITOR_URL=https://<your-deployment>
```

```python
from openai import OpenAI
from llm_monitor import Monitor
from llm_monitor.integrations.openai import instrument_openai   # or .anthropic: instrument_anthropic

client = instrument_openai(OpenAI(), Monitor())   # calls are now recorded: tokens, cached tokens, latency, time to first token
```

No provider account yet? `python sdk/python/examples/demo.py` sends a simulated support agent through the real wrappers and
needs no LLM key (default seed: 77 events in 14 traces: 14 agent, 31 LLM, 18 retrieval and 14 tool events, one failing tool,
one looping agent); `--dry-run` prints what would be sent and needs no key or network. The wrappers are tested against the
real `openai` and `anthropic` packages on every supported Python version.

### OpenTelemetry (OTLP)

Point any OTLP/HTTP trace exporter at the endpoint. Nothing else changes in the app:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://<your-deployment>/api/otlp/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer <your lm_ key>"   # "Bearer%20<key>" works too
```

`POST /api/otlp/v1/traces` accepts OTLP **protobuf** (`application/x-protobuf`, what the Python, Java and Go exporters send) and
OTLP **JSON** (`application/json`); `Content-Encoding: gzip` is accepted. The reply uses the request's encoding: `200` with an
empty body (or `{}`), or a `partialSuccess` with the number of rejected spans. Verified with the real OpenTelemetry Python
exporter (1.45.2): its protobuf request is decoded and stored as sent. The Python exporter always sends protobuf, even if
`OTEL_EXPORTER_OTLP_PROTOCOL` says `http/json`.

* **GenAI-only filter (default on).** Only GenAI spans and their ancestors are stored: spans with `gen_ai.*` attributes
  (OpenTelemetry GenAI conventions), OpenInference (`openinference.span.kind`, `llm.*`) or OpenLLMetry (`traceloop.span.kind`).
  Plain HTTP or database spans from auto-instrumentation are dropped so they do not use your daily event quota; a plain span
  that is the parent of a kept span is kept so the trace tree stays whole. Set the server variable `OTLP_GENAI_ONLY=false`
  to store every span. Spans left out by the filter are not reported as rejected.
* **Mapping.** Span start time becomes the event time; model, provider, input, output and cached tokens, time to first
  chunk, conversation id, agent and tool names are read from the span attributes; status `ERROR` becomes an error. The event
  id is derived from trace id and span id, so exporting the same span twice stores it once. Cost is computed on the server.
* **Privacy.** Prompt and completion text attributes (`gen_ai.input.messages`, `input.value`, `llm.input_messages.*`, ...) are
  never read, so content cannot be stored through this endpoint.
* **Limits.** At most 512 spans per request, 1,000,000 bytes compressed, 4,000,000 bytes decompressed; the same bearer key,
  rate limits and daily quota as the ingest API. Clients should retry only `429`, `502`, `503` and `504`; permanent faults
  are `4xx`.

A runnable check with the real exporter: `sdk/python/examples/otlp_demo.py`.

## Ingest API

`POST /api/ingest` with `Authorization: Bearer <lm_ key>` and `Content-Type: application/json` (optionally
`Content-Encoding: gzip`). The key needs the `ingest` scope (the default).

```bash
# LLM_MONITOR_API_KEY and LLM_MONITOR_URL come from your environment (do not paste the key into commands that end up in history)
curl -sS -X POST "$LLM_MONITOR_URL/api/ingest" \
  -H "Authorization: Bearer $LLM_MONITOR_API_KEY" -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{"events":[{"event_id":"$(uuidgen)","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","kind":"llm","model":"gpt-4o","provider":"openai",
 "input_tokens":1200,"output_tokens":80,"cached_tokens":1024,"latency_ms":830}]}
JSON
```

| Field | Type | Notes |
|---|---|---|
| `event_id` | uuid | required; with `ts` and the project it is the idempotency key |
| `ts` | ISO 8601 with offset or `Z` | required; must be within 24 hours of now (else rejected as `ts_too_old` or `ts_in_future`) |
| `kind` | `llm` `tool` `agent` `retrieval` `custom` | default `llm` |
| `trace_id` `span_id` `parent_id` `thread_id` | string, 1 to 128 chars | build trace trees and conversations |
| `name` `model` `provider` | string | up to 200, 100 and 50 chars |
| `input_tokens` `output_tokens` `cached_tokens` | integer 0 to 10,000,000 | `input_tokens` is the TOTAL prompt; `cached_tokens` is the part of it served from the provider's cache (a subset, never added on top) |
| `latency_ms` `ttft_ms` | integer 0 to 86,400,000 | |
| `status` / `error` | `ok` or `error` / up to 500 chars | error text is redacted by the SDK |
| `prompt_hash` `args_hash` `user_id_hash` | lowercase sha256 hex | the SDK sends hashes only |
| `tags` | up to 10 strings, 40 chars each | |
| `content` | `{input?, output?}`, up to 2,048 bytes each | stored only if the project opted in; encrypted at rest |

Unknown fields are refused (`422`): a client cannot send a cost or a project id; cost is computed on the server from a price
list. Up to 100 events and 256,000 bytes per request (compressed and decompressed).

* **Success:** `202 {"accepted", "duplicates", "rejected": [{"event_id","reason"}], "guard": {"status","exceeded"}, "flush_hint_ms"}`.
  Resending a batch is safe: a duplicate is stored once and counted once. Do not resend `rejected` events. `flush_hint_ms`
  tells the client how long to wait before the next flush (1 s while someone watches the project live, 10 to 15 s otherwise,
  60 s when the deployment protects its storage). If the project's daily content cap cut off captured content, the reply also
  has `content_dropped` (the events themselves are still stored).
* **Errors** (always a generic body with a request id): `401` unauthorized, `403` key lacks the scope, `413` too large,
  `415` unsupported content type or encoding, `400` invalid JSON, `422` invalid request, `429` rate limited or quota exceeded
  (with `Retry-After`; a daily quota resets at UTC midnight), `503` database unreachable or a partition missing, `500` internal.
  Retry `429`, `5xx` and network errors with backoff; do not retry other `4xx`.

## Limits, retention and storage (free-tier budget)

Every number is a constant in `lib/quotas.ts`; a paid plan only raises them.

| Limit | Value |
|---|---|
| Events per project per day | 1,900 |
| Ingest requests per project per day | 3,000 |
| Projects per user / keys per project | 2 / 5 |
| Content rows (opt-in, encrypted) per project per day | 200 (each up to 2,048 bytes in and out) |
| Request rate (per instance) | per IP: burst 120, 30 per second; per key: burst 20, 5 per second; failed authentications: burst 10, 1 per second per IP |
| Users on the free deployment | `MAX_USERS` (default 10) |

**Retention** (enforced by a daily job): events 14 days (about 15 on disk: 14 plus one day of purge lag), captured content 3
days, per-minute rollups 48 hours, hourly rollups 90 days, daily usage 400 days.

**Storage, measured.** Bytes per event row including every index, measured on PostgreSQL 18.7 with four runs of 10,000 rows
each (2026-11-20): lean events (about 300 bytes of payload) 561 bytes per row, heavy events (about 550 bytes) 840 bytes per
row; the two runs of each profile differ by under 1%. The quotas use the heavy figure plus a 25% margin (1,050 bytes). A rollup
row measured 227 bytes, a daily usage row 115 bytes, and a maximum-size encrypted content row 6,537 bytes. With 20 projects
(the default user cap) every one at every quota at once, the metered total is 871.7 MB (87.2%) of the 1 GB Neon Free limit, of
which events are 598.5 MB; a test fails if a quota or a retention is raised without this math still fitting. The measurement
and the math are in `db/measurements/event-row-size.json` and `tests/quotas-capacity.test.ts`.

**Storage guard.** The daily job measures the database. At 70% of the budget the deployment tells SDKs to flush less often;
at 85% it stops accepting new signups (existing users and ingest keep working); each level is left only 5 points lower so it
does not flap.

## Development

Requirements: Node.js 20.19+ (CI runs Node 22).

```bash
npm install
npm run dev        # http://localhost:3000
npm run check      # lint + typecheck + tests
```

Copy `.env.example` to `.env.local` and fill in the values before running a production build (set `SKIP_ENV_VALIDATION=1`
to build without secrets, e.g. in CI). The variables are: `DATABASE_URL` (runtime role, pooled host), `JOB_DATABASE_URL` (the
daily job's role), `MIGRATION_DATABASE_URL` (migrations, CI only, never in the runtime), the Clerk keys, `CRON_SECRET`,
`JOB_HMAC_SECRET`, `PROVIDER_KEY_MASTER_KEY`, optional `CONTENT_ENCRYPTION_KEY`, `OTLP_GENAI_ONLY` and `MAX_USERS`.

Database setup: `npm run db:setup-roles` creates the three database roles once per branch (runtime, migrations, daily job),
`npm run db:migrate` applies the migrations, `npm run db:seed` loads the model price list. A cron entry in `vercel.json` calls
`/api/jobs/daily` once a day (the free plan allows one run per day, at any minute of the hour); the route accepts only the
`CRON_SECRET` bearer and is safe to run late or twice.

## Testing

```bash
npm run test:unit   # no database needed
npm run test:db     # IDOR, RLS, ingest, OTLP, daily job; needs DATABASE_URL in .env.local (a Neon dev branch)
npm test            # both
```

The database tests share one database and always run one file at a time. To run part of them: `npm run test:db:ingest`,
`test:db:security`, `test:db:control` or `test:db:jobs`; `npm run test:db:timed` prints how many database round trips each file
makes and how long they take, and `npm run db:ping` shows the round-trip time to the database first. A slow link to a remote
database is the main cost of a full local run. The Python SDK tests run with `cd sdk/python && python -m pytest`.

CI runs three jobs: lint, typecheck, unit tests and build; the database tests against a throwaway Postgres container behind a
Neon-compatible HTTP proxy; and the Python SDK on Python 3.9 to 3.15 against the real `openai` and `anthropic` packages (pinned,
dev-only, no secrets). Set `SKIP_DB_TESTS=1` to skip the database tests on purpose.

## Security

Each user sees only their own data. This is enforced in three independent layers:

1. **Repository layer.** All tenant data access goes through `lib/repo/*` and `withTenant(ctx, ...)`. A tenant
   context can only be created from a validated Clerk session, a hashed API key, or the read-only demo project, and
   ESLint bans importing the database client anywhere else.
2. **Postgres row level security.** Every tenant table has RLS enabled and forced, and the runtime role is not an owner and has no `BYPASSRLS`.
   With no tenant context every query returns zero rows (fail closed).
3. **Automated tests.** IDOR tests (user A against user B) cover every dashboard route and entity and the ingest and OTLP
   routes, RLS tests run as the runtime role, and a coverage test fails if a new table is added without RLS.

Other controls: API keys are stored as SHA-256 hashes only and shown once, and are never logged (the logger redacts
secret-looking values); a revoked key stops working within 60 seconds; ingest has per-IP and per-key rate limits, a stricter
budget for failed authentications and daily quotas; prompts are hashed in the SDK and no raw prompt is stored by default;
opt-in content is redacted in the SDK and encrypted at rest; mutations require a same-origin request; dashboard responses are
`private, no-store`; a strict nonce-based Content-Security-Policy and standard security headers are set on every response;
signups are capped atomically in the database. Cleanup runs as a separate database role that owns nothing, has no table
access, and can only execute the maintenance functions; the runtime role cannot delete events or run DDL.

Planned and not built yet: encrypted provider keys (bring your own key) and the CI gate for judges. To report a vulnerability,
please open a private security advisory on GitHub.

## License

MIT, see [LICENSE](./LICENSE).
