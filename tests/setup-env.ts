// Load .env.local for local integration tests. In CI these come from the environment.
try {
  process.loadEnvFile(".env.local");
} catch {
  /* optional */
}
