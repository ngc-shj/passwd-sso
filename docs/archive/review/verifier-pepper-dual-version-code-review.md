# Code Review: verifier-pepper-dual-version

Date: 2026-04-29
Review round: 1

## Changes from Previous Round

Initial code review (Phase 3 Round 1).

## Functionality Findings

**[F1] Minor: Dead if-condition in `verifyPassphraseVerifier` pepper-error catch block**
- File: `src/lib/crypto/crypto-server.ts:302-316`
- Evidence: Both branches of the `if (pepperErr.message.includes(...))` and the fallthrough `return` are identical — both return `{ ok: false, reason: "MISSING_PEPPER_VERSION" }`. The condition is never functionally evaluated.
- Impact: No current functional bug (`hmacVerifier` only throws for pepper-fetch errors in this code path), but dead conditional misleads future maintainers and produces incorrect classification if `hmacVerifier` is later extended to throw for other reasons.
- Fix: Collapse to single unconditional `return { ok: false, reason: "MISSING_PEPPER_VERSION" }` with a comment explaining the design choice.

**[F2] Minor: `unlock` route SELECT omits `tenantId` (deviation from plan checklist)**
- File: `src/app/api/vault/unlock/route.ts:65-76`
- Evidence: Plan checklist line 630 said `tenantId: true` should be included; implementation omits.
- Impact: No current runtime bug — unlock has no verify call so `tenantAuditBase` is not used. Forward-compat gap if backfill is later extended to emit audit on failure.
- Fix: Add `tenantId: true` to SELECT for defensive completeness.

**[F3] Minor [Adjacent → Testing]: route test mocks return incomplete `VerifyResult` shape on failure path**
- File: `src/app/api/vault/change-passphrase/route.test.ts:20`, `src/app/api/vault/recovery-key/recover/route.test.ts:25`
- Evidence: `vi.fn((c, s, _v) => ({ ok: c === s }))` — when `ok` is false, `reason` field is omitted.
- Impact: Real `VerifyResult` requires `reason` when `ok: false`. Routes branching on `r.reason === "MISSING_PEPPER_VERSION"` see `undefined`, masking the audit-emission test path.
- Fix: Default mock to `{ ok: false, reason: "WRONG_PASSPHRASE" as const }` for the failure case.

## Security Findings

**[S1] Minor: Dead if-condition in pepper-error catch block (same as F1)**
- File: `src/lib/crypto/crypto-server.ts:302-316`
- Acceptable per threat model. Verifies `MISSING_PEPPER_VERSION` early-return creates timing diff but is operator-config oracle, not credential oracle.
- Fix: Same as F1 — collapse to unconditional return.

(No other security findings.)

## Testing Findings

**[T1] Major: V1 backward-compat shim in `resolveSecretName` untested in cloud providers**
- File: `src/lib/key-provider/base-cloud-provider.ts:120-131`
- Evidence: No test calls `resolveSecretName("verifier-pepper", 1)` to assert the unversioned base name; no test calls `(name, 2)` to assert `-v2` suffix.
- Impact: A rename of the `isVerifierPepperV1` constant or a refactor of the bypass logic silently breaks V1 cloud deployments at rotation time.
- Fix: Add tests in base-cloud-provider or aws-sm-provider:
  - `resolveSecretName("verifier-pepper", 1)` → unversioned base name
  - `resolveSecretName("verifier-pepper", 2)` → `<baseName>-v2`
  - `resolveSecretName("share-master", 1)` → `<baseName>-v1` (confirms no bypass leak to other keys)

**[T2] Major: travel-mode/disable VERIFIER_PEPPER_MISSING audit emission untested**
- File: `src/app/api/travel-mode/disable/route.ts:79-84`
- Evidence: grep for `MISSING_PEPPER_VERSION` and `VERIFIER_PEPPER_MISSING` in `travel-mode.test.ts` returns zero hits.
- Impact: A refactor that drops the audit branch silently passes tests; operators miss misconfig alerts.
- Fix: Add test mocking `verifyPassphraseVerifier` to return `{ ok: false, reason: "MISSING_PEPPER_VERSION" }`; assert `mockLogAudit` called with `action: "VERIFIER_PEPPER_MISSING"` and tenant scope.

