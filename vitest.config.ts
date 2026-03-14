import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/**/*.test.{ts,tsx}",
      "e2e/helpers/*.test.ts",
      "scripts/__tests__/**/*.test.mjs",
    ],
    setupFiles: ["src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/app/api/**/*.ts",
        "src/lib/crypto-utils.ts",
        "src/lib/team-auth.ts",
        "src/lib/crypto-server.ts",
        "src/lib/crypto-team.ts",
        "src/lib/team-vault-core.tsx",
        "src/lib/password-generator.ts",
        "src/lib/email/**/*.ts",
        "src/lib/auth-adapter.ts",
        "src/lib/scim-token.ts",
        "src/lib/scim/*.ts",
        "src/lib/webauthn-authorize.ts",
        "src/lib/webauthn-server.ts",
        "src/lib/check-auth.ts",
        "src/lib/parse-body.ts",
        "src/lib/with-request-log.ts",
        "src/lib/auth-or-token.ts",
        "src/lib/access-restriction.ts",
      ],
      exclude: ["src/app/api/auth/\\[...nextauth\\]/**"],
      thresholds: {
        "src/lib/auth-or-token.ts": { lines: 80 },
        "src/lib/crypto-server.ts": { lines: 80 },
        "src/lib/crypto-team.ts": { lines: 80 },
      },
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
