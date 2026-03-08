# Plan: ext-team-entries

## Objective

Add two improvements to the browser extension popup:
1. Filter out entries with no actionable operations (SECURE_NOTE etc.)
2. Display team password entries alongside personal entries

## Requirements

### Functional

- F1: Entries whose `entryType` is not LOGIN, CREDIT_CARD, or IDENTITY are hidden from the popup
- F2: Team password entries are fetched, decrypted, and displayed in the popup
- F3: Team entries show a team name badge to distinguish from personal entries
- F4: COPY_PASSWORD works for team entries (using team API endpoint)
- F5: AUTOFILL works for team entries (using team API endpoint)
- F6: COPY_TOTP works for team entries
- F7: URL matching and search work with both personal and team entries
- F8: Team entries with `deletedAt` or `isArchived` are excluded
- F9: If team key is not yet distributed (403), that team's entries are silently skipped

### Non-functional

- NF1: Team keys are cached in memory (TTL 5 min, max 50 entries, keyed by `teamId:keyVersion`) to avoid repeated ECDH operations
- NF2: Team entries are fetched with Promise.allSettled, max 10 teams (truncate if more)
- NF3: ECDH private key bytes are zero-cleared on vault lock
- NF4: Failure to load team entries does not block personal entries from displaying
- NF5: Individual team entry decryption failures are silently skipped (do not abort the batch)
- NF6: On decryption failure, invalidate team key cache entry and retry once before skipping

## Technical approach

### Enable Team API for Extension Tokens

Team API endpoints (`/api/teams`, `/api/teams/[teamId]/passwords`, `/api/teams/[teamId]/member-key`, `/api/teams/[teamId]/passwords/[id]`) currently use `auth()` (session-only). They must be changed to `authOrToken()` to accept extension Bearer tokens.

Additionally, add `teams:read` scope to `EXTENSION_TOKEN_SCOPE` in `src/lib/extension-token.ts`. The `requireTeamMember` / `requireTeamPermission` checks remain server-side and apply regardless of auth method.

### ECDH Key Availability

Currently, `/api/vault/unlock/data` excludes ECDH fields when the caller uses an extension token. This exclusion must be removed so the extension can unwrap the ECDH private key needed for team key derivation.

Flow after change:
1. Extension calls `/api/vault/unlock/data` → now includes `encryptedEcdhPrivateKey`, `ecdhPrivateKeyIv`, `ecdhPrivateKeyAuthTag`
2. Extension derives `ecdhWrappingKey = HKDF(secretKey, info="passwd-sso-ecdh-v1")`
3. Extension unwraps ECDH private key bytes using AES-256-GCM
4. Stored in memory as `ecdhPrivateKeyBytes: Uint8Array | null`

### Team Key Unwrapping (port from crypto-team.ts)

New file: `extension/src/lib/crypto-team.ts`

Functions to port:
- `deriveEcdhWrappingKey(secretKey)` — HKDF with info="passwd-sso-ecdh-v1"
- `deriveTeamWrappingKey(privateKey, publicKey, salt)` — ECDH + HKDF
- `unwrapTeamKey(encrypted, ephemeralPublicKeyJwk, memberPrivateKey, hkdfSalt, ctx)` — full unwrap
- `deriveTeamEncryptionKey(teamKeyBytes)` — HKDF with info="passwd-sso-team-enc-v1"
- `buildTeamKeyWrapAAD(ctx)` — binary AAD builder
- `unwrapItemKey(encrypted, teamEncryptionKey, aad)` — per-entry key unwrap
- `deriveItemEncryptionKey(itemKey)` — HKDF with info="passwd-sso-item-enc-v1"

### Team Entry AAD (port from crypto-aad.ts)

Add to `extension/src/lib/crypto-team.ts`:
- `buildTeamEntryAAD(teamId, entryId, vaultType, itemKeyVersion)` — binary AAD with scope "OV"
- `buildItemKeyWrapAAD(teamId, entryId, teamKeyVersion)` — binary AAD with scope "IK"

### Data Model Changes

```typescript
// Extended DecryptedEntry
interface DecryptedEntry {
  id: string;
  title: string;
  username: string;
  urlHost: string;
  entryType: string;
  teamId?: string;      // NEW: present for team entries
  teamName?: string;    // NEW: present for team entries
}

// Team API response format (flat fields, different from personal API)
type RawTeamEntry = {
  id: string;
  entryType: string;
  encryptedOverview: string;   // hex-encoded ciphertext (NOT nested object)
  overviewIv: string;          // hex-encoded IV
  overviewAuthTag: string;     // hex-encoded auth tag
  aadVersion?: number;
  teamKeyVersion: number;
  itemKeyVersion?: number;
  encryptedItemKey?: string;
  itemKeyIv?: string;
  itemKeyAuthTag?: string;
  deletedAt?: string | null;
  isArchived?: boolean;
};
```

