import { after } from "next/server";
import { PgEventStore } from "@/lib/events/pg-store";
import { authenticateApiKeyRequest } from "@/lib/http/api-key-request";
import { QUOTAS } from "@/lib/quotas";
import { touchApiKey } from "@/lib/repo/api-keys";
import { loadModelPrices } from "@/lib/repo/prices";
import { readUsageToday } from "@/lib/repo/usage";
import { PriceBook } from "./cost";
import type { IngestDeps } from "./handler";
import { UsageGate } from "./quota";

let deps: IngestDeps | undefined;

/** Production wiring, built once per instance (the caches live in it). */
export function defaultIngestDeps(): IngestDeps {
  deps ??= {
    authenticate: (request) => authenticateApiKeyRequest(request, "ingest"),
    quota: new UsageGate(readUsageToday, { eventsPerDay: QUOTAS.eventsPerDayPerProject, requestsPerDay: QUOTAS.ingestRequestsPerDayPerProject }),
    prices: new PriceBook(loadModelPrices),
    store: new PgEventStore(),
    touchKey: touchApiKey,
    afterResponse: (work) => after(work),
  };
  return deps;
}
