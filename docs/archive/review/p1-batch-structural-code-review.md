# Code Review: p1-batch-structural
Date: 2026-03-14
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Critical] SSH key passphrase/comment fields silently undefined at runtime
- **File**: `src/components/passwords/password-card.tsx:417-418`
- **Problem**: `VaultEntryFull` renamed `passphrase`→`sshPassphrase`, `comment`→`sshComment`, but the encrypted blob JSON keys are still `passphrase`/`comment`. At runtime, `entry.sshPassphrase` is always `undefined`.
- **Impact**: SSH passphrase and comment silently dropped from inline detail panel
- **Resolution**: Reverted `VaultEntryFull` to `passphrase`/`comment` (matching blob keys). Restored mapping: `sshPassphrase: entry.passphrase`. Updated `FullEntryData` to use blob key names with alias comments.

### F2 [Minor] `UpdateTeamTagInput` type not exported from `validations/team.ts`
- **File**: `src/lib/validations/team.ts`
- **Problem**: Original `validations.ts` exported this type; the split dropped it
- **Resolution**: Added `export type UpdateTeamTagInput = z.infer<typeof updateTeamTagSchema>;`

## Security Findings

No findings.

## Testing Findings

### T1 [Critical] Blob key mismatch (duplicate of F1)
- **Resolution**: Same as F1

### T2 [Major] `entry-history-keys.ts` expects old blob field names
- **Problem**: Uses `"passphrase"` and `"comment"` as blob keys
- **Resolution**: These ARE the correct blob keys. F1 fix confirms blob keys are `passphrase`/`comment`. No change needed.

### T3 [Major] No unit test for `entry-save-core.ts`
- **File**: `src/lib/entry-save-core.ts` (new, no test)
- **Problem**: Extracted shared helper has non-trivial logic (mode-conditional ID, null vs undefined)
- **Resolution**: Added `src/lib/entry-save-core.test.ts` with 9 tests covering create/edit mode, optionals null/undefined handling, AAD passthrough, and submitEntry.

### T4 [Minor] `EXPECTED_SENSITIVE` references `"passphrase"` (sub-point of T2)
- **Resolution**: `"passphrase"` IS the correct blob key. No change needed.

## Resolution Status (Round 1)
All findings resolved in commit `review(1)`.
- F1 Critical: Fixed (reverted VaultEntryFull to blob keys)
- F2 Minor: Fixed (added export)
- T1 Critical: Fixed (same as F1)
- T2 Major: Dismissed (blob keys are correct)
- T3 Major: Fixed (added tests)
- T4 Minor: Dismissed (blob keys are correct)

---

# Code Review Round 2
Date: 2026-03-14

## Changes from Previous Round
Round 1 fixes applied. Round 2 review by three expert agents.

## Functionality Findings (Round 2)
### F3 [Minor] Deviation log DEV-03 inaccurately described VaultEntryFull rename
- **Status**: Resolved
- **Action**: Updated DEV-03 to accurately state fields were intentionally NOT renamed (blob key rationale)

## Security Findings (Round 2)
No findings.

## Testing Findings (Round 2)
### T5 [Major → Dismissed] team-entry-save.test.ts missing
- **Status**: Dismissed — file exists (4122 bytes, created during implementation)

### T6 [Minor] submitEntry PUT path untested
- **Status**: Resolved — added PUT method test case to entry-save-core.test.ts

### T7 [Minor] extra spread order could overwrite core fields
- **Status**: Resolved — added JSDoc warning to BuildEncryptedBodyParams.extra

### T8 [Minor] encryptData mock type mismatch
- **Status**: Skipped — mock tests behavior not type accuracy, no real issue

## Resolution Status (Round 2)
- F3 Minor: Fixed (deviation log updated)
- T5 Major: Dismissed (file exists)
- T6 Minor: Fixed (PUT test added)
- T7 Minor: Fixed (JSDoc added)
- T8 Minor: Skipped (not actionable)