### Background Service Worker Changes

New global state:
```typescript
let ecdhPrivateKeyBytes: Uint8Array | null = null;

// Team key cache: "teamId:keyVersion" → { key, cachedAt }
// Bounded to MAX_TEAM_KEY_CACHE = 50 entries (LRU eviction)
const teamKeyCache = new Map<string, { key: CryptoKey; cachedAt: number }>();
const TEAM_KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_TEAM_KEY_CACHE = 50;
```

New functions:
- `getTeamEncryptionKey(teamId, keyVersion?)` — fetch member-key (with ?keyVersion=N), unwrap, derive, cache with key `teamId:keyVersion`
- `decryptTeamOverviews(teamId, teamName, raw[])` — decrypt with team key + AAD, handling ItemKey hierarchy
- `fetchAllTeamEntries()` — fetch teams list (max 10), then entries per team with Promise.allSettled

Modified handlers:
- `UNLOCK_VAULT` — also unwrap ECDH private key
- `FETCH_PASSWORDS` — merge personal + team entries
- `COPY_PASSWORD` — use `teamId` from message, route to team API path, decrypt with team key + AAD
- `AUTOFILL` / `AUTOFILL_CREDIT_CARD` / `AUTOFILL_IDENTITY` — same team detection
- `COPY_TOTP` — same team detection
- `GET_MATCHES_FOR_URL` — include team entries in matching
- `clearVault()` — zero-clear ecdhPrivateKeyBytes, clear teamKeyCache

### Message Type Changes

Add optional `teamId?: string` to these message types:
- `COPY_PASSWORD`
- `AUTOFILL`
- `AUTOFILL_FROM_CONTENT`
- `AUTOFILL_CREDIT_CARD`
- `AUTOFILL_IDENTITY`
- `COPY_TOTP`

The popup passes `DecryptedEntry.teamId` in the message so the background knows which API path to use.

### API Paths

```typescript
// New paths in extension/src/lib/api-paths.ts
TEAMS: "/api/teams",
teamMemberKey: (teamId) => `/api/teams/${teamId}/member-key`,
teamPasswords: (teamId) => `/api/teams/${teamId}/passwords`,
teamPasswordById: (teamId, entryId) => `/api/teams/${teamId}/passwords/${entryId}`,
```

### Popup UI Changes

- Add team badge (purple) in MatchList.tsx entry rendering
- Filter entries: only show LOGIN, CREDIT_CARD, IDENTITY entry types
- No structural changes to search or URL matching logic (already works on `urlHost`)

## Implementation steps

1. **Filter non-actionable entries** — Add `entryType` filter in `decryptOverviews()` in `extension/src/background/index.ts`

2. **Enable team API for extension tokens** — Change team API endpoints from `auth()` to `authOrToken()`, add `teams:read` to extension token scope

3. **Remove ECDH exclusion for extension tokens** — Modify `/api/vault/unlock/data` route to always include ECDH fields

4. **Create `extension/src/lib/crypto-team.ts`** — Port team crypto functions from `src/lib/crypto-team.ts` and AAD builders from `src/lib/crypto-aad.ts`

5. **Add API paths** — Update `extension/src/lib/api-paths.ts` with team endpoints

6. **Update types** — Add `teamId?` and `teamName?` to `DecryptedEntry`, add `teamId?` to action messages, define `RawTeamEntry` type

7. **Implement ECDH key unwrapping in UNLOCK_VAULT** — Derive ecdhWrappingKey, unwrap ECDH private key, store in global

8. **Implement team key management** — `getTeamEncryptionKey(teamId, keyVersion?)` with cache (keyed by `teamId:keyVersion`), LRU eviction, zero-clear on lock

9. **Implement team entry fetching** — `fetchAllTeamEntries()`: GET /api/teams (max 10) → Promise.allSettled GET /api/teams/[id]/passwords → `decryptTeamOverviews()` with RawTeamEntry normalization

10. **Merge entries in FETCH_PASSWORDS** — Fetch personal + team in parallel, merge results

11. **Update COPY_PASSWORD for team entries** — Use `teamId` from message, fetch from team API, decrypt with team key + team AAD

