# Plan Review: extension-dpop-sender-constrained

Date: 2026-05-24
Review round: 2

## Changes from Previous Round

Three user scope decisions applied (S3 strict-from-day-one, F5/T6 Option A metadata-only, T7 Playwright extension loader). Plan extensively rewritten to remove the legacy bearer-only branch and add C10/C11/C3b/C9a. Round 2 launched 3 expert sub-agents to verify resolution of Round 1 findings AND surface new issues introduced by Round 2 changes.

## Functionality Findings (Round 2)

### F1-r2 [Critical] — `validateIosTokenDpop` "replaces or re-exports" plan needs explicit type-location strategy
- **Problem**: C5 mandates the new helper does not import from `extension-token.ts` or `mobile-token.ts`, but its return type `ValidateTokenDpopResult.data: ValidatedExtensionToken` references a type defined in `extension-token.ts:18`. Cycle reintroduced if implementer naively imports the type as a value.
- **Fix in Round 3**: New leaf module `src/lib/auth/tokens/extension-token-types.ts` holds `ValidatedExtensionToken`. Both `extension-token.ts` and `dpop/validate-token-dpop.ts` import the type from this leaf module. C5 specifies `import type` for full cycle elimination.

### F2-r2 [Critical] — Migration safety + schema invariant gap on extension_tokens.cnf_jkt
- **Problem**: `DELETE FROM extension_tokens WHERE client_kind = 'BROWSER_EXTENSION' AND cnf_jkt IS NULL` doesn't enforce the future invariant; new code that bypasses `issueExtensionToken` could re-insert legacy bearer-only rows.
- **Fix in Round 3**: Migration adds `CHECK (client_kind <> 'BROWSER_EXTENSION' OR cnf_jkt IS NOT NULL)` partial constraint. Schema-enforced invariant. Pre-deploy verification SQL added to confirm no IOS_APP rows with cnf_jkt IS NULL exist.

### F3-r2 [Major] — `POST /api/extension/key/reset` lacks dedicated contract
- **Fix in Round 3**: Added contract C12 with body schema, AuthN/AuthZ invariants, body-cnfJkt-must-match-proof critical invariant (closes stolen-Bearer-revoke-DoS vector), rate-limit spec, audit emission, atomicity contract with extension client.

### F4-r2 [Major] — Session-storage migration story for tokenCnfJkt undefined case
- **Fix in Round 3**: `loadSession()` returns null when `raw.tokenCnfJkt` is not a 43-char base64url string. User scenario 9 added.

### F5-r2 [Major] — `ValidateTokenDpopRow.clientKind` re-declared as literal union
- **Fix in Round 3**: C5 signature imports `ExtensionTokenClientKind` from `@prisma/client`.

### F6-r2 [Major] — C8 sign-failure rationale inverted (silent 401 → clearToken sign-out loop)
- **Fix in Round 3**: C8 retries DPoP signing once with fresh keypair; second failure throws `DpopSignError` so callers can distinguish from server 401. Callers MUST NOT clearToken on this branch.

### F7-r2 [Minor] — requestExtensionJkt SSR safety unspecified
- **Fix in Round 3**: Helper file gets `"use client"` directive at top; module-top doesn't access browser globals.

### F8-r2 [Minor] — Helper file location convention
- **Status**: Acknowledged; kept at `src/lib/extension-jkt-request.ts` (close to caller). Cosmetic concern.

### F9-r2 [Minor] — C10 forbidden-pattern regex too narrow
- **Fix in Round 3**: Reliance shifted to C10 integration test (acceptance: "new row's cnfJkt equals old's") rather than fragile multi-line regex.

## Security Findings (Round 2)

Round 1 status: S1-S10 all Resolved or Partially-resolved.

### S11 [Major] — /api/extension/key/reset endpoint lacks contract (DUPLICATE of F3-r2)
- **Fix in Round 3**: Contract C12 added.

### S12 [Major] — Migration breaks existing extension-token-migration.integration.test.ts fixture
- **Fix in Round 3**: Plan explicitly mandates test rewrite. Phase 2 grep checklist: `grep -rn "accepts a BROWSER_EXTENSION row without a DPoP"` must return zero hits post-rewrite.

### S13 [Major] — canonicalHtuClient semantics undefined
- **Fix in Round 3**: Algorithm pinned as `new URL(serverUrl).origin + route`. Equivalence smoke test added to `src/lib/auth/dpop/htu-canonical.test.ts`.

### S14 [Minor] — type-only import for ValidatedExtensionToken (DUPLICATE of F1-r2 cycle concern)
- **Fix in Round 3**: Resolved via the new leaf type module + `import type` invariant.

### S15 [Minor] — Access-Control-Max-Age 24h caches preflight
- **Fix in Round 3**: Added to Known Risks table. No code change this PR.

### S16 [Minor] — DPoP jti cache scaling no documented estimate
- **Fix in Round 3**: NFR6 added.

### S17 [Minor] — SW kill mid-keygen leaves stranded server-side token
- **Fix in Round 3**: C6 persist-before-resolve ordering invariant + dedicated test for mid-kill recovery. Known Risks acknowledges self-healing nature.

