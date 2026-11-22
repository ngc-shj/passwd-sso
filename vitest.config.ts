import { defineConfig } from "vitest/config";
import path from "path";

// CI runs the coverage suite in shards (`--shard=i/n --reporter=blob`) and
// merges them with `vitest --merge-reports --coverage`. A shard sees only its
// slice of the tests, so the floors below are checked once, on the merge;
// each shard job sets VITEST_COVERAGE_SHARD=1 to skip them.
const isCoverageShard = process.env.VITEST_COVERAGE_SHARD === "1";

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
        "src/**/*.{ts,tsx}",
        "proxy.ts",
        "instrumentation-client.ts",
        "sentry.client.config.ts",
        "sentry.server.config.ts",
      ],
      // Every production file is measured; scripts/checks/check-coverage-scope.mjs
      // fails when one is not (scripts/checks/lib/coverage-members.mjs holds the
      // member set this list must cover).
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/__tests__/**", "src/**/*.d.ts"],
      // vitest's defaults plus json-summary, which check-coverage-scope reads.
      reporter: ["text", "html", "clover", "json", "json-summary"],
      thresholds: isCoverageShard ? undefined : {
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
        // Every measured file, on top of the aggregate: a nearly untested file
        // used to average away under the floors above (one component sat at
        // 2/84). Every file measured at >=65 when this was enrolled; a file with
        // no statements (type-only modules) scores 100.
        perFile: { statements: 60, lines: 60 },
        // Security directories, at the measured aggregate minus 2: the
        // per-file floor alone would let a 98% directory fall to 61% unnoticed.
        // check-coverage-scope.test.mjs fails if a glob stops matching files.
        "src/lib/crypto/**": { statements: 96, lines: 97, branches: 90 },
        "src/lib/proxy/**": { statements: 96, lines: 96, branches: 92 },
        "src/lib/security/**": { statements: 95, lines: 95, branches: 89 },
        "src/lib/audit/**": { statements: 93, lines: 94, branches: 89 },
        "src/lib/tenant/**": { statements: 94, lines: 95, branches: 90 },
        "src/lib/auth/**": { statements: 92, lines: 94, branches: 88 },
        "src/lib/vault/**": { statements: 78, lines: 79, branches: 76 },
        // Store-backed security modules whose tests landed with the scope
        // change; each refusal arm has its own test. Measured minus 2.
        "src/lib/vault/rotate-key-server.ts": { statements: 98, lines: 98, branches: 98 },
        "src/lib/auth/access/delegation.ts": { statements: 98, lines: 98, branches: 95 },
        "src/lib/team/team-attachment-lock.ts": { statements: 98, lines: 98, branches: 98 },
        "src/lib/extension-connect-request.ts": { statements: 98, lines: 98, branches: 89 },
        "src/lib/auth/session/auth-or-token.ts": { lines: 80, branches: 70 },
        "src/lib/crypto/crypto-server.ts": { lines: 80, branches: 70 },
        "src/lib/crypto/crypto-team.ts": { lines: 80, branches: 70 },
        // Enrolled once their tests landed in this branch. Both hold
        // fail-closed security decisions, which is exactly the kind of code a
        // global floor is too coarse to protect.
        "src/app/api/maintenance/audit-chain-verify/route.ts": { lines: 80, branches: 70 },
        // The single adjudicator for chain integrity — a pure function with no
        // I/O to excuse a gap, and the one place a deleted test would go
        // unnoticed under the global floor alone.
        "src/lib/audit/audit-chain-verify.ts": { lines: 90, branches: 85 },
        "src/app/api/user/mcp-tokens/[id]/route.ts": { lines: 80, branches: 70 },
        // The one session-cookie reader and the proxy's session decision on
        // it: a refusal arm losing its test would let the proxy and auth()
        // read different sessions again. Measured: 100/100 and 100/96.9.
        "src/lib/auth/session/session-cookie.ts": { lines: 95, branches: 95 },
        "src/lib/proxy/auth-gate.ts": { lines: 95, branches: 92 },
        // The page-route session decision and the cookie deletion that must
        // mirror the set-time attributes (Secure, path, Partitioned) or the
        // browser keeps the cookie. Measured: 96 lines / 82.9 branches.
        "src/lib/proxy/page-route.ts": { lines: 93, branches: 79 },
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
