import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { parseEnv } from "./lib/env";

export default function config(phase: string): NextConfig {
  // Fail the production build when a required secret is missing.
  // CI/preview builds that intentionally lack secrets set SKIP_ENV_VALIDATION=1.
  if (phase === PHASE_PRODUCTION_BUILD && process.env.SKIP_ENV_VALIDATION !== "1") {
    parseEnv(process.env);
  }
  return {
    poweredByHeader: false,
    reactStrictMode: true,
  };
}