**[T3] Major: share-links/verify-access VERIFIER_PEPPER_MISSING audit emission untested**
- File: `src/app/api/share-links/verify-access/route.ts:75-79`
- Evidence: grep for `MISSING_PEPPER_VERSION` in verify-access route test returns zero hits.
- Impact: Misconfig with V2 share's pepper key missing falls through to incorrect path; audit event silent.
- Fix: Add test mocking `verifyAccessPassword` to return `{ ok: false, reason: "MISSING_PEPPER_VERSION" }`; assert audit emission with correct action and tenant scope.

**[T4] Major: METADATA_BLOCKLIST `storedVersion` entry has no test coverage**
- File: `src/lib/audit/audit-logger.ts:40` / `audit-logger.test.ts:76-83`
- Evidence: The existing test enumerates blocklist members in a hardcoded array — `storedVersion` is absent from that list.
- Impact: NF-No-Plaintext-Pepper-In-Logs: accidental removal of `storedVersion` from blocklist would leak version data to logs without test failure.
- Fix: Add `"storedVersion"` to expected array in `audit-logger.test.ts:76`. Add behavioral test: create audit event with `metadata: { storedVersion: 2, shareId: "x" }` and assert log line excludes `storedVersion`.

**[T5] Minor: vault-reset.test.ts field count description mismatch**
- File: `src/lib/vault/vault-reset.test.ts:137`
- Evidence: Description says "resets exactly 23..." but assertion is `toHaveLength(24)` (after the two new version fields were added).
- Impact: Misleads future reviewers; loose-coupling check is correct but description rot creates confusion.
- Fix: Update description to "resets exactly 24 vault/recovery/lockout/ECDH fields on User".

**[T6] Minor: Opportunistic re-HMAC test doesn't assert new HMAC value**
- File: `src/app/api/vault/unlock/route.test.ts:351-357`
- Evidence: `objectContaining({ passphraseVerifierVersion: 1 })` only — `passphraseVerifierHmac` not asserted.
- Impact: A route bug that updates only the version (leaving stale HMAC) goes undetected; users would fail to unlock after migration.
- Fix: Extend assertion to `objectContaining({ passphraseVerifierVersion: VERIFIER_VERSION, passphraseVerifierHmac: "a".repeat(64) })` (the value returned by mocked `hmacVerifier`).

**[T7] Major: Integration test does not exercise route handlers — simulates route logic inline**
- File: `src/__tests__/db-integration/pepper-dual-version.integration.test.ts:147-162`
- Evidence: Test 1 manually constructs `UPDATE` SQL instead of calling the unlock route handler. No `logAuditAsync` import or assertion. Comment in scenario 3 header mentions audit emission but body only tests `verifyPassphraseVerifier` directly.
- Impact: Bugs in route handler wiring (wrong field name, missed await, omitted audit emit) invisible to this suite. Header claim about audit testing is unfulfilled.
- Fix: Either (a) promote test to call route handlers + assert audit_outbox rows for scenario 3, or (b) remove the misleading "emits VERIFIER_PEPPER_MISSING" comment from scenario 3 header. Recommend (b) — route audit emission is unit-tested via T2/T3 fixes; integration test focuses on cross-version persist/hydrate symmetry.

**[T8] Minor (RT3): unlock route test hardcodes `1` instead of importing `VERIFIER_VERSION`**
- File: `src/app/api/vault/unlock/route.test.ts:354`
- Evidence: `passphraseVerifierVersion: 1` literal in assertion. Test does not import `VERIFIER_VERSION` constant.
- Impact: Brittle on version bump; produces confusing error messages.
- Fix: Import `VERIFIER_VERSION` from `@/lib/crypto/verifier-version` and use the constant.

## Adjacent Findings

- F3 (Functionality finding flagged as adjacent to testing) — covered above.

## Quality Warnings

(None — all findings cite concrete file:line evidence.)

## Recurring Issue Check

### Functionality expert
All R1-R35 checked. F1, F2, F3 — see Findings.

### Security expert
RS1, RS2, RS3, R29: PASS.
S1 — see Findings (overlap with F1).

### Testing expert
T1-T8 — see Findings.
RT1: PASS (mock signatures typed against VerifyResult).
RT2: PASS (all findings testable).
RT3: T8 violation.
R19: PASS (exact-shape preserved via objectContaining + count).
R21: PASS (verifier-version.test.ts covers all 6 cases; integration test uses _resetKeyProvider).

