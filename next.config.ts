import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { parseEnv } from "./lib/env";
import { API_CACHE_HEADER, STATIC_SECURITY_HEADERS } from "./lib/security/csp";

export default function config(phase: string): NextConfig {
  // Fail the production build when a required secret is missing.
  // CI/preview builds that intentionally lack secrets set SKIP_ENV_VALIDATION=1.
  if (phase === PHASE_PRODUCTION_BUILD && process.env.SKIP_ENV_VALIDATION !== "1") {
    parseEnv(process.env);
  }
  return {
    poweredByHeader: false,
    reactStrictMode: true,
    // Privacy-first: no telemetry from Clerk (it is also blocked by our connect-src).
    env: { NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED: "1" },
    // CSP (per-request nonce) and the request id are set in proxy.ts.
    async headers() {
      return [
        { source: "/:path*", headers: [...STATIC_SECURITY_HEADERS] },
        { source: "/api/:path*", headers: [API_CACHE_HEADER] },
        // Signed-in pages show one user's data: never in a shared or CDN cache (the pages are also force-dynamic).
        { source: "/dashboard/:path*", headers: [API_CACHE_HEADER] },
      ];
    },
  };
}
