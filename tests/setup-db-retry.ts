import { neonConfig } from "@neondatabase/serverless";
import { withConnectionRetry } from "./helpers/retry-fetch";

// DB tests only: make the Neon HTTP driver retry transient connection failures.
neonConfig.fetchFunction = withConnectionRetry(globalThis.fetch.bind(globalThis));
