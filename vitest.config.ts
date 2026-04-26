import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 15000,
    hookTimeout: 15000,
    teardownTimeout: 5000,
    pool: "forks",
    reporters: process.env.VITEST_VERBOSE
      ? ["default"]
      : ["./scripts/vitest-compact-reporter.ts"],
    setupFiles: process.env.VITEST_LIVE
      ? ["./scripts/vitest-live-setup.ts"]
      : [],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