## Resolution Status

### F1/S1 Minor — Dead if-condition in `verifyPassphraseVerifier` catch
- Action: Collapsed to single `} catch { return { ok: false, reason: "MISSING_PEPPER_VERSION" }; }` with rationale comment.
- Modified file: `src/lib/crypto/crypto-server.ts:303-310`

### F2 Minor — `tenantId` missing from unlock SELECT
- Action: Added `tenantId: true` to the existing `findUnique` select.
- Modified file: `src/app/api/vault/unlock/route.ts`

### F3 Minor — Default route-test mock returns incomplete VerifyResult shape
- Action: Updated factory to return `{ ok: true }` on match and `{ ok: false, reason: "WRONG_PASSPHRASE" as const }` on mismatch.
- Modified files: `src/app/api/vault/change-passphrase/route.test.ts`, `src/app/api/vault/recovery-key/recover/route.test.ts`

### T1 Major — V1 backward-compat shim untested in cloud providers
- Action: Added 3 tests for `resolveSecretName`: `(verifier-pepper, 1) → bare`, `(verifier-pepper, 2) → -v2`, `(share-master, 1) → -v1` (no shim leak).
- Modified file: `src/lib/key-provider/aws-sm-provider.test.ts`

### T2 Major — travel-mode/disable VERIFIER_PEPPER_MISSING audit emission untested
- Action: Added test mocking `verifyPassphraseVerifier` to return MISSING_PEPPER_VERSION; asserts `logAuditAsync` called with `action: "VERIFIER_PEPPER_MISSING"` and tenant-base shape.
- Modified file: `src/app/api/travel-mode/travel-mode.test.ts`

### T3 Major — share-links/verify-access VERIFIER_PEPPER_MISSING audit emission untested
- Action: Added equivalent test for `verifyAccessPassword` returning MISSING_PEPPER_VERSION; asserts audit emission with `tenantAuditBase` + `ANONYMOUS_ACTOR_ID` pattern.
- Modified file: `src/app/api/share-links/verify-access/route.test.ts`

### T4 Major — METADATA_BLOCKLIST `storedVersion` entry untested
- Action: Added `"storedVersion"` to expected blocklist enumeration; added behavioral test asserting pino redacts it to `[REDACTED]` while keeping non-sensitive fields.
- Modified file: `src/lib/audit/audit-logger.test.ts`

### T5 Minor — vault-reset description "23" mismatched assertion 24
- Action: Updated test description to "resets exactly 24 vault/recovery/lockout/ECDH fields on User".
- Modified file: `src/lib/vault/vault-reset.test.ts`

### T6 Minor — opportunistic re-HMAC test didn't assert HMAC value
- Action: Extended `objectContaining` assertion to include `passphraseVerifierHmac: "a".repeat(64)` (mocked hmacVerifier return).
- Modified file: `src/app/api/vault/unlock/route.test.ts`

### T7 Major — integration test scenario 3 misleading audit comment
- Action: Replaced comment with "route audit emission is verified by unit tests in route.test.ts files" — body unchanged (verifies crypto-layer fail-closed).
- Modified file: `src/__tests__/db-integration/pepper-dual-version.integration.test.ts`

### T8 Minor RT3 — hardcoded `1` in unlock test assertion
- Action: Imported `VERIFIER_VERSION` from `@/lib/crypto/verifier-version` and replaced literal in assertions.
- Modified file: `src/app/api/vault/unlock/route.test.ts`

### Pre-existing E2E selector script bug (CLAUDE.md "Fix ALL errors")
- Action: GNU BRE interprets `\+` as the "one or more" extension, so `grep -v '^\+\+\+'` silently matched every `+`-prefixed line and yielded an empty `added_exports`, producing false-positive deleted-export warnings. Switched to `grep -vE '^\+\+\+'` (ERE = literal `+`) and `grep -vE '^---'` (anchored) for the `---` filter.
- Modified file: `scripts/checks/check-e2e-selectors.sh`

## Round 2 Findings

Local LLM seed analysis returned 4 candidate findings; all were verified inline (no sub-agent dispatch needed).

