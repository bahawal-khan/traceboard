// Seeds / refreshes the global model_prices table from db/seed/model-prices.json.
//   npm run db:seed
// Runs as the `migrator` role (MIGRATION_DATABASE_URL, direct host): app_rw has no write access to
// model_prices on purpose. Upsert only; models absent from the file are left untouched.
import { neon } from "@neondatabase/serverless";
import { configureLocalNeon } from "../db/neon-local.mjs";
import { loadModelPrices } from "../db/seed/model-prices.schema.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env may come from the shell */
}

if (!process.env.MIGRATION_DATABASE_URL) {
  console.error("Missing environment variable: MIGRATION_DATABASE_URL");
  process.exit(1);
}

const file = loadModelPrices(); // throws (naming the bad field) on invalid data, before any write
configureLocalNeon(process.env.MIGRATION_DATABASE_URL); // CI / local proxy only
const sql = neon(process.env.MIGRATION_DATABASE_URL);

const upsert = (m) =>
  sql`insert into model_prices (model, provider, input_per_1m, output_per_1m, cached_input_per_1m, updated_at)
      values (${m.model}, ${m.provider}, ${m.inputPer1m}::numeric, ${m.outputPer1m}::numeric, ${m.cachedInputPer1m}::numeric, now())
      on conflict (model) do update set
        provider = excluded.provider,
        input_per_1m = excluded.input_per_1m,
        output_per_1m = excluded.output_per_1m,
        cached_input_per_1m = excluded.cached_input_per_1m,
        updated_at = now()`;

await sql.transaction(file.models.map(upsert));
console.log(`Seeded ${file.models.length} model prices (sources verified ${Object.values(file.sources).map((s) => s.verifiedOn).sort().at(-1)}).`);
