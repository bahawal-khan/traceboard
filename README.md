# TraceBoard

Open-source LLM observability and evaluation: live traces, cost and latency, agent loop guard, and trustworthy evals.

Status: under active development.

## Development

Requirements: Node.js 20.19+ (CI runs Node 22).

```bash
npm install
npm run dev        # http://localhost:3000
npm run check      # lint + typecheck + tests
```

Copy `.env.example` to `.env.local` and fill in the values before running a production build
(set `SKIP_ENV_VALIDATION=1` to build without secrets, e.g. in CI).

## Testing

```bash
npm run test:unit   # no database needed
npm run test:db     # IDOR, RLS and repo tests; needs DATABASE_URL (Neon dev branch) in .env.local
npm test            # both
```

CI runs the unit tests and, in a separate job, the database tests against a throwaway Postgres container
(`ci/docker-compose.db.yml`) behind a Neon-compatible HTTP proxy. Set `SKIP_DB_TESTS=1` to skip the database tests
on purpose.

## Security

Each user sees only their own data. This is enforced in three independent layers:

1. **Repository layer.** All tenant data access goes through `lib/repo/*` and `withTenant(ctx, ...)`. A tenant
   context can only be created from a validated Clerk session, a hashed API key, or the read-only demo project, and
   ESLint bans importing the database client anywhere else.
2. **Postgres row level security.** Every tenant table has RLS enabled and forced, and the runtime role is not an owner and has no `BYPASSRLS`.
   With no tenant context every query returns zero rows (fail closed).
3. **Automated tests.** IDOR tests (user A against user B) cover every dashboard route and entity, RLS tests run as the runtime
   role, and a coverage test fails if a new table is added without RLS.

Other controls in this phase: API keys are stored as sha256 hashes only and shown once; provider and API keys are never
logged (the logger redacts secret-looking values); mutations require a same-origin request; responses to the dashboard are
`private, no-store`; a strict nonce-based Content-Security-Policy and standard security headers are set on every response;
signups are capped atomically in the database; no raw prompts are stored by default.

Planned and not built yet: rate limiting and quotas on ingest, encrypted provider keys (BYOK), the CI gate for judges.
See `docs/SECURITY.md` for the full threat model. To report a vulnerability, please open a private security advisory on GitHub.

## License

MIT, see [LICENSE](./LICENSE).
