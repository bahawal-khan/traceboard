import { getSql } from "@/lib/db/client";
import { retryOnConnectionError } from "@/lib/errors/connection";
import type { ModelPrice } from "@/lib/ingest/cost";

/** The global price list (read-only for app_rw, not tenant data). numeric columns are read as text. */
export async function loadModelPrices(): Promise<ModelPrice[]> {
  const rows = await retryOnConnectionError(
    () => getSql()`select model, input_per_1m::text as input_per_1m, output_per_1m::text as output_per_1m, cached_input_per_1m::text as cached_input_per_1m from model_prices`,
  );
  return rows.map((r) => ({
    model: String(r.model),
    inputPer1m: String(r.input_per_1m),
    outputPer1m: String(r.output_per_1m),
    cachedInputPer1m: r.cached_input_per_1m === null ? null : String(r.cached_input_per_1m),
  }));
}
