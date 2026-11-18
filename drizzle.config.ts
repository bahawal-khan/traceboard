import { defineConfig } from "drizzle-kit";

// Local convenience only; CI/Vercel provide real env vars. Never printed.
try {
  process.loadEnvFile(".env.local");
} catch {
  /* no local env file */
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema/index.ts",
  out: "./db/migrations",
  // Migrations run as the `migrator` role over a DIRECT (non-pooled) connection.
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
