# Coding Deviation Log: p1-supply-chain-provenance
Created: 2026-07-16

## Deviations from Plan

### D1: manifest keyed by name, composite keys for multi-workspace / duplicate packages
- **Plan**: `packages` keyed by package name.
- **Actual**: `otpauth` ships in all three workspaces and `zod` in both root and cli; a single name-keyed map cannot hold per-workspace entries. Used composite keys (`otpauth@cli`, `otpauth@extension`, `zod@cli`) carrying the real name in a `package` field; the test resolves `entry.package ?? key`. No behavior change to the reconciliation contract.
- **Impact**: manifest shape only; the three-set logic and self-tests are unaffected.

### D2: C2 anti-mask + C3 no-auto-merge folded into ONE guard file
- **Plan**: C2 anti-mask grep and C3 no-auto-merge guard as (possibly) separate `run_step`s.
- **Actual**: both are pure exported functions in a single `scripts/checks/check-workflow-supply-chain.mjs` (one `run_step`), each with its own RT7 self-test in `scripts/__tests__/check-workflow-supply-chain.test.mjs`. Both are workflow-file lints, so one guard file is cohesive (KISS) and both invariants still fire independently.
- **Impact**: one `pre-pr.sh` `run_step` instead of two; both forbidden-pattern classes covered.

### D3: root CODE roots widened to the passkey/webauthn API routes
- **Plan**: root roots listed "WebAuthn/passkey/SAML route trees" generically.
- **Actual**: concretely `src/app/api/auth/passkey` + `src/app/api/webauthn` (SAML has no npm dep, so no SAML route is a crypto/auth-import source). Root also includes `src/lib/email/**` (SEC-5) and `src/components/passwords/shared/**` (TOTP field).
- **Impact**: none — matches the GT-6 intent; the concrete paths are what actually import the sensitive packages.

### D4: `walkSourceFiles` single-file guard + descendant const resolution (implementation fixes found during verification)
- Two bugs surfaced while running against the real tree and were fixed before commit: (a) `walkSourceFiles` must special-case a root that points at a single `.ts` file (`src/lib/prisma.ts`) before `readdirSync`; (b) the dynamic-import `const moduleName` binding is function-scoped, so resolution must walk `getDescendantsOfKind(VariableDeclaration)`, not just top-level `getVariableDeclarations()` — otherwise `hash-wasm` (the load-bearing dynamic member) is missed. The (A) integration prove-it-fails demo confirmed the fix: dropping `hash-wasm` from the manifest turns (A) RED via the resolved dynamic import.

### Prove-it-fails demonstrations (Phase 2, scratch only, not committed)
- (B) presence: added a synthetic `nonexistent-crypto-pkg` to a scratch copy of the manifest → (B) RED; restored clean.
- (A) drift: dropped `hash-wasm` from a scratch copy (still imported) → (A) RED (proving the dynamic-import member flows through the drift gate); restored clean, 26/26 green.
- (C)/(D)/heuristic/dynamic-resolver: proven RED at the pure-function unit level (RT7 self-tests in the test file).
