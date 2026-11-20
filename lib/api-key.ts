import { createHash, randomBytes } from "node:crypto";

/** `lm_` + 32 random bytes, base64url (43 chars): 256 bits of entropy, so a plain sha256 is enough at rest. */
export const API_KEY_PREFIX = "lm_";
const API_KEY_FORMAT = /^lm_[A-Za-z0-9_-]{43}$/;
/** Characters of the raw key kept for display ("lm_" + 5): identifies a key without helping to guess it. */
const DISPLAY_PREFIX_LENGTH = 8;

/** Scopes a key can carry. `ingest`: send events (SDK, OTLP). `eval`: CLI / CI gate. Extend here only. */
export const API_KEY_SCOPES = ["ingest", "eval"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Cheap shape check so garbage never reaches the database. */
export function looksLikeApiKey(raw: string): boolean {
  return API_KEY_FORMAT.test(raw);
}

/** sha256 hex: the only form in which a key is ever stored or looked up. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface GeneratedApiKey {
  /** Shown to the user exactly once; never stored, never logged. */
  secret: string;
  hash: string;
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const secret = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { secret, hash: hashApiKey(secret), prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH) };
}
