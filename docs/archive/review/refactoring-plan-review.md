# Plan Review: refactoring-plan

Date: 2026-03-14T00:00:00+09:00
Review round: 1

## Changes from Previous Round

Initial review.

## Deduplicated Findings

### DF-1 [Critical] Item #18: `buildEntryAAD` unification risks AAD misuse (Security)

**Severity**: Critical
**Perspectives**: Security, Functionality
**Problem**: `buildPersonalEntryAAD` and `buildTeamEntryAAD` have fundamentally different AAD field counts (2 vs 4). Team AAD uses `vaultType: "blob" | "overview"` to prevent cross-field replay. If unified into `buildEntryAAD(scope, params)` with `vaultType` as optional, team callers could silently omit it, producing incorrect AAD. Additionally, Functionality expert notes that `buildAADBytes()` already exists as a shared internal function — the public wrappers are already thin.
**Impact**: Cross-field replay attack defense weakened; AAD mismatch causes GCM auth failures or silent security degradation.
**Recommended action**:
1. Use TypeScript overload signatures with literal discriminants so `vaultType` omission is a compile error for team scope
2. Re-evaluate whether Item #18 is needed at all — `buildAADBytes` already centralizes the logic. Consider closing as "already refactored" or limiting scope to visibility improvements

### DF-2 [Major] Item #8: VaultContext split lacks dependency design, race condition risk, and test baseline (Functionality + Security + Testing)

**Severity**: Major
**Perspectives**: All three experts
**Problem**:
- (Functionality) `TeamVaultProvider` depends on `getEcdhPrivateKeyBytes` from VaultContext. Plan doesn't specify which sub-context provides this after split, or the provider nesting order
- (Security) `encryptionKey` clearing and auto-lock timer must be atomic. Split into separate contexts creates a window where `encryptionKey` references persist after lock. PRF auto-unlock vs auto-lock interaction is also unspecified
- (Testing) No unit tests exist for VaultContext (no `vault-context.test.ts`). 42 consuming files. Without a baseline, regressions can only be caught by slow E2E tests
**Impact**: Race condition allowing decryption after vault lock; TeamVaultProvider breakage; no regression safety net.
**Recommended action**:
1. Add a context dependency graph to the plan specifying provider nesting order and which context owns `encryptionKey` and ECDH keys
2. Design `encryptionKey` clearing as atomic in `VaultUnlockContext` — `AutoLockContext` only signals intent, never touches keys directly
3. Before split: write unit tests (using `renderHook`) for lock state transitions, inactivity timer, and emergency access auto-confirm as regression baseline
4. Add VaultContext files to `coverage.include` in vitest.config.ts
5. Require Playwright E2E (`vault-lock-relock.spec.ts`, `vault-setup.spec.ts`) to pass as PR gate

### DF-3 [Major] Item #11: `saveCryptedEntry` unification creates type-safety and AAD risks (Functionality + Security)

**Severity**: Major
**Perspectives**: Functionality, Security
**Problem**:
- (Functionality) Personal and team entry saves differ fundamentally: personal AAD uses `(userId, entryId)`, team uses `(teamId, entryId, vaultType, itemKeyVersion)`. Team also requires `encryptedItemKey` and `teamKeyVersion`. These are not "the same structure"
- (Security) If unified with optional fields, `userId` or `teamId` omission could silently produce `aadVersion: 0` (AAD-less encryption), enabling ciphertext transplant attacks
**Impact**: Type safety degradation; potential AAD-less encryption creating security vulnerability.
**Recommended action**:
1. Use discriminated union: `scope: "personal"` requires `userId: string` (non-optional), `scope: "team"` requires `teamId: string` (non-optional)
2. Alternatively, extract only the shared mechanics (fetch, endpoint selection, body construction) as a private helper, keeping `savePersonalEntry` / `saveTeamEntry` as public APIs
3. Prohibit `aadVersion: 0` for new entries in the unified function

### DF-4 [Major] Item #7: `FullEntryData` field naming mismatch across interfaces (Functionality)

**Severity**: Major
**Perspectives**: Functionality
**Problem**: `VaultEntryFull` uses `passphrase` / `comment` for SSH fields, while `InlineDetailData` and `ExportEntry` use `sshPassphrase` / `sshComment`. `generatorSettings`, `travelSafe`, `isFavorite` exist only in some interfaces. `Pick<>` / `Omit<>` derivation cannot work without field renaming first.
**Impact**: Mechanical type unification impossible without renaming fields in `password-card.tsx` — this is a larger change than the plan implies.
**Recommended action**: Create a detailed field mapping before implementation. Rename `VaultEntryFull.passphrase` → `sshPassphrase` etc. as a prerequisite. Coordinate with Item #14 (prop drilling) to do both in one PR.

### DF-5 [Major] Item #1: Crypto utils extraction file list incomplete + coverage gap (Testing + Functionality)