### F4 Major — REJECTED
- Claim: catch block treats any error as MISSING_PEPPER_VERSION, masking unrelated failures.
- Verification: This was the intentional design — comment in catch block documents that all errors from `getVerifierPepper(version)` (env missing, KMS fetch failure, invalid hex) are operationally indistinguishable to operator and user. The F1 fix collapsed dead code; behavior was unchanged from prior implementation.
- Anti-Deferral check: Acceptable risk — Worst case: operator sees `VERIFIER_PEPPER_MISSING` for a transient KMS network blip rather than a config gap. Likelihood: low (KMS is high-availability). Cost to fix: medium (would require introspecting error type without violating crypto-layer audit-emission decoupling).

### F5 Minor — ACCEPTED
- Claim: `grep -vF '---'` (substring match) too broad; should anchor to `^---`.
- Action: Fixed the regex to anchored ERE patterns (`^---` and `^\+\+\+`).
- Modified file: `scripts/checks/check-e2e-selectors.sh`

### T9 Major — REJECTED
- Claim: aws-sm-provider.test.ts new tests reuse `mockSend` without reset.
- Verification: `beforeEach(() => { vi.clearAllMocks(); })` exists at lines 20-22. Mock reset is in place.

### T10 Minor — REJECTED
- Claim: redaction test asserts `"[REDACTED]"` placeholder but METADATA_BLOCKLIST removes the key entirely.
- Verification: `audit-logger.ts:71-72` configures pino with `censor: "[REDACTED]"` for log output. The new test exercises the pino path (collectOutput captures pino lines), so `[REDACTED]` is the correct expectation. The `sanitizeMetadata` removal-path is for the `audit_outbox` payload, which is a different code path.

## Round 3 Findings (committed in 8a48a... — see git log)

Three sub-agents launched (Functionality / Security / Testing). Security expert returned "No findings" — confirms F1/S1 fix is timing-safe and propagation is coherent.

### F6/T11 Major — `recovery-key/generate/route.test.ts:21` mock returns incomplete VerifyResult
- Action: Updated mock factory to return `{ ok: true }` on match and `{ ok: false, reason: "WRONG_PASSPHRASE" as const }` on mismatch — parallel to F3 fix in change-passphrase + recover.
- Modified file: `src/app/api/vault/recovery-key/generate/route.test.ts`
- Detection gap analysis: F3 was applied to 2 of 3 test files in R1 because `recovery-key/generate` test was overlooked in the per-file enumeration.

### F7/T12 Major — change-passphrase + recovery-key/generate VERIFIER_PEPPER_MISSING audit emission untested
- Action: Added `mockLogAudit` (via `vi.hoisted`) + `tenantAuditBase` to audit mock factory in both files. Added new test cases asserting MISSING_PEPPER_VERSION → 401 INVALID_PASSPHRASE + audit emission with `scope: "TENANT"` + correct tenantId.
- Modified files: `src/app/api/vault/change-passphrase/route.test.ts`, `src/app/api/vault/recovery-key/generate/route.test.ts`
- Verified: `recovery-key/recover/route.test.ts:125-140` already had the equivalent test from R1 fixes.

### T13 Minor RT3 — `recovery-key/generate/route.test.ts:152` hardcoded `1`
- Action: Imported `VERIFIER_VERSION` from `@/lib/crypto/verifier-version` (already mocked) and replaced literal in assertion.
- Modified file: `src/app/api/vault/recovery-key/generate/route.test.ts`

### T14 Minor — travel-mode VERIFIER_PEPPER_MISSING test missing explicit `scope: "TENANT"`
- Action: Added `scope: "TENANT"` to the `expect.objectContaining({...})` audit assertion in the R1-added test, parallel to the verify-access test.
- Modified file: `src/app/api/travel-mode/travel-mode.test.ts`

## Round 4 Review

### Seed Finding Disposition
Seed unavailable — no dispositions to record.

### Round 4 Verification

#### Audit assertion pattern check (F7/T12 new tests)

**change-passphrase** (line 182-189):
- Uses `expect.objectContaining({ action: "VERIFIER_PEPPER_MISSING", scope: "TENANT", userId: "user-1", tenantId: "test-tenant-id" })`.
- `tenantAuditBase` mock in `vi.hoisted` returns `{ scope: "TENANT", userId, tenantId }` — identical to travel-mode/recover mocks. Pattern is consistent.
- No false-positive risk: the route emits `logAuditAsync` only on `MISSING_PEPPER_VERSION` path; success path has no `logAuditAsync` call. Mock cleared in `beforeEach`. `mockReturnValueOnce` ensures override does not leak to other tests.

