import { defaultIngestDeps } from "@/lib/ingest/default-deps";
import { createOtlpTracesHandler } from "@/lib/otlp/handler";

// Node runtime: node:crypto (key hashing, UUIDv5, content encryption) and node:zlib (gzip).
export const runtime = "nodejs";
export const maxDuration = 10;
export const dynamic = "force-dynamic";

export const POST = createOtlpTracesHandler(defaultIngestDeps());