**Severity**: Major
**Perspectives**: Testing, Functionality
**Problem**:
- (Testing) `webauthn-client.ts` also contains a copy of `toArrayBuffer()` but is not listed in the plan
- (Functionality) `vault-context.tsx` has `hexDecode` / `hexEncode` duplicates that could also be consolidated. `crypto-utils.ts` must be browser-only (Web Crypto) — importing it server-side would cause bundling errors
- (Testing) New `crypto-utils.ts` not in `vitest.config.ts` `coverage.include`
**Impact**: Incomplete deduplication; missing coverage for shared crypto module.
**Recommended action**:
1. Add `webauthn-client.ts` to the extraction target list
2. Evaluate `hexDecode` / `hexEncode` in `vault-context.tsx` for inclusion
3. Mark `crypto-utils.ts` as client-only (`"use client"` or import guard)
4. Add `crypto-utils.ts` to `coverage.include` and write dedicated unit tests

### DF-6 [Major] Item #5: Auth unification Phase D needs E2E gate + cache isolation (Testing)

**Severity**: Major
**Perspectives**: Testing
**Problem**: Phase D (removing deprecated `authOrToken()`) only specifies `vitest run` + `next build`. Auth regressions with real browser sessions (Auth.js database sessions, passkey sign-in, session cookies) are only caught by Playwright E2E. Also, `enforceAccessRestriction` has a module-level `policyCache` that needs clearing between tests.
**Impact**: Auth regressions in production that unit tests cannot detect.
**Recommended action**:
1. Add Playwright E2E as explicit Phase D gate
2. Require `_clearPolicyCache()` in `beforeEach` for tests using `checkAccessRestriction: true`
3. Write dedicated test verifying `enforceAccessRestriction` is called/not called based on flag

### DF-7 [Major] Item #4: withRequestLog lacks negative assertions for sensitive data (Testing)

**Severity**: Major
**Perspectives**: Testing
**Problem**: Existing tests verify what IS logged but not that sensitive headers (Authorization, Cookie) are NEVER logged. Data masking audit is a human review step, not CI-enforced.
**Impact**: Future modifications could silently introduce PII logging across all 126 routes.
**Recommended action**: Add negative test cases asserting that `Authorization: Bearer <token>` and `Cookie: authjs.session-token=<value>` never appear in any log call arguments.

### DF-8 [Major] Item #13: "Snapshot test" requirement is undefined and unenforceable (Testing)

