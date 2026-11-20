import { neonConfig } from "@neondatabase/serverless";
import { configureLocalNeon } from "../db/neon-local.mjs";
import { withConnectionRetry } from "./helpers/retry-fetch";

// DB tests only: make the Neon HTTP driver retry transient connection failures.
neonConfig.fetchFunction = withConnectionRetry(globalThis.fetch.bind(globalThis));

// CI / local proxy: point the driver at it when DATABASE_URL uses the local host (no-op for real Neon).
configureLocalNeon(process.env.DATABASE_URL);
