import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    pool: "forks" as const,
    poolOptions: {
      forks: { singleFork: true },
    },
    isolate: true,
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
