# Plan Review: itemkey-attachment-migration
Date: 2026-03-09
Review round: 2 (final)

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] ItemKey data fetching strategy unspecified
- **Problem**: Plan says "fetch entry's encryptedItemKey from API" but doesn't specify which endpoint. Current `GET /api/teams/[teamId]/passwords/[id]` returns full entry data (heavy). Fetching full entry just for ItemKey is wasteful.
- **Impact**: Unnecessary data transfer on every attachment upload/download.
- **Recommended action**: Pass ItemKey data as props from the parent component (entry detail page already has this data), rather than re-fetching from API.

### F2 [Major] Download-side encryptionMode=0 guard missing (merged: Functionality #2 + Security #1)
- **Problem**: Plan specifies using ItemKey for download but doesn't handle legacy encryptionMode=0 attachments in DB. Client will try ItemKey decrypt → AES-GCM authTag failure → opaque error.
- **Impact**: Users see unclear "download error" for legacy attachments.
- **Recommended action**: Check `encryptionMode` in download response; if `0`, show explicit error "This attachment uses legacy encryption and cannot be decrypted. Please re-upload."

### F3 [Major] ItemKey cache data structure unspecified (merged: Functionality #3 + Security #2)
- **Problem**: Current `cacheRef` is `Map<string, CachedTeamKey>` keyed by teamId. Plan adds per-entry ItemKey cache but doesn't specify data structure or how `invalidateTeamKey(teamId)` clears all entry caches for that team.
- **Impact**: Risk of stale ItemKey cache after TeamKey rotation; removed member could access attachments during cache TTL.
- **Recommended action**: Use separate `Map<string, Map<string, CachedItemKey>>` (teamId → entryId), clear outer entry on `invalidateTeamKey(teamId)`.

### F4 [Minor] encryptionMode should be required, not defaulted (merged: Functionality #4 + Security #4)
- **Problem**: Plan changes default from 0 to 1, but client bug (missing field) would silently store with mode=1 even if encrypted with wrong key.
- **Impact**: Potential storage of undecryptable data.
- **Recommended action**: Make `encryptionMode` a required field (400 if missing). No default.

## Security Findings

### S1 [Minor] Attachment AAD lacks teamId
- **Problem**: Attachment AAD scope "AT" uses `(entryId, attachmentId)` without `teamId`. Theoretically allows cross-team ciphertext transplant at DB level.
- **Impact**: Low — ItemKey is per-entry and team-specific, plus server-side RLS checks. Exploitable only with DB-level write access.
- **Recommended action**: Consider adding teamId to AAD in future v2. Not blocking for this migration.

## Testing Findings

### T1 [Major] Existing success test needs encryptionMode assertion
- **Problem**: Current `team-attachments.test.ts` success test doesn't include `encryptionMode` in FormData. After changing defaults, test passes silently without verifying correct mode is stored.
- **Impact**: Default value regression undetectable.
- **Recommended action**: Add assertion that DB record has `encryptionMode: 1`.

### T2 [Major] itemKeyVersion edge cases in API test
- **Problem**: Plan says "reject upload when itemKeyVersion=0" but doesn't specify handling of `itemKeyVersion: undefined` (legacy data). Current `select` clause doesn't fetch `itemKeyVersion`.
- **Impact**: `undefined` comparison could bypass guard.
- **Recommended action**: Add 3 test cases: (1) `itemKeyVersion: 0` → 400, (2) `itemKeyVersion: undefined` → 400, (3) `itemKeyVersion: 1` → success. Update `select` clause to include `itemKeyVersion`.

### T3 [Major] No client-side component tests
- **Problem**: `team-attachment-section.tsx` has no unit tests. Server stores opaque ciphertext, so API tests can't detect wrong-key encryption.
- **Impact**: Key mix-up (TeamKey vs ItemKey) undetectable until decrypt failure.
- **Recommended action**: Add component test verifying: (1) `getItemEncryptionKey` called, not `getTeamEncryptionKey`, (2) FormData includes `encryptionMode: "1"`, (3) AAD from `buildAttachmentAAD` is passed.

### T4 [Minor] Download test fixture missing encryptionMode
- **Problem**: Download test `ATTACHMENT` fixture lacks `encryptionMode` field.
- **Impact**: encryptionMode response not validated.
- **Recommended action**: Add `encryptionMode: 1` to fixture and assert in response.

### T5 [Minor] teamKeyVersion validation relevance under ItemKey mode
- **Problem**: Under encryptionMode=1, TeamKey wraps ItemKey but doesn't directly encrypt attachment. Current `teamKeyVersion` validation may cause race conditions after rotation.
- **Impact**: Upload failure during TeamKey rotation race window.
- **Recommended action**: Document in plan whether `teamKeyVersion` check is kept, modified, or removed for encryptionMode=1.

## Round 2 Findings

### Functionality

#### F5 [Major] clearAll() must also clear ItemKey cache — RESOLVED
- Reflected in plan Step 1: `clearAll()` now explicitly clears ItemKey cache Map

#### F6 [Major] Upload FormData must include encryptionMode=1 — RESOLVED
- Reflected in plan Step 2: explicit `formData.append("encryptionMode", "1")`

#### F7 [Minor] TeamKey fetch + AAD construction detail — RESOLVED
- Reflected in plan Step 1: internally calls `getTeamEncryptionKey()`, builds `buildItemKeyWrapAAD(teamId, entryId, itemKeyData.teamKeyVersion)`

#### F8 [Minor] Download ItemKey metadata source — RESOLVED
- Reflected in plan Step 2: `itemKeyData` passed via props from parent component

### Security
No findings.

### Testing
No findings.
