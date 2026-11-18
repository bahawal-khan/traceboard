import { createHash } from "node:crypto";

/** `lm_` + 32 random bytes, base64url (43 chars). Generation arrives with P1.8. */
export const API_KEY_PREFIX = "lm_";
const API_KEY_FORMAT = /^lm_[A-Za-z0-9_-]{43}$/;

/** Cheap shape check so garbage never reaches the database. */
export function looksLikeApiKey(raw: string): boolean {
  return API_KEY_FORMAT.test(raw);
}

/** sha256 hex: the only form in which a key is ever stored or looked up. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
