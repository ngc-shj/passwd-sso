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

## Phase 3 code-review fixes

### D5: (B) presence check reads only `dependencies` (runtime-dep assumption)
- The (B) real-tree check reads each workspace's package.json `dependencies` only, not `devDependencies` (Round-1 code-review T4). Confirmed every manifest-listed package is a runtime `dependencies` entry in its workspace. A crypto/auth primitive would never be a devDependency in production, so the assumption is sound; recorded so a reviewer can contest it.

### D6: detectedBy-accuracy + (B) extracted to pure functions with unit negatives
- Round-1 code review (M1 = Func F1 + Test T2; M3 = Test T1) found the (B) presence check inlined and the INV-C4c detectedBy-accuracy branch unimplemented. Added `computeMissingDeps` (B) and `computeDetectedByViolations` (detectedBy accuracy) as pure exported functions, each wired into the real-tree reconciliation AND given RED/GREEN unit self-tests. The detectedBy-accuracy check catches the case (C) misses: a non-crypto-named member (e.g. next-auth) whose import is removed but left in package.json+manifest — a stale static-import claim now goes RED.

### D7: workflow guard hardened against evasion shapes
- Round-1 code review (M2 = Sec SEC-1; m1 = Func F3 + Sec SEC-2; m2 = Sec SEC-3; m3 = Func F2) widened the auto-merge regex to the documented Dependabot shapes (peter-evans action, enablePullRequestAutoMerge GraphQL, gh api pulls/N/merge REST), dropped the over-broad bare --merge, extended the anti-mask detector to || exit 0 / continue-on-error, extended verifier coverage to the npm view attestations provenance assertion, and documented CODEOWNERS as the PRIMARY control (the regex is defense-in-depth; a cross-file reusable-workflow split is out of a per-file grep's reach). New self-tests cover each shape (fire + stay-quiet).

### D8: workflow guard regex hardened again (Round-2 code review)
- Round-1's guard-widening (D7) itself introduced defects the Round-2 review caught, all self-verified:
  - Critical (ReDoS): the gh api pulls/N/merge alternative had overlapping greedy groups with an unsatisfiable tail — a hostile workflow line could hang the guard. Removed; pulls/[^\s]*/merge (single bounded class) already covers every REST pulls/N/merge case, zero coverage loss.
  - Major (missed shapes): added merge-dependabot (fastify action) + pulls.merge (github-script REST client).
  - Major (|| : dead match): the : no-op never matched under a shared trailing \b; gave it a lookahead boundary + a RED self-test.
  - Major (verifierRe missed real release.yml): the provenance assertion uses optional chaining j?.dist?.attestations, which dist.attestations did not match, and npm view + attestations are on separate lines. Switched to dist optional-chaining match + a WORKFLOW-level runsVerifier flag. Verified: injecting continue-on-error on the real release.yml provenance step now goes RED (was green before).
- All tightenings (no boundary widened). Guard self-tests grew to 16; real workflows stay clean.

## Post-review external findings

### D9: [High] classification-completeness gate — every runtime dep must be packages OR excluded
- An external review found the three-set guard's blind spot was still exploitable: a new auth lib (e.g. better-auth) added OUTSIDE the CODE_ROOTS and whose name misses CRYPTO_NAME_RE passes (A), (C), CODEOWNERS, and lands unclassified. Self-verified.
- Fix: added (E) computeUnclassifiedDeps — EVERY runtime dependency of each workspace must be classified as a crypto/auth packages member OR an excluded support dep; a dep in neither is a finding. This forces a supply-chain review decision on every new dependency regardless of name or import location, closing the R-3 residual at its root. Enumerated all 17 previously-unclassified root deps into excluded with reasons. RED/GREEN self-tests incl. the better-auth scenario.
- Also surfaced a latent bug: react/react-dom were excluded for BOTH root and extension under the same JSON key, so the extension entry silently overwrote root's (JSON dup-key). The (E) check caught it; fixed with composite keys (react@extension). (E) is itself the safety net against future dup-key overwrites.

### D10: [Medium] anti-mask guard missed multi-line + expression masks
- External review found findMaskedVerifierViolations only detected a mask on the SAME line as the verifier, missing `npm audit signatures \` + newline + `|| true`, and missed continue-on-error: ${{ true }} (expression form). Both self-verified as false-negatives.
- Fix: join shell line-continuations into one logical line (tracking the original line number) before scanning; broaden the continue-on-error match to the expression form. Self-tests for both; real workflows stay clean.

## Second external-review round

### D11 [High] classification check moved to a standalone always-run guard
- (E) in the vitest test rides app-ci (gated app||ci); a cli/ext-only package.json PR skips it. Extracted (E) into standalone scripts/checks/check-crypto-auth-deps-classified.mjs (node:fs+JSON only) wired into pre-pr.sh which static-checks runs unconditionally. RT7 self-test + prisma-displacement-verified.

### D12 [Medium] anti-mask guard now folds YAML folded/block scalars
- A run: > folded scalar evaded the guard (earlier fix only joined backslash-continuations). The logical-line builder now absorbs a run block deeper-indented body before scanning. Folded-scalar self-test added.
