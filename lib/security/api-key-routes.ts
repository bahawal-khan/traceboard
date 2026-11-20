/**
 * Routes that authenticate with an API key (`Authorization: Bearer lm_...`), never with a Clerk session:
 * the SDK/OTLP ingest endpoints. The proxy must not hand these to Clerk at all, so Clerk never inspects
 * their Authorization header (it could treat a foreign bearer token as its own machine/session token).
 * The match is exact on the path segment, so `/api/ingestx` and `/api/dashboard/...` are NOT included.
 */
const API_KEY_ROUTE = /^\/api\/(?:ingest|otlp)(?:\/|$)/;

export function isApiKeyRoute(pathname: string): boolean {
  return API_KEY_ROUTE.test(pathname);
}
