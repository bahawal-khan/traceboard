/**
 * CSRF defence for cookie-authenticated mutations (docs/SECURITY.md): the browser must send an
 * Origin equal to this server's own origin. Requests without Origin (non-browser clients) are refused:
 * dashboard APIs are for the dashboard only; ingest uses API keys on a different route family.
 */
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
