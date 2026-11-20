import { z } from "zod";
import { API_KEY_SCOPES } from "@/lib/api-key";

export const keyId = z.string().uuid();

export const createApiKeyInput = z
  .object({
    scopes: z
      .array(z.enum(API_KEY_SCOPES))
      .min(1, "at least one scope")
      .max(API_KEY_SCOPES.length)
      .refine((s) => new Set(s).size === s.length, "duplicate scopes")
      .default(["ingest"]),
  })
  .strict();

export type CreateApiKeyInput = z.infer<typeof createApiKeyInput>;
