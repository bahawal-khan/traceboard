import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
    testTimeout: 30_000, // the ESLint-based rule tests load the full config on first use
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
          exclude: ["tests/db/**"],
        },
      },
      {
        // Database tests share one Neon branch: run files one at a time, and retry
        // only transient connection failures (never SQL errors).
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          fileParallelism: false,
          setupFiles: ["tests/setup-db-retry.ts"],
        },
      },
    ],
  },
});
