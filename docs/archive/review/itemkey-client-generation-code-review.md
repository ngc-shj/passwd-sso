# Code Review: itemkey-client-generation
Date: 2026-03-09T03:25:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F-1 [Critical] Update schema refine blocks F3 (v>=1 reuse)
- **File**: `src/lib/validations.ts:198`
- **Problem**: `updateTeamE2EPasswordSchema` refine rejected `itemKeyVersion>=1` without `encryptedItemKey`, blocking F3 (edit v>=1 entries that reuse existing ItemKey)
- **Impact**: v>=1 entries could not be edited after initial save
- **Resolution**: Changed refine to allow `itemKeyVersion>=1` without `encryptedItemKey` for updates. Added server-side guard for v0→v1 upgrade requiring `encryptedItemKey`.

### F-2 [Major] getEntryDecryptionKey optional fallthrough
- **File**: `src/components/team/team-entry-submit.ts:115`
- **Problem**: `getEntryDecryptionKey` was optional in the interface; if undefined for v>=1 entries, would silently fall through to v0→v1 upgrade branch, generating a new ItemKey and causing data inconsistency
- **Impact**: Potential data corruption for v>=1 entries if called without `getEntryDecryptionKey`
- **Resolution**: Added explicit throw guard: `if (!getEntryDecryptionKey) throw new Error("getEntryDecryptionKey is required for v>=1 entries")`

### F-3 [Minor] Client-side validation only covers create mode (merged with S-5)
- **File**: `src/lib/team-entry-save.ts:41`
- **Problem**: `encryptedItemKey` required check only for `mode === "create"`, not for edit v0→v1 upgrade
- **Impact**: Low — current caller always provides correctly; server rejects invalid requests
- **Resolution**: Accepted as-is — defense-in-depth gap is mitigated by server-side validation

## Security Findings

### S-1 [Major] buildItemKeyWrapAAD missing itemKeyVersion
- **File**: `src/lib/crypto-aad.ts:133`
- **Problem**: `buildItemKeyWrapAAD` does not include `itemKeyVersion` in AAD
- **Impact**: Low — `itemKeyVersion` is always 1 when wrapping (no other versions exist), and AAD already binds to teamId+entryId+teamKeyVersion. No practical attack vector with current version scheme.
- **Resolution**: Deferred — will add when multi-version wrapping is introduced. Current single-version scheme provides sufficient domain separation.

### S-2 [Major] Server PUT allows itemKeyVersion update without encryptedItemKey
- **File**: `src/app/api/teams/[teamId]/passwords/[id]/route.ts:213`
- **Problem**: When upgrading v0→v1, server could accept `itemKeyVersion=1` without `encryptedItemKey`
- **Impact**: Data corruption — entries become permanently undecryptable
- **Resolution**: Added server-side guard at line 171-177: if upgrading from v0 to v>=1 and `encryptedItemKey` is missing, return 400 ITEM_KEY_REQUIRED

### S-3 [Minor] History PATCH req.json() lacks try-catch
- **File**: `src/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/route.ts`
- **Impact**: Operational, not crypto issue
- **Resolution**: Out of scope for this PR

### S-4 [Minor] History PATCH encryptedItemKey not validated
- **Resolution**: Out of scope for this PR

## Testing Findings

### T-1 [Major] team-entry-submit.test.ts missing 3-mode coverage
- **Problem**: Only tested create success and edit failure; missing edit v>=1, edit v0→v1, and guard behavior
- **Resolution**: Added 4 new tests: create with ItemKey verification, edit v>=1 reuse, edit v0 upgrade, getEntryDecryptionKey guard

### T-2 [Major] Server downgrade prevention test missing
- **Problem**: No test for `ITEM_KEY_VERSION_DOWNGRADE` rejection in PUT handler
- **Resolution**: Deferred — requires full API route test setup with Prisma mocks. Server logic is straightforward (3-line check).

### T-3 [Minor] team-edit-dialog-loader.test.tsx v1 data passing untested
- **Resolution**: Added test case verifying correct arguments to `getEntryDecryptionKey` for v1 entries

### T-4 [Minor] Import payload not directly asserted for ItemKey fields
- **Resolution**: Accepted as-is — encrypt call count (4x) indirectly verifies two-blob encryption per entry

### T-5 [Minor] History section getEntryDecryptionKey args not verified
- **Resolution**: Accepted as-is — mock setup is sufficient for behavior verification

## Resolution Status

### F-1 [Critical] Update schema refine blocks F3
- Action: Changed refine logic in validations.ts; updated test in validations.test.ts
- Modified files: src/lib/validations.ts:196-203, src/lib/validations.test.ts:386-395

### F-2 [Major] getEntryDecryptionKey optional fallthrough
- Action: Added explicit throw guard in team-entry-submit.ts
- Modified file: src/components/team/team-entry-submit.ts:115-118

### S-2 [Major] Server PUT upgrade without encryptedItemKey
- Action: Added v0→v1 upgrade guard in PUT handler
- Modified file: src/app/api/teams/[teamId]/passwords/[id]/route.ts:171-177

### T-1 [Major] Missing test coverage for 3 modes
- Action: Added 4 new test cases in team-entry-submit.test.ts
- Modified file: src/components/team/team-entry-submit.test.ts

### T-3 [Minor] Missing v1 edit dialog loader test
- Action: Added v1 test case in team-edit-dialog-loader.test.tsx
- Modified file: src/components/team/team-edit-dialog-loader.test.tsx
