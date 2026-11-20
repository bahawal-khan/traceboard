import { createIngestHandler } from "@/lib/ingest/handler";
import { defaultIngestDeps } from "@/lib/ingest/default-deps";

// Node runtime: node:crypto (key hashing, content encryption) and node:zlib (gzip).
export const runtime = "nodejs";
// Fail fast instead of holding an invocation: the Hobby limit is 300 s (verified), a healthy ingest takes well under 1 s.
export const maxDuration = 10;
export const dynamic = "force-dynamic";

export const POST = createIngestHandler(defaultIngestDeps());
