# Plan: itemkey-client-generation

## Objective

Integrate client-side ItemKey generation into the team entry save flow so that new and updated entries use per-entry ItemKey encryption (itemKeyVersion=1). This enables attachment upload (which requires itemKeyVersion >= 1) and aligns blob/overview encryption with the two-level key hierarchy: TeamKey → wraps ItemKey → HKDF derives itemEncryptionKey → encrypts blob/overview/attachments.

## Requirements

### Functional

- F1: New team entries MUST be created with itemKeyVersion=1 and a wrapped ItemKey
- F2: Editing an entry with itemKeyVersion=0 MUST upgrade it to itemKeyVersion=1 (generate ItemKey, re-encrypt blob/overview with ItemKey-derived key)
- F3: Editing an entry with itemKeyVersion >= 1 MUST reuse the existing ItemKey for blob/overview re-encryption
- F4: All web app decrypt call sites MUST handle itemKeyVersion correctly (use ItemKey-derived key when >= 1, TeamKey when 0)
- F5: Password import MUST generate ItemKey for each imported team entry
- F6: Attachment upload MUST work after entry creation (no longer blocked by ITEM_KEY_REQUIRED)
- F7: Server MUST reject itemKeyVersion downgrade (v1→v0) on PUT to prevent cryptographic downgrade attacks
- F8: Entry history API MUST return ItemKey fields so history viewer can decrypt v1 entries

### Non-Functional

- NF1: Minimize raw ItemKey exposure by calling `.fill(0)` on Uint8Array after use (best-effort in JS runtime; documented limitation)
- NF2: Cache ItemKey-derived keys via existing TeamVaultContext mechanism (5-minute TTL, same as TeamKey cache)
- NF3: Backward compatible: entries with itemKeyVersion=0 continue to work (decrypt with TeamKey)
- NF4: Error handling: if ItemKey wrap/unwrap fails, propagate error to UI with toast — never save an entry with corrupted ItemKey data

## Technical Approach

### Key Architecture

```
TeamKey (per team, shared)
  └─ wraps → ItemKey (per entry, random 256-bit)
               └─ HKDF derives → itemEncryptionKey (AES-256-GCM)
                                   ├─ encrypts blob
                                   ├─ encrypts overview
                                   └─ encrypts attachments
```

### Encrypt Flow (Save)

1. Generate random ItemKey: `generateItemKey()` → 32 bytes
2. Derive encryption key: `deriveItemEncryptionKey(itemKey)` → CryptoKey
3. Encrypt blob/overview with ItemKey-derived key (NOT TeamKey directly)
4. Wrap ItemKey with TeamKey: `wrapItemKey(itemKey, teamEncKey, buildItemKeyWrapAAD(...))`
5. Zero-clear raw ItemKey bytes
6. Send to API: itemKeyVersion=1 + encryptedItemKey + encrypted blob/overview

### Decrypt Flow (Read)

1. Check entry's itemKeyVersion
2. If >= 1: unwrap ItemKey with TeamKey → derive encryption key → decrypt
3. If 0: use TeamKey directly (backward compatible)

### Existing Code That Already Handles ItemKey Decryption

- `src/hooks/use-watchtower.ts` — full ItemKey unwrap + derive + decrypt
- `extension/src/background/index.ts` — full ItemKey unwrap + derive + decrypt
- `src/lib/team-vault-core.tsx` (getItemEncryptionKey) — unwrap + derive + cache

### Web App Call Sites Needing Update (Currently Hardcoded itemKeyVersion=0)

- `src/components/team/team-trash-list.tsx`
- `src/components/team/team-archived-list.tsx`
- `src/app/[locale]/dashboard/teams/[teamId]/page.tsx`
- `src/components/team/team-edit-dialog-loader.tsx`
- `src/components/team/team-export.tsx`
- `src/components/passwords/entry-history-section.tsx`
- `src/components/passwords/password-import-importer.ts`

## Implementation Steps

### Step 1: Add `getEntryDecryptionKey` helper to TeamVaultContext

Add a method to `src/lib/team-vault-core.tsx` that accepts entry data directly (without API call) and returns the correct CryptoKey:

```typescript
getEntryDecryptionKey(
  teamId: string,
  entryId: string,
  entry: { itemKeyVersion?: number; encryptedItemKey?: string; itemKeyIv?: string; itemKeyAuthTag?: string; teamKeyVersion: number; }
): Promise<CryptoKey>
```

- If itemKeyVersion >= 1: unwrap ItemKey → derive → cache → return
- If itemKeyVersion 0 or undefined: return TeamKey (via getTeamEncryptionKey)

