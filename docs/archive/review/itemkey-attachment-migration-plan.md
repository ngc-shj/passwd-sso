# Plan: ItemKey Attachment Migration

## Objective

Migrate team attachment encryption from TeamKey direct (encryptionMode=0) to ItemKey-based (encryptionMode=1), eliminating the legacy TeamKey direct path entirely. This aligns the implementation with the cryptography whitepaper design where ItemKey encrypts entry blob + overview + attachments.

Since the app is in development, this is a breaking change — no backward compatibility with encryptionMode=0 attachments is needed.

## Requirements

### Functional Requirements

1. All new team attachments MUST be encrypted with the per-entry ItemKey (via HKDF-derived itemEncryptionKey)
2. Download/decryption MUST use ItemKey-derived key instead of TeamKey
3. Upload MUST send `encryptionMode=1` to the API
4. API MUST reject `encryptionMode=0` uploads (breaking change)
5. TeamKey rotation MUST NOT re-encrypt attachments (ItemKey unchanged, only rewrapped)

### Non-Functional Requirements

1. No regression in existing entry blob/overview encryption
2. All tests pass (`npx vitest run`)
3. Production build succeeds (`npx next build`)
4. AAD binding remains intact (attachment AAD scope "AT" unchanged)
5. Future consideration: Add `teamId` to attachment AAD in v2 (not blocking for this migration)

## Technical Approach

### Key Hierarchy (target state)

```
TeamKey (per team, wrapped per member via ECDH)
  └── wraps ItemKey (per entry, itemKeyVersion >= 1)
        └── HKDF("passwd-sso-item-enc-v1") → itemEncryptionKey
              └── encrypts entry blob + overview + attachments (AES-256-GCM)
```

### Architecture Decisions

1. **Reuse per-entry ItemKey for attachments** — no separate per-attachment key. ItemKey already exists for entries with `itemKeyVersion >= 1`. Attachments use the same HKDF-derived `itemEncryptionKey`.
2. **Require `itemKeyVersion >= 1`** — entries MUST have ItemKey before attachments can be uploaded. If legacy entries (itemKeyVersion=0) exist, they must be migrated to ItemKey first (out of scope for this plan — but upload should reject).
3. **AAD unchanged** — attachment AAD scope "AT" with `(entryId, attachmentId)` remains the same. The encryption key changes but the AAD structure does not.
4. **Breaking change** — drop `encryptionMode=0` support entirely. API defaults to `encryptionMode=1`, rejects `0`.

### Files to Modify

| File | Change |
|------|--------|
| `src/lib/team-vault-context.tsx` | Add `getItemEncryptionKey(teamId, entryId)` function |
| `src/components/team/team-attachment-section.tsx` | Use ItemKey for encrypt/decrypt instead of TeamKey |
| `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts` | Default `encryptionMode=1`, reject `0`, validate entry has ItemKey |
| `src/app/api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/route.ts` | No change needed (returns stored encryptionMode) |
| Tests for above files | Update to reflect new encryption path |

## Implementation Steps

1. **Add `getItemEncryptionKey` to team-vault-context**
   - Accept ItemKey metadata as parameter (not re-fetched from API): `{ encryptedItemKey, itemKeyIv, itemKeyAuthTag, itemKeyVersion, teamKeyVersion }` — parent component already has this from entry fetch
   - Unwrap ItemKey using TeamKey via `unwrapItemKey()`
   - Derive encryption key via `deriveItemEncryptionKey()`
   - Cache derived key in separate `Map<string, Map<string, CachedItemKey>>` (outer: teamId, inner: entryId)
   - **Cache invalidation**: In `invalidateTeamKey(teamId)`, also delete the entire outer Map entry for that teamId, clearing all ItemKey caches for the team. In `clearAll()`, also clear the entire ItemKey cache Map (vault lock must clear all key material)
   - Internally call `getTeamEncryptionKey(teamId)` to get the TeamKey, then build `buildItemKeyWrapAAD(teamId, entryId, itemKeyData.teamKeyVersion)` for unwrap AAD — note: `teamKeyVersion` in itemKeyData is the version used when the ItemKey was wrapped, not necessarily the current team version
   - On unwrap failure, throw a descriptive error (not silent `null`) so the caller can show a meaningful message
   - Return `CryptoKey` (throws on failure)

