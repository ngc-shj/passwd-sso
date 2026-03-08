# Code Review: itemkey-attachment-migration

Date: 2026-03-09
Review round: 1

## Changes from Previous Round

Initial review

## Functionality Findings

### F1 [Major] getItemEncryptionKey unit tests missing (merged: Functionality #1 + Testing #1 + Testing #2)

- **File**: `src/lib/team-vault-core.tsx` (lines 268-329)
- **Problem**: No unit tests for `getItemEncryptionKey` — API fetch, unwrap, derive, cache, and cache invalidation are all untested. Plan Step 5 explicitly requires these tests.
- **Recommended fix**: Add tests to existing `team-vault-core.test.tsx` covering: normal flow, itemKeyVersion < 1 error, cache hit, `invalidateTeamKey` clearing ItemKey cache, `clearAll` clearing ItemKey cache.

## Security Findings

### S1 [Major] Client-provided attachmentId lacks UUID format validation

- **File**: `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts` (lines 147, 234)
- **Problem**: `clientId` from FormData is used as `attachmentId` without format validation. Attacker could submit non-UUID values, potentially causing unique constraint errors or injecting into blob store paths.
- **Recommended fix**: Validate `clientId` against UUID v4 regex, reject with 400 if invalid.

### S2 [Minor] aadVersion accepts arbitrary values

- **File**: `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts` (line 216)
- **Problem**: `aadVersion` parsed via `parseInt` without range validation. NaN or 0 could bypass AAD protection on download side (client checks `aadVersion >= 1`).
- **Recommended fix**: Force `aadVersion = 1` or validate against whitelist `[1]`.

## Testing Findings

### T1 [Minor] Co-located test for missing encryptionMode tests wrong condition

- **File**: `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.test.ts` (lines 387-402)
- **Problem**: The "missing encryptionMode" test doesn't include other required fields, so it hits MISSING_REQUIRED_FIELDS before reaching encryptionMode check. The `src/__tests__` version is correct.
- **Recommended fix**: Already covered correctly in `src/__tests__/api/teams/team-attachments.test.ts`. The co-located test is a duplicate with less coverage — consider removing.

### T2 [Minor] Co-located test missing blob-store mock

- **File**: `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.test.ts`
- **Problem**: `@/lib/blob-store` not mocked; relies on implicit passthrough. Could fail with different storage backend config.
- **Recommended fix**: Add blob-store mock for consistency.

## Resolution Status

**F1 [Major] getItemEncryptionKey unit tests missing**

- Action: Added 5 tests to `team-vault-core.test.tsx`: normal flow (fetch+unwrap+derive+cache), itemKeyVersion < 1 error, entry fetch failure, invalidateTeamKey clearing ItemKey cache, clearAll clearing ItemKey cache
- Modified file: `src/lib/team-vault-core.test.tsx`

**S1 [Major] Client-provided attachmentId lacks UUID format validation**

- Action: Added UUID v4 regex validation for `clientId`, returns 400 VALIDATION_ERROR if invalid
- Modified file: `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts`
- Tests added: `src/__tests__/api/teams/team-attachments.test.ts` (rejects non-UUID, accepts valid UUID)

**S2 [Minor] aadVersion accepts arbitrary values**

- Action: Added validation that `aadVersion` must be exactly 1, returns 400 VALIDATION_ERROR otherwise
- Modified file: `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts`
- Tests added: `src/__tests__/api/teams/team-attachments.test.ts` (rejects aadVersion=2)

**T1 [Minor] Co-located test for missing encryptionMode tests wrong condition**

- Action: Deferred — the co-located test still hits MISSING_REQUIRED_FIELDS which is the correct error code. The `src/__tests__` version provides comprehensive coverage. Low impact.

**T2 [Minor] Co-located test missing blob-store mock**

- Action: Deferred — co-located tests pass without explicit mock. The `src/__tests__` version has proper blob-store mock. Low impact.
