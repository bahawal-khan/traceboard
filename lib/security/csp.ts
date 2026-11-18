/**
 * Content Security Policy builder (pure, testable). The per-request nonce is
 * generated in proxy.ts. P1.2 extends the allow-lists for Clerk.
 */

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** Extra origins, e.g. Clerk in P1.2. Keep empty until a feature needs them. */
  extraScriptSrc?: readonly string[];
  extraConnectSrc?: readonly string[];
  extraImgSrc?: readonly string[];
  extraFrameSrc?: readonly string[];
}

export function buildCsp(o: CspOptions): string {
  const script = [
    "'self'",
    `'nonce-${o.nonce}'`,
    "'strict-dynamic'",
    ...(o.isDev ? ["'unsafe-eval'"] : []), // React dev tooling only; never in production
    ...(o.extraScriptSrc ?? []),
  ];
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": script,
    "style-src": ["'self'", `'nonce-${o.nonce}'`],
    // React/Recharts set style="" attributes; attributes cannot run script.
    "style-src-attr": ["'unsafe-inline'"],
    "img-src": ["'self'", "blob:", "data:", ...(o.extraImgSrc ?? [])],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...(o.extraConnectSrc ?? [])],
    "frame-src": o.extraFrameSrc?.length ? [...o.extraFrameSrc] : ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!o.isDev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

/** Headers that do not vary per request (applied from next.config.ts). */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

/** Tenant data must never sit in a shared/CDN cache (SECURITY.md). */
export const API_CACHE_HEADER = { key: "Cache-Control", value: "private, no-store" } as const;
