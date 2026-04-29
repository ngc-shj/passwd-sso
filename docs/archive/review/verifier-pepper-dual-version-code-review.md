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

(To be populated after fixes are applied.)
