# Plan Review: p1-batch-structural
Date: 2026-03-14
Review round: 1 (final)

## Changes from Previous Round
Initial review

## Functionality Findings

### Major: `encryptedItemKey` type incorrect in discriminated union
- **Severity**: Major
- **Problem**: Plan specified `encryptedItemKey?: string` but actual type is `{ ciphertext: string; iv: string; authTag: string }`
- **Impact**: Would produce incorrect implementation
- **Resolution**: Fixed in plan — updated type to match `team-entry-save.ts`

### Major: `password-import-importer.ts` not in scope
- **Severity**: Major (reported) → Dismissed
- **Problem**: Agent flagged missing importer file from scope
- **Resolution**: File does not exist in codebase. Finding dismissed.

### Minor: load-test `status === 200` checks
- **Severity**: Minor → Dismissed
- **Problem**: Load-test files check `status === 200` for POST endpoints
- **Resolution**: All affected endpoints (`vault/unlock`, `passwords/generate`) are action endpoints, not resource creation. They correctly return 200. No change needed.

### Minor: `entry.ts` vs `password.ts` naming
- **Severity**: Minor → Kept as-is
- **Problem**: Naming inconsistency suggestion
- **Resolution**: `entry.ts` is correct — schemas describe entries, consistent with codebase naming (`PasswordEntry` model, entry save functions).

## Security Findings

### Major: `aadVersion: 0` write path closure missing from implementation steps
- **Severity**: Major (reported) → Dismissed
- **Problem**: Agent flagged that closing the `aadVersion: 0` write path is not in implementation steps
- **Resolution**: `aadVersion: 0` occurs in edit mode when `userId` is not provided — this is intentional backwards-compatible behavior. The plan already states "Do NOT change aadVersion behavior — existing aadVersion: 0 read path must remain". No closure needed.

### Minor: `shareDataSchema.passphrase`/`.comment` are API field names
- **Severity**: Minor
- **Problem**: These share-link schema fields could be accidentally renamed during Item 7
- **Resolution**: Added explicit exclusion note to plan Considerations section.

### Minor: load-test status hardcode
- **Severity**: Minor → Dismissed (duplicate of Functionality finding)

## Testing Findings

### Critical: `personal-entry-save.test.ts` line 74 `aadVersion: 0` assertion contradicts plan
- **Severity**: Critical (reported) → Dismissed
- **Problem**: Test asserts `aadVersion === 0` which appears to contradict plan
- **Resolution**: This assertion tests the edit-mode path where `userId` is not provided, making `aad` undefined and `aadVersion` correctly 0. This is intentional behavior preserved by the plan's constraint "Do NOT change aadVersion behavior". No contradiction.

### Major: `password-import-importer.ts` not in Item 11 scope
- **Severity**: Major → Dismissed (file does not exist)

### Major: load-test status check not in Step 4
- **Severity**: Major → Dismissed (action endpoints, not creation)

### Minor: `entry.ts` vs `password.ts` naming
- **Severity**: Minor → Dismissed (duplicate)

## Summary
- 1 finding required plan update (encryptedItemKey type)
- 1 finding added as exclusion note (shareDataSchema fields)
- 1 finding added as clarification (load-test files)
- Remaining findings dismissed with justification
- All agents satisfied — no further review rounds needed