2. **Update `team-attachment-section.tsx` upload flow**
   - Accept ItemKey metadata via props (from parent entry detail component): `itemKeyData: { encryptedItemKey, itemKeyIv, itemKeyAuthTag, itemKeyVersion, teamKeyVersion }`
   - Replace `getTeamKeyInfo()` with `getItemEncryptionKey(teamId, entryId, itemKeyData)`
   - Use returned ItemKey-derived `CryptoKey` for `encryptBinary(arrayBuffer, itemKey, aad)` — AAD from `buildAttachmentAAD(entryId, attachmentId)` MUST be passed
   - Append `encryptionMode=1` to FormData (required by API — missing field returns 400)
   - On error (entry has no ItemKey or unwrap failure), show toast with clear guidance

3. **Update `team-attachment-section.tsx` download flow**
   - Replace `getTeamEncryptionKey()` with `getItemEncryptionKey(teamId, entryId, itemKeyData)`
   - Use returned ItemKey-derived `CryptoKey` for `decryptBinary({ ciphertext, iv, authTag }, itemKey, aad)` — AAD from `buildAttachmentAAD(entryId, attachmentId)` MUST be passed
   - **Guard**: Check `data.encryptionMode` in download response. If `encryptionMode === 0`, show explicit error "This attachment uses legacy encryption. Please re-upload." instead of attempting decrypt

4. **Update API POST handler for attachments**
   - Make `encryptionMode` a required field (return 400 if missing — no default value)
   - Reject requests with `encryptionMode !== 1` (return 400)
   - Add `itemKeyVersion` to the `select` clause when fetching the parent `TeamPasswordEntry`
   - Validate that the parent `TeamPasswordEntry` has `itemKeyVersion >= 1` (treat `undefined` as `0`)
   - If `itemKeyVersion < 1`, return 400 with clear error message
   - **teamKeyVersion check**: Keep for encryptionMode=1 — it validates the client is using the current TeamKey to unwrap ItemKey. This prevents uploads with a stale TeamKey version.

5. **Update/add tests**
   - Update existing attachment upload tests to include `encryptionMode=1` in FormData
   - Assert DB record has `encryptionMode: 1` after successful upload
   - Add test: reject `encryptionMode=0` (400)
   - Add test: reject missing `encryptionMode` (400)
   - Add test: reject upload when entry has `itemKeyVersion=0` (400)
   - Add test: reject upload when entry has `itemKeyVersion=undefined` (400)
   - Add test: success when entry has `itemKeyVersion=1`
   - Add test: ItemKey cache is invalidated after `invalidateTeamKey()` call
   - Update download test fixture to include `encryptionMode: 1`
   - Assert download response includes `encryptionMode` field

6. **Run mandatory checks**
   - `npx vitest run` — all tests pass
   - `npx next build` — production build succeeds

## Testing Strategy

1. **Unit tests**: Verify `getItemEncryptionKey` correctly unwraps and derives key
2. **API route tests**: Verify POST rejects encryptionMode=0, rejects entries without ItemKey
3. **Integration**: Verify upload → download roundtrip with ItemKey encryption
4. **Regression**: Ensure entry blob/overview encryption is unaffected
5. **Build verification**: `npx next build` to catch SSR/bundling issues

## Considerations & Constraints

1. **Legacy entries (itemKeyVersion=0)**: Attachment upload is blocked until the entry is migrated to ItemKey. This is acceptable since ItemKey migration for entries is already implemented.
2. **Existing attachments**: Since this is a breaking change in development, existing encryptionMode=0 attachments become unreadable. This is acceptable — the user confirmed breaking changes are OK.
3. **Performance**: ItemKey unwrap adds one AES-GCM decrypt + one HKDF derive per attachment operation. Caching the derived key per entry mitigates this.
4. **Server-side validation scope**: The server stores client-encrypted ciphertext opaquely. Server-side decryption verification is not performed (server never has ItemKey). Integrity is ensured by AES-GCM authTag + AAD binding at decrypt time on the client.
5. **HKDF info string**: Uses `"passwd-sso-item-enc-v1"` (already versioned in the string). Future algorithm changes would use a new info string; `itemKeyVersion` tracks this at the entry level.
6. **Out of scope**: Batch migration of existing attachments, UI for entry ItemKey migration.
