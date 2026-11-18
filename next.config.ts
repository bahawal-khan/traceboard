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
    // CSP (per-request nonce) and the request id are set in proxy.ts.
    async headers() {
      return [
        { source: "/:path*", headers: [...STATIC_SECURITY_HEADERS] },
        { source: "/api/:path*", headers: [API_CACHE_HEADER] },
      ];
    },
  };
}
