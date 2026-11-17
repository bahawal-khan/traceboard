import { z } from "zod";

/**
 * Environment validation (zod). Parsed at build/boot so a missing secret
 * fails fast. Values are never logged; errors list variable names only.
 */
const base64Key32 = z.string().refine(
  (v) => {
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  },
  { message: "must be 32 bytes, base64 encoded" },
);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: optionalString, // CI only, never in the Vercel runtime
  CLERK_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CRON_SECRET: z.string().min(16),
  JOB_HMAC_SECRET: z.string().min(32),
  PROVIDER_KEY_MASTER_KEY: base64Key32,
  MAX_USERS: z.coerce.number().int().positive().default(10),
  DEMO_SOURCE: z.enum(["static", "db"]).default("static"),
  NEON_API_KEY: optionalString,
  PORTFOLIO_ORIGIN: optionalString,
  RESEND_API_KEY: optionalString, // optional; not enabled by the owner
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly variables: string[]) {
    super(`Invalid environment variables: ${variables.join(", ")}`);
    this.name = "EnvError";
  }
}

/** Pure parser (testable). Throws EnvError naming the bad variables only. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((i) => String(i.path[0])))];
    throw new EnvError(names);
  }
  return result.data;
}

let cached: Env | undefined;

/** Lazy validated env for runtime code. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
