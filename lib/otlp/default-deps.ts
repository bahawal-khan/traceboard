import { defaultIngestDeps } from "@/lib/ingest/default-deps";
import { WantedSpanCache } from "./map";
import type { OtlpDeps } from "./handler";

/** Only the literal "false" turns the GenAI-only filter off; anything else (unset, a typo) keeps it ON, which protects the quota. */
export function otlpGenAiOnlyFromEnv(source: Record<string, string | undefined>): boolean {
  return (source.OTLP_GENAI_ONLY ?? "").trim().toLowerCase() !== "false";
}

let deps: OtlpDeps | undefined;

/** Production wiring: the ingest deps (shared caches) plus the OTLP filter switch and its per-instance memory. */
export function defaultOtlpDeps(): OtlpDeps {
  deps ??= { ...defaultIngestDeps(), genAiOnly: otlpGenAiOnlyFromEnv(process.env), wanted: new WantedSpanCache() };
  return deps;
}
