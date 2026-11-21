import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Cron authentication: `Authorization: Bearer <CRON_SECRET>` (what Vercel Cron sends when CRON_SECRET is set).
 * Both sides are hashed first so the comparison is constant time and length-independent (timingSafeEqual needs equal
 * lengths). Fails closed: a missing or too-short secret (< 16 chars, same rule as lib/env.ts) never authenticates.
 */
const BEARER = /^Bearer[ \t]+(\S+)$/i;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function isCronAuthorized(headers: Pick<Headers, "get">, secret: string | undefined): boolean {
  if (!secret || secret.length < 16) return false;
  const m = BEARER.exec(headers.get("authorization") ?? "");
  if (!m) return false;
  return timingSafeEqual(sha256(m[1]!), sha256(secret));
}
