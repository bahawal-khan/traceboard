import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "node",
    testTimeout: 30_000, // the ESLint-based rule tests load the full config on first use
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "lcov"] },
  },
});
