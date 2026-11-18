import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/** Tenant data access must go through lib/repo + withTenant(). */
const ctxInternals = {
  group: ["@/lib/repo/tenant", "**/lib/repo/tenant", "./tenant", "../repo/tenant"],
  importNames: ["issueCtx", "runScoped"],
  message: "Only lib/repo/ctx.ts may mint tenant contexts. Use withTenant(ctx, ...) instead.",
};

export const dbImportBan = {
  paths: [
    { name: "@neondatabase/serverless", message: "Use lib/repo/* (withTenant) instead of the db driver." },
    { name: "drizzle-orm/neon-http", message: "Use lib/repo/* (withTenant) instead of the db driver." },
    { name: "drizzle-orm/neon-serverless", message: "Use lib/repo/* (withTenant) instead of the db driver." },
    { name: "pg", message: "Use lib/repo/* (withTenant) instead of the db driver." },
  ],
  patterns: [
    ctxInternals,
    { group: ["@/lib/db", "@/lib/db/*", "**/lib/db", "**/lib/db/*"], message: "Import the db client only from lib/repo/* (withTenant)." },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-imports": ["error", dbImportBan],
      "no-restricted-syntax": [
        "error",
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "dangerouslySetInnerHTML is banned." },
      ],
    },
  },
  // The only places allowed to touch the db client / driver.
  {
    files: ["lib/repo/**", "lib/db/**", "db/**", "scripts/**", "drizzle.config.ts", "tests/**"],
    rules: { "no-restricted-imports": "off" },
  },
  // Inside lib/repo everything but the two context modules may use withTenant only.
  {
    files: ["lib/repo/**"],
    ignores: ["lib/repo/ctx.ts", "lib/repo/tenant.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [ctxInternals] }] },
  },
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts"]),
]);

export default eslintConfig;