This avoids the extra API call that `getItemEncryptionKey` makes.

### Step 2: Modify `team-entry-save.ts`

Change the function signature to accept encryption key and ItemKey data:

```typescript
export async function saveTeamEntry({
  // existing params...
  encryptionKey,        // CryptoKey (either TeamKey or ItemKey-derived)
  teamKeyVersion,
  itemKeyVersion,       // new: 0 or 1
  encryptedItemKey?,    // new: only for create or v0→v1 upgrade
  // ...
})
```

Changes:
- Use `encryptionKey` (not `teamEncryptionKey`) for blob/overview encryption
- Pass `itemKeyVersion` to `buildTeamEntryAAD` calls
- Include `itemKeyVersion` and `encryptedItemKey` in request body
- Remove the `teamEncryptionKey` param (replaced by `encryptionKey`)
- Add client-side validation: throw if `itemKeyVersion >= 1 && !encryptedItemKey` (for create/upgrade only)

### Step 3: Update `team-entry-submit.ts` and `use-team-base-form-model.ts`

In `executeTeamEntrySubmit` or the calling code:

**Create mode:**
1. Generate entryId: `crypto.randomUUID()`
2. Generate ItemKey: `generateItemKey()`
3. Build AAD: `buildItemKeyWrapAAD(teamId, entryId, teamKeyVersion)`
4. Wrap ItemKey: `wrapItemKey(rawItemKey, teamEncryptionKey, aad)`
5. Derive encryption key: `deriveItemEncryptionKey(rawItemKey)`
6. Zero-clear rawItemKey
7. Pass encryptionKey + itemKeyVersion=1 + encryptedItemKey to saveTeamEntry

**Edit mode (itemKeyVersion >= 1):**
1. Use `getEntryDecryptionKey(teamId, editData.id, editData)` to get ItemKey-derived encryption key (no extra API call — uses editData already fetched by loader)
2. If `editData.teamKeyVersion !== current teamKeyVersion` (key rotation occurred): unwrap ItemKey with old TeamKey, re-wrap with new TeamKey and new AAD, send updated `encryptedItemKey`
3. Otherwise: pass encryptionKey + itemKeyVersion=editData.itemKeyVersion, don't send encryptedItemKey (keep existing in DB)

**Edit mode (itemKeyVersion 0):**
1. Same as create mode (upgrade to v1)
2. Use editData.id as entryId

### Step 4: Update all web app decrypt call sites

Replace pattern:
```typescript
const teamKey = await getTeamEncryptionKey(teamId);
const aad = buildTeamEntryAAD(teamId, entryId, vaultType);
const decrypted = await decryptData(encrypted, teamKey, aad);
```

With:
```typescript
const decryptKey = await getEntryDecryptionKey(teamId, entryId, entry);
const aad = buildTeamEntryAAD(teamId, entryId, vaultType, entry.itemKeyVersion ?? 0);
const decrypted = await decryptData(encrypted, decryptKey, aad);
```

Files (8):

- `src/components/team/team-trash-list.tsx`
- `src/components/team/team-archived-list.tsx` (2 call sites)
- `src/app/[locale]/dashboard/teams/[teamId]/page.tsx` (2 call sites)
- `src/components/team/team-edit-dialog-loader.tsx` (both blob decrypt AND editData propagation)
- `src/components/team/team-export.tsx`
- `src/components/passwords/entry-history-section.tsx`
- `src/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/route.ts` (add ItemKey fields to response)
- `src/app/api/teams/[teamId]/passwords/[id]/history/route.ts` (add `itemKeyVersion` to list response for consistency)

Note: `team-edit-dialog-loader.tsx` needs two changes: (1) use `getEntryDecryptionKey` for blob decryption with correct `itemKeyVersion` in AAD, (2) propagate `itemKeyVersion`, `teamKeyVersion`, and ItemKey encryption data (`encryptedItemKey`, `itemKeyIv`, `itemKeyAuthTag`) to `TeamEntryFormEditData`.

Note: `entry-history-section.tsx` must use each history record's own `itemKeyVersion` (not the current entry's) for `buildTeamEntryAAD`, since older history records may have been saved with itemKeyVersion=0 even if the current entry is now v1.

### Step 5: Update password import flow

In `src/components/passwords/password-import-importer.ts`:
- Generate ItemKey for each imported team entry
- Wrap with TeamKey
- Encrypt blob/overview with ItemKey-derived key
- Include itemKeyVersion=1 + encryptedItemKey in import request

### Step 5.5: Add server-side itemKeyVersion downgrade prevention

