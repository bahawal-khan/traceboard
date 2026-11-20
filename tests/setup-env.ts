// Load .env.local for local integration tests. In CI these come from the environment.
try {
  process.loadEnvFile(".env.local");
} catch {
  /* optional */
}

// SKIP_DB_TESTS=1 is an explicit opt-out: make sure a DATABASE_URL loaded from .env.local cannot
// make the database tests run anyway (they skip themselves when DATABASE_URL is unset).
if (process.env.SKIP_DB_TESTS === "1") delete process.env.DATABASE_URL;