12. **Update AUTOFILL handlers for team entries** — Same pattern as COPY_PASSWORD

13. **Update COPY_TOTP for team entries** — Same pattern

14. **Update GET_MATCHES_FOR_URL** — Include team entries in URL matching

15. **Update clearVault()** — Zero-clear ecdhPrivateKeyBytes (fill(0) then null), clear teamKeyCache

16. **Update popup MatchList.tsx** — Add team badge, pass `teamId` in action messages, filter non-actionable entry types

17. **Add i18n strings** — Team badge label in extension messages

18. **Write tests** — See testing strategy below

## Testing strategy

### crypto-team.ts (new file: `extension/src/__tests__/lib/crypto-team.test.ts`)

- **Round-trip tests using real Web Crypto API** (NOT mocked):
  - ECDH key pair generation → wrapTeamKey → unwrapTeamKey round-trip
  - wrapItemKey → unwrapItemKey round-trip
  - deriveTeamEncryptionKey produces consistent CryptoKey
  - deriveEcdhWrappingKey produces consistent CryptoKey
- **AAD builder tests**:
  - buildTeamEntryAAD binary output matches expected format
  - buildItemKeyWrapAAD binary output matches expected format
  - Cross-validation: output matches web app's crypto-aad.test.ts expected values

### Team entry handlers (new file: `extension/src/__tests__/background/team-entries.test.ts`)

- FETCH_PASSWORDS merges personal + team entries
- FETCH_PASSWORDS returns personal entries even when team fetch fails
- COPY_PASSWORD routes to team API when teamId is present
- AUTOFILL routes to team API when teamId is present
- COPY_TOTP routes to team API when teamId is present
- Team entries with deletedAt/isArchived are excluded

### Team key cache (in team-entries.test.ts)

- TTL expiry: cache hit within TTL, cache miss after TTL (use vi.useFakeTimers)
- LRU eviction: 51st entry evicts oldest
- clearVault() empties the cache
- keyVersion-aware cache key: different versions cached separately

### Entry type filtering (in existing background.test.ts or new file)

- decryptOverviews excludes SECURE_NOTE entries
- decryptOverviews includes LOGIN, CREDIT_CARD, IDENTITY

### clearVault security (in existing or new test)

- ecdhPrivateKeyBytes is fill(0) then set to null after clearVault()
- teamKeyCache is empty after clearVault()

### Popup tests (in existing MatchList.test.tsx)

- Team badge is rendered for entries with teamName
- Team badge is not rendered for personal entries
- SECURE_NOTE entries are not displayed (filtered out)
- teamId is passed in COPY_PASSWORD/AUTOFILL messages for team entries

### Server-side tests

- vault/unlock/data returns ECDH fields for extension tokens
- Team API endpoints accept extension Bearer tokens

## Considerations & constraints

- **ECDH key not available**: If user's vault was set up before team feature existed, `encryptedEcdhPrivateKey` may be null. Team features are silently unavailable in this case.
- **Extension token auth**: Team API endpoints must be changed from `auth()` to `authOrToken()`. New scope `teams:read` added to extension token.
- **Team API response format**: Team passwords API returns flat fields (`encryptedOverview` string + `overviewIv` + `overviewAuthTag`), NOT nested `{ ciphertext, iv, authTag }` like personal API. `decryptTeamOverviews()` must handle this format.
- **ItemKey support**: Team entries may use per-entry ItemKey (itemKeyVersion >= 1). The extension must handle both direct team-key encryption and ItemKey hierarchy.
- **Key distribution**: If a team member's key hasn't been distributed yet, `/api/teams/[teamId]/member-key` returns 403. This must be handled gracefully.
- **Key version cache**: Cache key is `teamId:keyVersion` to support key rotation. On decryption failure, cache entry is invalidated and one retry is attempted.
- **Performance**: Max 10 teams fetched. Promise.allSettled for graceful partial failure.
- **Cache bounds**: teamKeyCache is bounded to 50 entries. When full, oldest entry is evicted (LRU).
- **Decryption errors**: Individual entry decryption failures (corrupt ciphertext, AAD mismatch) are caught per-entry and silently skipped, never aborting the batch.
- **Secret key lifecycle**: `ecdhPrivateKeyBytes` zero-clear provides defense-in-depth but `currentVaultSecretKeyHex` persists in `chrome.storage.session` (same threat model as personal vault's `encryptionKey` re-derivation on service worker restart).
- **Out of scope**: Team entry creation/editing from extension, key distribution from extension, team management UI.
