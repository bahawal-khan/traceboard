import { isIP } from "node:net";

/**
 * First hop of x-forwarded-for if it is a valid IP; otherwise null. On Vercel this header is
 * overwritten by the platform (it does not forward client-supplied values), so it is trustworthy
 * there (verified against Vercel's request-headers docs). Anywhere else it is client controlled:
 * use it for rate limiting and audit hints only, never for access decisions.
 */
export function clientIp(request: Request): string | null {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first && isIP(first) ? first : null;
}
