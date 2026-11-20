import { z } from "zod";
import { API_KEY_SCOPES } from "@/lib/api-key";

export const keyId = z.string().uuid();

/** Optional label: trimmed, at most 60 characters, may be empty, no control characters. */
export const apiKeyName = z
  .string()
  .trim()
  .max(60, "name is too long")
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "invalid characters");

export const createApiKeyInput = z
  .object({
    name: apiKeyName.default(""),
    scopes: z
      .array(z.enum(API_KEY_SCOPES))
      .min(1, "at least one scope")
      .max(API_KEY_SCOPES.length)
      .refine((s) => new Set(s).size === s.length, "duplicate scopes")
      .default(["ingest"]),
  })
  .strict();

export type CreateApiKeyInput = z.infer<typeof createApiKeyInput>;