In `src/app/api/teams/[teamId]/passwords/[id]/route.ts` PUT handler:

- If `itemKeyVersion` is provided and is less than the existing entry's `itemKeyVersion`, return 400 with `ITEM_KEY_VERSION_DOWNGRADE`
- Add error code to `api-error-codes.ts` and i18n messages

### Step 6: Update `TeamEntryFormEditData` interface

Ensure edit data includes `itemKeyVersion`, `teamKeyVersion`, `encryptedItemKey`, `itemKeyIv`, `itemKeyAuthTag` so the edit flow knows whether to upgrade or reuse.

Update `team-edit-dialog-loader.tsx` to propagate `raw.itemKeyVersion`, `raw.teamKeyVersion`, and ItemKey encryption fields to `TeamEntryFormEditData`.

### Step 7: Tests

- Unit tests for `getEntryDecryptionKey` in `team-vault-core.test.tsx` (v0 fallback, v1 unwrap+derive, cache behavior)
- Create `team-entry-save.test.ts`: create v1 payload, edit v0→v1 upgrade, edit v>=1 reuse, correct key selection
- Add decrypt call site tests: `team-edit-dialog-loader.test.tsx` with v0 and v1 entries
- Add import tests: `password-import-importer.test.ts` — team import with `itemKeyVersion: 1` and `encryptedItemKey` in payload
- Add server-side test: PUT with itemKeyVersion downgrade returns 400
- Verify all existing tests pass with the new flow

## Testing Strategy

- All 3849+ existing tests must pass
- Production build must succeed
- New tests for `getEntryDecryptionKey`: itemKeyVersion=0, itemKeyVersion=1, cache behavior
- New tests for `saveTeamEntry`: v0/v1 key selection, payload construction, client-side validation
- New tests for decrypt call sites: v0/v1 branching in edit dialog loader
- New tests for import: team import with ItemKey generation
- New tests for server: itemKeyVersion downgrade prevention
- Manual verification: create team entry → upload attachment → download attachment

## Considerations & Constraints

- **Breaking change for existing entries**: Entries with itemKeyVersion=0 continue to work (decrypt only). New/edited entries use itemKeyVersion=1.
- **No migration script**: Existing entries are lazily upgraded when edited.
- **Extension already handles ItemKey**: No extension changes needed.
- **Key rotation**: Server-side rotate-key route already handles ItemKey re-wrapping (`src/app/api/teams/[teamId]/rotate-key/route.ts` already re-wraps ItemKey with new TeamKey).
- **Concurrent edit race condition**: Not a concern — the API uses database-level `updatedAt` optimistic locking for entry updates. Two concurrent edits both upgrading v0→v1 will result in one succeeding and the other getting a conflict error (standard edit conflict handling).
- **Attachment upload**: Already handled by the `itemkey-attachment-migration` branch — uses `getItemEncryptionKey()` from TeamVaultContext which fetches entry data from API. Once entries have itemKeyVersion=1, attachment upload works automatically.
- **Zero-clearing limitation**: JavaScript GC may retain copies of raw key bytes. `.fill(0)` is best-effort. This is a known limitation of Web Crypto in browser environments.
- **`buildTeamEntryAAD` signature**: Already accepts `itemKeyVersion` as an optional 4th parameter with default 0 — no signature change needed.
- **Retry behavior**: On save failure, always regenerate ItemKey and re-encrypt blob/overview from scratch. Never cache or reuse a failed ItemKey — each `submitEntry` invocation performs the full generate→wrap→encrypt pipeline independently.
- **Key rotation + edit**: If `teamKeyVersion` changed since entry was last saved, the edit flow must re-wrap ItemKey with the new TeamKey (unwrap with old → re-wrap with new AAD). In practice, the rotate-key endpoint already atomically re-wraps all ItemKeys with the new TeamKey, so by the time any client edits, ItemKeys are already wrapped with the current TeamKey. The stale-cache scenario (client has old teamKeyVersion) is handled by the server's 409 `TEAM_KEY_VERSION_MISMATCH` — on 409, the client must clear cached keys, refetch, and retry.
- **POST endpoint itemKeyVersion enforcement**: The plan mandates all new entries use itemKeyVersion=1 (F1), but the server POST endpoint still accepts itemKeyVersion=0 for backward compatibility with older clients. Once all clients are updated, consider adding server-side enforcement (MIN_ITEM_KEY_VERSION=1 on POST). For now, client-side enforcement is sufficient.
- **Out of scope**: Using ItemKey for entry history re-encryption (already handled by existing history route).