**recovery-key/generate** (line 194-201):
- Same assertion shape and mock pattern as change-passphrase.
- No false-positive risk: route short-circuits before success-path `logAuditAsync` (RECOVERY_KEY_CREATED/REGENERATED) when `verifyResult.ok` is false.

#### mockLogAudit hoisting check (change-passphrase)
`mockLogAudit` added to existing `vi.hoisted` destructure (line 4). `vi.mock("@/lib/audit/audit")` factory references `mockLogAudit` at line 28. Existing tests all call `vi.clearAllMocks()` in `beforeEach` — no interference with pre-existing tests confirmed by 11/11 passing tests.

#### R19 sweep
All new `objectContaining` assertions include the behaviorally significant fields (`action`, `scope`, `userId`, `tenantId`). `metadata: { storedVersion: ... }` is intentionally omitted in all four VERIFIER_PEPPER_MISSING tests across the branch — consistent omission, not a regression. T4 (blocklist test) covers redaction of `storedVersion`.

#### RT1 / RT2 / RT3 / R21 status
- **RT1**: PASS — `travel-mode` imports `VerifyResult` type; `change-passphrase` and `recovery-key/generate` use `as const` (structurally equivalent, no regression from R3).
- **RT2**: PASS — all findings remain testable; new tests would fail if the audit-emit branch were removed.
- **RT3**: PASS — T8 and T13 fixed all version-literal assertions; no new hardcoded version literals introduced in R3.
- **R21**: PASS — integration test comment updated in T7; no new integration test scope changes.

#### Test run
39 tests across 3 files: all pass (`npx vitest run` confirmed).

### Round 4 Findings

Three sub-agents launched. Security: No findings ✓ (timing-safe, propagation coherent). Testing: No findings ✓ (R3 fixes verified pattern-consistent). Functionality: 1 Major.

#### F8 Major — `recover/route.ts` step=reset VERIFIER_PEPPER_MISSING audit emission untested
- The route has TWO independent VERIFIER_PEPPER_MISSING emit paths: `handleVerify` (line 117, step=verify) and `handleReset` (line 166, step=reset). R1 added a test for the verify branch but the structurally identical reset branch was missed.
- Action: Added parallel test in the `step=reset` describe block — mocks `verifyPassphraseVerifier` to return `MISSING_PEPPER_VERSION`, asserts 401 + audit emission with `tenantAuditBase` shape (action, scope: TENANT, tenantId).
- Modified file: `src/app/api/vault/recovery-key/recover/route.test.ts`
- Coverage gap analysis: R1 audit-emission tests covered only travel-mode and verify-access. R3 added change-passphrase and recovery-key/generate. R4 closes the last route's reset branch — now ALL 6 emit sites have explicit tests.

### Round 5 Findings

Three sub-agents launched. Security: No findings ✓ (R3+R4+R5 = 3 consecutive clean rounds). Functionality + Testing surfaced 2 unique findings (Minor only — same RT3 / R21 cleanup class as T8/T13/T7).

#### F9/T15 Minor RT3 — `recover/route.test.ts:194,196` hardcoded `1` in success-test assertions
- T8 fixed unlock test, T13 fixed generate test; the parallel assertion in recover test (step=reset success path) was overlooked.
- Action: Imported `VERIFIER_VERSION` from `@/lib/crypto/verifier-version` and replaced both literals (`passphraseVerifierVersion: 1` → `VERIFIER_VERSION`, `recoveryVerifierVersion: 1` → `VERIFIER_VERSION`). Mock-data literals at line 48 (`recoveryVerifierVersion: 1` in `userWithRecovery` fixture) intentionally kept as `1` — represents a V1-stored user.
- Modified file: `src/app/api/vault/recovery-key/recover/route.test.ts`

#### T16 Minor R21 — integration test file-level docblock claims audit emission
- T7 in R1 fixed the inline body comment but missed the file-level docblock at line 9 making the same claim.
- Action: Updated bullet 3 to "fails verification with MISSING_PEPPER_VERSION at the crypto layer ... Route audit emission ... covered by unit tests in route.test.ts files."
- Modified file: `src/__tests__/db-integration/pepper-dual-version.integration.test.ts`
