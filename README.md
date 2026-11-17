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

## License

MIT, see [LICENSE](./LICENSE).
