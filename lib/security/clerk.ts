/**
 * Clerk helpers for the CSP. The publishable key encodes the instance's
 * Frontend API host: pk_(test|live)_<base64(host + "$")>.
 */
export function clerkFrontendHost(publishableKey: string | undefined): string | undefined {
  if (!publishableKey) return undefined;
  const m = /^pk_(?:test|live)_(.+)$/.exec(publishableKey);
  if (!m) return undefined;
  try {
    const decoded = atob(m[1]);
    const host = decoded.endsWith("$") ? decoded.slice(0, -1) : decoded;
    return /^[a-z0-9.-]+$/i.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** CSP additions Clerk requires (docs: guides/secure/best-practices/csp-headers). */
export function clerkCspSources(publishableKey: string | undefined) {
  const host = clerkFrontendHost(publishableKey);
  const fapi = host ? [`https://${host}`] : [];
  return {
    extraScriptSrc: [...fapi, "https://challenges.cloudflare.com", "https://*.protect.clerk.com"],
    extraConnectSrc: [...fapi, "https://*.protect.clerk.com:*"],
    extraImgSrc: ["https://img.clerk.com"],
    extraFrameSrc: ["https://challenges.cloudflare.com", "https://*.protect.clerk.com"],
    workerSrc: ["'self'", "blob:"],
  };
}
