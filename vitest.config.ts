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
      "scripts/__tests__/**/*.test.ts",
    ],
    exclude: ["src/**/*.integration.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/app/api/**/*.ts",
        "src/lib/crypto/crypto-utils.ts",
        "src/lib/crypto/crypto-client.ts",
        "src/lib/crypto/crypto-aad.ts",
        "src/lib/crypto/crypto-emergency.ts",
        "src/lib/crypto/crypto-recovery.ts",
        "src/lib/auth/access/team-auth.ts",
        "src/lib/crypto/crypto-server.ts",
        "src/lib/crypto/crypto-team.ts",
        "src/lib/team/team-vault-core.tsx",
        "src/lib/generator/password-generator.ts",
        "src/lib/email/**/*.ts",
        "src/lib/auth/session/auth-adapter.ts",
        "src/lib/auth/tokens/scim-token.ts",
        "src/lib/scim/*.ts",
        "src/lib/auth/webauthn/webauthn-authorize.ts",
        "src/lib/auth/webauthn/webauthn-server.ts",
        "src/lib/auth/session/check-auth.ts",
        "src/lib/http/parse-body.ts",
        "src/lib/http/with-request-log.ts",
        "src/lib/auth/session/auth-or-token.ts",
        "src/lib/auth/policy/access-restriction.ts",
        "src/lib/auth/policy/account-lockout.ts",
        "src/lib/webhook-dispatcher.ts",
        "src/lib/audit/audit.ts",
        "src/lib/audit/audit-outbox.ts",
        "src/lib/audit/audit-query.ts",
        "src/proxy.ts",
        "src/components/**/*.{ts,tsx}",
        "src/app/global-error.tsx",
        "src/lib/key-provider/**/*.ts",
        "src/lib/prisma/prisma-error.ts",
        "src/lib/security/sentry-sanitize.ts",
        "src/lib/mcp/**/*.ts",
        "src/lib/security/password-policy-validation.ts",
        "src/lib/auth/tokens/extension-token.ts",
      ],
      exclude: [
        "src/app/api/auth/\\[...nextauth\\]/**",
        "src/components/**/*.test.{ts,tsx}",
      ],
      thresholds: {
        // T8: floors exist so negative/denied paths (authz rejection,
        // expired-grant, revoked-token) can't silently erode. They are a
        // ratchet, not a target — set a couple of points under the measured
        // value and the next unrelated PR to nudge coverage down reds the
        // build instead of the PR that created the gap. Measured at the time
        // of writing: 84% lines / 74% branches / 83% statements.
        lines: 75,
        branches: 65,
        // Without this, statement-level erosion is ungated: v8 counts
        // statements and lines separately and they do diverge.
        statements: 75,
        "src/lib/auth/session/auth-or-token.ts": { lines: 80, branches: 70 },
        "src/lib/crypto/crypto-server.ts": { lines: 80, branches: 70 },
        "src/lib/crypto/crypto-team.ts": { lines: 80, branches: 70 },
        // Enrolled once their tests landed in this branch. Both hold
        // fail-closed security decisions, which is exactly the kind of code a
        // global floor is too coarse to protect.
        "src/app/api/maintenance/audit-chain-verify/route.ts": { lines: 80, branches: 70 },
        "src/app/api/user/mcp-tokens/[id]/route.ts": { lines: 80, branches: 70 },
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