### S18 [Minor] — Scope set unchanged note missing
- **Fix in Round 3**: C5 invariants add "scope set unchanged from pre-this-PR." Known Risks acknowledges.

### S19 [Informational] — DPoP header injection vector verified clean
- No action needed.

### S20 [Minor] — TRUNCATE replication semantics
- **Fix in Round 3**: Migration SQL header documents (this repo doesn't use logical replication).

### S21 [Minor] — /api/extension/key/reset proxy gate routing
- **Fix in Round 3**: Server-changes section now explicitly adds `API_PATH.EXTENSION_KEY_RESET` + `EXTENSION_TOKEN_ROUTES` entry. C12 acceptance includes the routing test.

### S22 [Minor] — TRUNCATE deploy window UX
- **Fix in Round 3**: Added to Known Risks table.

## Testing Findings (Round 2)

Round 1 status: T1-T14 mostly Resolved; T7 / T8 / T10 had remaining gaps surfaced as T18 / T19 / T20.

### T15 [Major] — DPOP_VERIFY_ERROR count wrong ("7" not 15)
- **Fix in Round 3**: Iteration source = `Object.values(DPOP_VERIFY_ERROR)`. Plan reflects all 15 codes.

### T16 [Major] — /api/extension/key/reset has zero test plan
- **Fix in Round 3**: Added `src/__tests__/api/extension/key-reset.test.ts` with full coverage (auth, body-cnfJkt-must-match-proof, idempotency, rate-limit, negative control, cross-user safety).

### T17 [Major] — Migration destructive DELETE untested against populated state
- **Fix in Round 3**: New integration test `src/__tests__/db-integration/migration-extension-cnfjkt.integration.test.ts` seeds populated state, runs migration, asserts row survival/deletion.

### T18 [Major] — Playwright launchPersistentContext test isolation
- **Fix in Round 3**: Per-test fresh `userDataDir` via `test.beforeEach`.

### T19 [Major] — page.on('request') doesn't capture SW fetches
- **Fix in Round 3**: Use `context.on('request', ...)` for context-level capture. Fallback to `context.waitForEvent('serviceworker').then(sw => sw.on('request', ...))` if needed.

### T20 [Minor] — Boot test navigator.storage.estimate non-specific
- **Fix in Round 3**: Replaced with direct IDB inspection script (open db → get current → assert privateKey instanceof CryptoKey + extractable === false).

### T21 [Minor] — npm build failure mode
- **Fix in Round 3**: `e2e/global-setup.ts` wraps spawn in try/catch with stdout/stderr in error message.

### T22 [Minor] — Test file placement convention
- **Fix in Round 3**: Co-located at `src/lib/auth/dpop/validate-token-dpop.test.ts` (matches existing verify.test.ts neighbors).

### T23 [Minor] — attemptTokenRefresh not exported → testability
- **Fix in Round 3**: Extract `attemptTokenRefresh` + `revokeCurrentTokenOnServer` to `extension/src/background/token-handler.ts` (named exports). Tests import directly.

### T24 [Minor] — Strict-mode test confirms 400 but not reason
- **Fix in Round 3**: Assertion extended to verify Zod issue with `code: "unrecognized_keys"`.

### T25 [Minor] — Race-test idbWriteCount instrumentation
- **Fix in Round 3**: Replaced with observable-state assertion `(await getAll()).length === 1`.

### T26 [Minor] — Mock-update obligation lists 1 file but needs broader grep
- **Fix in Round 3**: C5 documents the grep command rather than a fixed file list.

## Adjacent Findings
No new Adjacent findings in Round 2; previous Adjacents resolved by Round 2 plan rewrite.

## Recurring Issue Check
Round 2 reports R1-R37 + RS1-RS4 + RT1-RT5 status verbatim — preserved in detailed expert outputs at /tmp/tri-lSpTpO/. Summary:
- Functionality: F1-F9 (round 2 new) all addressed in Round 3.
- Security: S11-S22 (round 2 new) all addressed in Round 3.
- Testing: T15-T26 (round 2 new) all addressed in Round 3.

## Summary

- **Round 2 Critical (3)**: F1-r2/S14 (type cycle), F2-r2 (schema invariant), T15 (enum count) — ALL applied to Round 3 plan.
- **Round 2 Major (11)**: F3-r2/S11/T16 (C12 endpoint), F4-r2 (session-storage upgrade), F5-r2 (Prisma enum import), F6-r2 (sign-failure retry), S12 (test rewrite), S13 (canonicalHtuClient algorithm), T17 (migration test), T18 (E2E isolation), T19 (SW fetch capture) — ALL applied to Round 3 plan.
- **Round 2 Minor (~10)**: applied inline (S15/S16/S17/S18/S20/S21/S22/T20-T26) or acknowledged in Known Risks (F7, F8, F9).

Recommended action: **launch Round 3 expert review** to confirm all Round 2 findings are correctly resolved in the Round 3 plan AND to surface any final Critical/Major items before Phase 1 closes.

Cleanup: `bash ~/.claude/hooks/tri-tmpdir.sh cleanup /tmp/tri-lSpTpO` after Round 3 completes.
