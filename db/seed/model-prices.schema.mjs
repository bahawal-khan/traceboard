import { readFileSync } from "node:fs";
import { z } from "zod";

/** Shared by scripts/seed-prices.mjs and the tests. Prices are decimal STRINGS (no float noise). */
const price = z.string().regex(/^\d+(\.\d{1,6})?$/, "decimal with at most 6 places");

const longContext = z
  .object({
    thresholdTokens: z.number().int().positive(),
    inputPer1m: price,
    cachedInputPer1m: price.nullable(),
    outputPer1m: price,
  })
  .strict();

export const PROVIDERS = ["openai", "anthropic", "google"];

export const modelEntry = z
  .object({
    model: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,80}$/, "lowercase api model id"),
    provider: z.enum(PROVIDERS),
    inputPer1m: price,
    cachedInputPer1m: price.nullable(),
    outputPer1m: price,
    longContext: longContext.optional(),
  })
  .strict();

const source = z.object({ url: z.string().url().startsWith("https://"), verifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

export const modelPriceFile = z
  .object({
    _comment: z.string().optional(),
    sources: z.object({ openai: source, anthropic: source, google: source }).strict(),
    models: z.array(modelEntry).min(1),
    excluded: z.array(z.object({ model: z.string(), reason: z.string() }).strict()),
  })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set();
    for (const [i, m] of f.models.entries()) {
      if (seen.has(m.model)) ctx.addIssue({ code: "custom", path: ["models", i, "model"], message: "duplicate model id" });
      seen.add(m.model);
      if (m.cachedInputPer1m !== null && Number(m.cachedInputPer1m) > Number(m.inputPer1m)) {
        ctx.addIssue({ code: "custom", path: ["models", i, "cachedInputPer1m"], message: "cached price above input price" });
      }
    }
  });

export function loadModelPrices(path = new URL("./model-prices.json", import.meta.url)) {
  return modelPriceFile.parse(JSON.parse(readFileSync(path, "utf8")));
}
