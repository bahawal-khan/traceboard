/**
 * Routes that authenticate with the CRON_SECRET bearer only (Vercel Cron): /api/jobs/*. The proxy must not hand them to
 * Clerk (no session, no API key). Exact segment match: `/api/jobsx` and `/api/dashboard/jobs` are NOT included.
 */
const CRON_ROUTE = /^\/api\/jobs(?:\/|$)/;

export function isCronRoute(pathname: string): boolean {
  return CRON_ROUTE.test(pathname);
}
