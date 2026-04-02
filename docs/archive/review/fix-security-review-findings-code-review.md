# Code Review: fix-security-review-findings
Date: 2026-04-03
Review rounds: 2

## Round 1 Findings

### Functionality Findings
- [FUNC-F1] Major: Importer dead code path still writes aadVersion:0 → **Resolved**
- [FUNC-F2] Major: `personal-login-form-submit-args.ts` retains `userId ?? undefined` → **Resolved**
- [FUNC-F3] Minor: Attachment aadVersion default change backward compat → Accepted (clients always send explicitly)
- [FUNC-F4] Minor: `SubmitPersonalLoginFormArgs.userId` optional inconsistency → **Resolved**

### Security Findings
- [F-1] Minor: secretBytes.fill(0) reference correctness → Confirmed correct
- [F-2] Minor: secretHex heap residual window → Accepted risk (process exits promptly)
- [F-3] Major: Importer aadVersion:0 dead code → **Resolved** (same as FUNC-F1)
- [F-4] Minor: !userId early return no-op → No security impact
- [F-5] Minor: Attachment default compat → Accepted
- [F-6] Major: rotate-key accepts aadVersion:0 downgrade → **Resolved** (min(1) enforced; DB confirmed zero legacy entries)

### Testing Findings
- [T1] Major: personal-login-submit !userId guard untested → **Resolved**
- [T2] Critical: importer userId guard untested → **Resolved**
- [T3] Minor: Tests use hardcoded values instead of AAD_VERSION → **Resolved**
- [T4] Minor: use-personal-base-form-model !userId guard untested → **Resolved**

## Round 2 Findings

All three experts: **No findings** (all round 1 issues resolved or deferred with justification).

Minor observation (not a finding):
- `use-import-execution.ts` userId type (`?: string`) diverges from new `string | null` pattern. Not a runtime bug; tracked for future hardening.

## Deferred Items

None — all findings resolved in this PR.

(F-6 was initially deferred but resolved after DB inspection confirmed zero aadVersion:0 entries exist.)

## Resolution Status

### [FUNC-F1/F-3] Major: Importer dead code
- Action: Removed ternary, now uses `buildPersonalEntryAAD(userId!, entryId)` + `aadVersion: AAD_VERSION`
- Modified file: `src/components/passwords/password-import-importer.ts:152-163`

### [FUNC-F2] Major: userId type inconsistency
- Action: Changed `userId` from optional to `string | null` across controller chain
- Modified files: `personal-login-submit.ts:18`, `personal-login-form-submit-args.ts:14`, `personal-login-form-controller.ts:18`

### [T1] Major: personal-login-submit !userId test
- Action: Added test "returns early when userId is null"
- Modified file: `personal-login-submit.test.ts`

### [T2] Critical: importer guard tests
- Action: Added tests for missing userId and missing encryptionKey
- Modified file: `password-import-importer.test.ts`

### [T3] Minor: AAD_VERSION constant in tests
- Action: Imported AAD_VERSION in test files, replaced hardcoded values
- Modified files: `personal-entry-save.test.ts`, `attachments/route.test.ts`

### [T4] Minor: use-personal-base-form-model !userId test
- Action: Added test "returns early without calling execute when userId is null"
- Modified file: `use-personal-base-form-model.test.ts`