**Severity**: Major
**Perspectives**: Testing
**Problem**: Plan says "must have comprehensive snapshot tests" but no snapshot baseline exists for form hooks (0 of 70+ files have `toMatchSnapshot`). The term "snapshot test" is ambiguous — could mean vitest snapshots, value comparisons, or something else.
**Impact**: Highest-risk item (#13, 70+ files) proceeds without a real regression safety net.
**Recommended action**: Define explicit snapshot format: use `toMatchInlineSnapshot()` for each form variant's initial state, validation outputs for fixed inputs, and `onSave` call signature. Create baseline files on `main` before any migration PRs.

### DF-9 [Major] Item #12: Load test scripts not in audit scope (Testing)

**Severity**: Major
**Perspectives**: Testing
**Problem**: `load-test/setup/seed-load-test-users.mjs` hardcodes `res.status === 200` at lines 449, 529. Plan's compatibility check only targets frontend and REST API v1 clients.
**Impact**: Load test CI produces false failures after status code changes.
**Recommended action**: Add `load-test/` directory to the audit scope for hardcoded status checks.

### DF-10 [Minor] Item #3: Missing `constants/index.ts` re-export step (Functionality)

**Severity**: Minor
**Perspectives**: Functionality
**Problem**: Plan doesn't mention adding re-export to `src/lib/constants/index.ts` after creating `timing.ts`.
**Recommended action**: Add explicit step to update `index.ts` with re-export.

### DF-11 [Minor] Item #15: SCIM service extraction auth boundary risk (Security)

**Severity**: Minor
**Perspectives**: Security
**Problem**: Extracting SCIM route business logic to services could allow internal code to call SCIM service functions without SCIM bearer token authentication.
**Recommended action**: Require `authenticatedTenantId: string` as mandatory parameter in SCIM service function signatures.

### DF-12 [Minor] Items #4, #5, #16: No coverage thresholds in vitest.config.ts (Testing)

**Severity**: Minor
**Perspectives**: Testing
**Problem**: No `coverage.thresholds` defined. PRs could reduce coverage on security-sensitive modules to 0%.
**Recommended action**: Add minimum coverage thresholds (e.g., `lines: 80`) for `auth-or-token.ts` and new files from Items #5, #16.

## Round 1 Summary

| Severity | Count |
|----------|-------|
| Critical | 1 (DF-1) |
| Major | 8 (DF-2 through DF-9) |
| Minor | 3 (DF-10 through DF-12) |

---

## Round 2

Date: 2026-03-14
Review round: 2

### Changes from Previous Round

All 12 Round 1 findings (DF-1 through DF-12) addressed in plan. See Round 1 findings above for details.

### Round 2 Findings (Deduplicated)

#### R2-1 [Major] Item #18: `buildTeamKeyWrapAAD` also duplicates binary encoding (Functionality)

**Status**: New
**Problem**: `buildTeamKeyWrapAAD` in `crypto-team.ts` (lines 202-245) contains a full hand-rolled duplicate of the binary encoding that `buildAADBytes` implements. Plan says "keep OK scope separate" but doesn't address the internal encoding duplication.
**Resolution**: Plan updated — `buildTeamKeyWrapAAD` should call `buildAADBytes(AAD_SCOPE_TEAM_KEY, 4, [...fields])` internally.

#### R2-2 [Major] Item #4: Negative header tests need anti-vacuous design (Functionality + Testing)

**Status**: New
**Problem**: Current `withRequestLog` doesn't log headers at all, so negative assertions would always pass vacuously regardless of future changes.
**Resolution**: Plan updated — tests must assert `req.headers` is never serialized (not just tokens absent) and include a regression test with an intentionally-leaking handler.

#### R2-3 [Critical→Major] Item #11: `userId` optional migration path needed (Security)

**Status**: Elaboration of DF-3
**Problem**: `personal-entry-save.ts` accepts `userId?: string` and produces `aadVersion: 0` when absent. Plan's "prohibit aadVersion: 0" conflicts with this existing path. Existing tests expect `aadVersion: 0`.
**Resolution**: Plan updated — explicit migration: make `userId` non-optional, update call sites, update tests, server read path still accepts `aadVersion: 0` for backward compat.

#### R2-4 [Major] Item #8: EA auto-confirm race with lock() (Security)

**Status**: Elaboration of DF-2
**Problem**: `lock()` synchronously zero-fills `secretKeyRef.current`, but EA auto-confirm interval may have captured a reference. Callback receives zeroed bytes.
**Resolution**: Plan updated — design constraint added: EA interval must be cleared before key zero-fill, or callback must clone+validate key bytes first.

#### R2-5 [Major] Item #15: `buildResourceFromMapping` missing explicit `tenantId` filter (Security)

**Status**: New
**Problem**: `teamMember.findMany` query in `buildResourceFromMapping` relies on RLS only for tenant isolation. Defense-in-depth requires explicit `tenantId` filter.
**Resolution**: Plan updated — add explicit `tenantId` filter during service extraction.

#### R2-6 [Minor] Item #8: E2E spec paths should be `e2e/tests/` prefixed (Functionality)

**Status**: New
**Resolution**: Plan updated — corrected to `e2e/tests/vault-lock-relock.spec.ts` etc.

#### R2-7 [Minor] Item #18: `buildTeamEntryAAD` default argument for vaultType (Security)

**Status**: Noted — existing code issue, addressed by overload requirement in plan.

#### R2-8 [Minor] Item #8: `prfOutputHex` string zeroing limitation (Security)

**Status**: New
**Resolution**: Plan updated — documented as accepted residual risk (JS/V8 limitation).

### Round 2 Summary

| Severity | Count | Status |
|----------|-------|--------|
| Major | 5 (R2-1 through R2-5) | All resolved in plan |
| Minor | 3 (R2-6 through R2-8) | All resolved in plan |

All Round 1 findings: Resolved.
All Round 2 findings: Resolved in plan updates.

---

## Round 3

Date: 2026-03-14
Review round: 3

### Changes from Previous Round

All Round 2 findings (R2-1 through R2-8) addressed in plan.

### Round 3 Findings

Most Round 3 findings were about current code not matching plan requirements (expected — plan describes future work, not current state). Only Minor plan-design issues found:

#### R3-1 [Minor] Item #18: `AAD_VERSION` constant duplication in crypto-team.ts

**Status**: New → Resolved
**Resolution**: Plan updated to import `AAD_VERSION` from `crypto-aad.ts` + call-site audit for `buildTeamEntryAAD` overload.

#### R3-2 [Minor] Item #15: `buildResourceFromMapping` function signature needs `tenantId` parameter

**Status**: New → Resolved
**Resolution**: Plan updated to explicitly update function signature.

#### R3-3 [Minor] Item #4: Regression test implementation mechanism unspecified

**Status**: New → Resolved
**Resolution**: Plan updated with concrete spy-based assertion pattern.

#### R3-4 [Minor] Item #11: Negative test for `aadVersion: 0` write rejection unspecified

**Status**: New → Resolved
**Resolution**: Plan updated with explicit negative test case requirement.

#### R3-5 [Minor] Item #18: Call-site audit for `buildTeamEntryAAD` overload missing

**Status**: New → Resolved
**Resolution**: Plan updated to audit existing callers using `vaultType = "blob"` default.

### Round 3 Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | — |
| Major | 0 | — |
| Minor | 5 (R3-1 through R3-5) | All resolved in plan |

**All findings across all rounds are resolved. Plan review complete.**
