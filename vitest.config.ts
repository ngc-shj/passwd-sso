import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "e2e/helpers/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/app/api/**/*.ts",
        "src/lib/org-auth.ts",
        "src/lib/crypto-server.ts",
        "src/lib/password-generator.ts",
      ],
      exclude: ["src/app/api/auth/**"],
    },
    isolate: true,
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
