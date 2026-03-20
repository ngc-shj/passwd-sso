# Plan: add-key-rotation-consumers

## Context

Three key rotation API endpoints exist without consumers (UI/CLI/script):
1. `/api/vault/rotate-key` — personal vault secret key rotation (API incomplete: no entry re-encryption)
2. `/api/teams/[teamId]/rotate-key` — team encryption key rotation (API complete)
3. `/api/admin/rotate-master-key` — server-side ShareLink master key rotation (API complete)

The vault rotate-key API only updates key metadata but doesn't accept re-encrypted entries. When secretKey changes, all entries must be re-encrypted — this is a design gap that must be fixed.

## Objective

Add consumers and fix the API gap so all three rotation endpoints are fully functional.

## Requirements

### Functional
1. **Vault rotate-key**: User can rotate their vault secretKey, which decrypts all entries/history with the old key and re-encrypts with the new key, atomically. ECDH private key must also be re-encrypted.
2. **Team rotate-key**: Team admin/owner can rotate the team encryption key via UI, re-encrypting all entries and distributing new member keys
3. **Admin rotate-master-key**: Operator can run `scripts/rotate-master-key.sh` to rotate the ShareLink master key

### Non-functional
- Atomic transactions for data integrity
- Progress indication for potentially long re-encryption operations
- Rate limiting preserved (3 req/15min for vault)
- i18n support (ja/en)
- Audit logging for all rotation operations

## Technical Approach

### Encryption Architecture Reference

```
passphrase → PBKDF2(600k) → wrappingKey → wraps secretKey
secretKey  → HKDF("passwd-sso-enc-v1") → encryptionKey (AES-256-GCM)
secretKey  → HKDF("passwd-sso-auth-v1") → authKey → SHA-256 → authHash
secretKey  → HKDF("passwd-sso-ecdh-v1") → ecdhWrappingKey → wraps ecdhPrivateKey
```

Entries store: `encryptedBlob` + `encryptedOverview` (each with iv + authTag) + `keyVersion`
History stores: `encryptedBlob` only (with iv + authTag) + `keyVersion`

### 1. Admin rotate-master-key script

**File**: `scripts/rotate-master-key.sh`
**Pattern**: identical to `scripts/purge-history.sh`

Env vars:
- `ADMIN_API_TOKEN` (required)
- `OPERATOR_ID` (required) — valid user UUID
- `APP_URL` (default: `http://localhost:3000`)
- `TARGET_VERSION` (required) — must match `SHARE_MASTER_KEY_CURRENT_VERSION`
- `REVOKE_SHARES` (default: `false`)

Input validation: all env vars validated before API call. `TARGET_VERSION` must be a positive integer (`^[0-9]+$`). `OPERATOR_ID` must be UUID format (`^[0-9a-f]{8}-...$`).

### 2. Vault rotate-key API extension

**File**: `src/app/api/vault/rotate-key/route.ts`

Extend the existing Zod schema to accept re-encrypted entries and ECDH private key:

```ts
// Add to existing schema
entries: z.array(z.object({
  id: z.string().cuid(),      // PasswordEntry.id
  encryptedBlob: encryptedFieldSchema,
  encryptedOverview: encryptedFieldSchema,
  aadVersion: z.number().int().min(0).default(0),
})).max(VAULT_ROTATE_ENTRIES_MAX),

historyEntries: z.array(z.object({
  id: z.string().cuid(),      // PasswordEntryHistory.id (NOT entryId)
  encryptedBlob: encryptedFieldSchema,
  aadVersion: z.number().int().min(0).default(0),
})).max(VAULT_ROTATE_HISTORY_MAX),

// ECDH private key re-encrypted with new secretKey (flat fields matching existing setup/unlock pattern)
encryptedEcdhPrivateKey: z.string().min(1).max(512),  // P-256 PKCS8=138B → AES-GCM hex ciphertext ≈ 308 chars
ecdhPrivateKeyIv: hexIv,
ecdhPrivateKeyAuthTag: hexAuthTag,
```

**Transaction changes** — convert from sequential `prisma.$transaction([...])` to interactive transaction:
```ts
await prisma.$transaction(async (tx) => {
  // 1. Acquire advisory lock (prevents concurrent rotation/writes)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`vault_rotate:${userId}`}::text))`;

  // 2. Verify ALL user's entries (active + trash) match submitted entries (count + IDs)
  //    where: { userId } — direct field on PasswordEntry
  // 3. Verify ALL user's history records match submitted historyEntries (count + IDs)
  //    historyEntries[].id = PasswordEntryHistory.id
  //    NOTE: PasswordEntryHistory has NO userId field — use nested filter: { entry: { userId } }
  // 4. Batch update all entries with new encrypted data + new keyVersion
  // 5. Batch update all history records with new encrypted data + new keyVersion
  // 6. Update User: encryptedSecretKey, accountSalt, keyVersion, authHash,
  //    encryptedEcdhPrivateKey, ecdhPrivateKeyIv, ecdhPrivateKeyAuthTag
  // 7. Create VaultKey record (verificationArtifact)
  // 8. Mark EA grants STALE (OUTSIDE transaction, best-effort — markGrantsStaleForOwner uses prisma directly, not tx)
  // 9. Audit log: VAULT_KEY_ROTATION (requires adding to Prisma enum AuditAction + migration)
}, { timeout: 120_000 });
```

Constants (add to `src/lib/validations/common.ts`):
- `VAULT_ROTATE_ENTRIES_MAX = 5000`
- `VAULT_ROTATE_HISTORY_MAX = 10000`

### 2b. Vault rotate-key bulk data endpoint

**File**: `src/app/api/vault/rotate-key/data/route.ts` (new)

Read-only endpoint for rotation preparation. Returns all entries + history in a single response.

**Auth requirements** (route-handler auth, NOT middleware):
- Session auth via `auth()`
- RLS via `withUserTenantRls(session.user.id, ...)`
- Rate limiting: import shared `rotateLimiter` from `route.ts` (export it) or extract to shared module (3/15min)
- Response fields: minimal `select` — only `id`, encrypted fields, `keyVersion`, `aadVersion`

### 3. Vault rotate-key UI

**vault-context.tsx** — add `rotateKey(passphrase: string, onProgress?: (phase: string, current: number, total: number) => void)`:
0. Guard: if `!secretKeyRef.current || !accountSaltRef.current` → throw "Vault must be unlocked"
1. Compute `currentAuthHash` from current `secretKeyRef`
2. Fetch ALL entries + history via `GET /api/vault/rotate-key/data` (single request)
3. Generate new secretKey: `crypto.getRandomValues(new Uint8Array(32))`
4. Derive new encryptionKey via `deriveEncryptionKey(newSecretKey)`
5. Decrypt each entry with current `encryptionKey (useState)`, re-encrypt with new encryptionKey (report progress)
6. Decrypt each history record, re-encrypt (report progress)
7. Re-encrypt ECDH private key: use `ecdhPrivateKeyBytesRef.current` (already decrypted in memory), re-wrap with `deriveEcdhWrappingKey(newSecretKey)`
8. Wrap new secretKey with wrappingKey (derived from passphrase + new accountSalt)
9. Compute newAuthHash, create verificationArtifact
10. POST to `/api/vault/rotate-key` with everything (advisory lock acquired server-side)
11. Update local state/refs: `secretKeyRef`, `setEncryptionKey()` (useState setter), `keyVersionRef`, `accountSaltRef`, `wrappedKeyRef`, `ecdhPrivateKeyBytesRef` (note: `ecdhPublicKeyJwkRef` is unchanged — only the wrapping changes, not the key pair)

**Component**: `src/components/vault/rotate-key-dialog.tsx`
- Pattern: follow `ChangePassphraseDialog`
- Single passphrase input (confirm identity + unwrap key)
- Warning: "This will invalidate all Emergency Access grants"
- Warning: "This operation may take time depending on the number of entries"
- Progress indicator during re-encryption
- Disabled during processing

**Placement**: `src/app/[locale]/(protected)/dashboard/settings/page.tsx`
- Add to `security` tab, after PasskeyCredentialsCard
- Separator + RotateKeyDialog trigger button

### 4. Team rotate-key UI

**Component**: `src/components/teams/team-rotate-key-button.tsx`
- Team admin/owner only (uses `TEAM_PERMISSION.TEAM_UPDATE`)
- Confirmation dialog with warning about the operation
- Progress indicator
- Client-side flow:
  1. Fetch all team entries (active + trash) via `GET /api/teams/[teamId]/rotate-key/data` (new bulk fetch endpoint, symmetric with vault)
  2. Generate new team key
  3. For v0 entries: decrypt blob+overview with old team key → re-encrypt with new team key
  4. For v1+ entries: decrypt itemKey with old team key → re-encrypt itemKey with new team key
  5. Re-wrap new team key for each active member's public key
  6. POST to `/api/teams/[teamId]/rotate-key`

**New endpoint**: `GET /api/teams/[teamId]/rotate-key/data/route.ts`
- Auth: session + `requireTeamPermission(TEAM_UPDATE)` + RLS
- Returns all team entries (active + archived + trash) + member public keys

**Placement**: `src/app/[locale]/(protected)/dashboard/teams/[teamId]/settings/page.tsx`
- Add to `general` tab, in a "Danger Zone" section before team deletion
- Or add to `policy` tab as a security operation

### 5. i18n

Add keys to `messages/en.json` and `messages/ja.json`:

Vault rotation strings (Settings/Security namespace):
- Rotate key button label
- Dialog title, description, warnings
- Progress messages
- Success/error toasts

Team rotation strings (Teams namespace):
- Rotate key button label
- Confirmation dialog
- Progress messages
- Success/error toasts

### 6. CLAUDE.md update

Document `scripts/rotate-master-key.sh` in Common Commands section.

## Implementation Steps

1. Create `scripts/rotate-master-key.sh` with input validation (TARGET_VERSION numeric, OPERATOR_ID UUID format)
2. Add `VAULT_KEY_ROTATION` to Prisma `enum AuditAction` + `src/lib/constants/audit.ts` + run `db:migrate`
3. Add validation constants (`VAULT_ROTATE_ENTRIES_MAX`, etc.) to `src/lib/validations/common.ts`
4. Create `GET /api/vault/rotate-key/data/route.ts` — bulk fetch endpoint (auth + RLS + rate limit)
5. Extend `/api/vault/rotate-key/route.ts` AND update tests together (same commit):
   - Convert sequential transaction to interactive transaction
   - Update test mock: `mockTransaction.mockImplementation(async (fn) => fn(txMock))`
   - Add advisory lock at transaction start (`pg_advisory_xact_lock`)
   - Add entries/historyEntries/ECDH to schema
   - Add entry count + ID verification in transaction
   - Add batch update for entries + history
   - Add ECDH private key update
   - Add audit log (VAULT_KEY_ROTATION)
   - Mark EA grants STALE outside transaction (best-effort, same as current impl)
6. Add `rotateKey` function to `src/lib/vault-context.tsx` (with unlock guard + ECDH re-encryption)
7. Create `src/components/vault/rotate-key-dialog.tsx`
8. Add RotateKeyDialog to settings security tab
9. Create `GET /api/teams/[teamId]/rotate-key/data/route.ts` — team bulk fetch endpoint
10. Create `src/components/teams/team-rotate-key-button.tsx`
11. Add team rotate-key UI to team settings page
12. Add i18n keys (en.json, ja.json)
13. Update CLAUDE.md
14. (Merged with Step 5 — route implementation and test mock update must be in the same commit) Add tests for vault rotate-key route (extended schema):
    - Entry count mismatch → 400/409
    - Entries max exceeded (5001) → 400
    - Successful rotation with entries + history + ECDH update
    - Advisory lock assertion (`tx.$executeRaw` called)
15. Add tests for `GET /api/vault/rotate-key/data`:
    - 401 (unauthenticated)
    - 404 (vault not set up)
    - 200 (entries + history returned, scoped to userId via RLS)
    - 429 (rate limit)
16. Add vault-context `rotateKey` unit tests (renderHook + vi.mock fetchApi + Web Crypto stubs):
    - Success flow → refs updated (including wrappedKeyRef)
    - POST failure → refs NOT updated
    - Progress callback invocation order
17. Add `scripts/__tests__/rotate-master-key.test.mjs` — env var validation via `execFileSync` (invoke script with missing/invalid vars, assert exit code + stderr). curl calls are not unit-testable; tested manually.
18. Add team rotate-key data endpoint tests

## Testing Strategy

- **Route handler tests**: vault rotate-key — MUST convert existing mock to interactive TX pattern (`mockTransaction.mockImplementation(async (fn) => fn(txMock))` with txMock containing `$executeRaw`, model mocks). Test extended schema, entry/history verification (nested filter for history), advisory lock ($executeRaw assertion), ECDH, audit log.
- **Bulk data endpoint tests**: auth (401), RLS userId scope verification, rate limit (429), response shape (200)
- **vault-context unit tests**: `rotateKey` function via `renderHook` + `vi.mock("@/lib/crypto-client")` + `vi.mock` fetchApi. Test state transitions, error rollback, progress callbacks.
- **Component tests**: RotateKeyDialog, TeamRotateKeyButton (rendering, state transitions)
- **Script tests**: `scripts/__tests__/rotate-master-key.test.mjs` — env var validation only (missing vars, invalid format). curl/HTTP calls tested manually.
- **Integration**: `npx vitest run` + `npx next build`

## Considerations & Constraints

- **Payload size**: vault with 5000 entries × ~2KB per encrypted blob = ~10MB payload. App Router route handlers have no built-in bodyParser config (that's Pages Router only). Use reverse proxy (nginx `client_max_body_size`) or manual size check in route handler.
- **Transaction timeout**: use interactive transaction with 120s timeout (team uses 60s, vault may have more entries+history)
- **Concurrency lock**: use PostgreSQL advisory lock (`pg_advisory_xact_lock`) on userId/teamId hash at the START of the interactive transaction, before any reads
- **Bulk entry fetch**: `GET /api/vault/rotate-key/data` and `GET /api/teams/[teamId]/rotate-key/data` endpoints return all data in a single response (avoids N+1 fetches and pagination issues)
- **ECDH private key**: MUST be re-encrypted during vault rotation — secretKey change affects `deriveEcdhWrappingKey()`, breaking team E2E encryption otherwise
- **EA invalidation**: clearly warn user that Emergency Access grants become STALE
- **History re-encryption**: must re-encrypt history too, otherwise old history becomes unreadable after secretKey change
- **Rate limiting**: preserved at 3/15min — UI should show appropriate message on rate limit hit
- **Audit logging**: `AUDIT_ACTION.VAULT_KEY_ROTATION` for vault, `AUDIT_ACTION.TEAM_KEY_ROTATION` for team (team already has this)
- **aadVersion default**: use `z.number().int().min(0).default(0)` to handle legacy entries
- **ID validation**: use `z.string().cuid()` (NOT cuid2) to match existing codebase. All `where` clauses must scope by `userId`/`teamId`.
- **History userId scope**: `PasswordEntryHistory` has no direct `userId` field. Use nested Prisma filter `{ entry: { userId } }` for all history queries.
- **Prisma migration**: `VAULT_KEY_ROTATION` must be added to `enum AuditAction` in schema.prisma before implementation. Run `db:migrate`.
- **ECDH field max length**: `encryptedEcdhPrivateKey` capped at `.max(512)` — P-256 PKCS8 = 138 bytes → AES-GCM hex ciphertext ≈ 308 chars.

## Key Files to Modify

- `scripts/rotate-master-key.sh` (new)
- `prisma/schema.prisma` (add VAULT_KEY_ROTATION to enum AuditAction)
- `src/lib/constants/audit.ts` (add VAULT_KEY_ROTATION)
- `src/app/api/vault/rotate-key/data/route.ts` (new — bulk fetch for rotation)
- `src/app/api/vault/rotate-key/route.ts` (extend: interactive TX, advisory lock, entries, ECDH, audit)
- `src/app/api/teams/[teamId]/rotate-key/data/route.ts` (new — team bulk fetch)
- `src/lib/vault-context.tsx` (add rotateKey with ECDH)
- `src/components/vault/rotate-key-dialog.tsx` (new)
- `src/app/[locale]/(protected)/dashboard/settings/page.tsx` (add to security tab)
- `src/components/teams/team-rotate-key-button.tsx` (new)
- `src/app/[locale]/(protected)/dashboard/teams/[teamId]/settings/page.tsx` (add to general/policy tab)
- `src/lib/validations/common.ts` (add constants)
- `messages/en.json`, `messages/ja.json` (i18n)
- `CLAUDE.md` (document script)
- `scripts/__tests__/rotate-master-key.test.mjs` (new)
- Test files for new/extended routes and components

## Existing Code to Reuse

- `scripts/purge-history.sh` — template for rotate-master-key.sh
- `src/components/vault/change-passphrase-dialog.tsx` — UI pattern for rotate-key-dialog
- `src/lib/crypto-client.ts` — `generateSecretKey()`, `deriveEncryptionKey()`, `deriveEcdhWrappingKey()`, `encryptData()`, `decryptData()`, `wrapSecretKey()`, `createVerificationArtifact()`, `computeAuthHash()`
- `src/lib/validations/common.ts` — `encryptedFieldSchema`, `hexIv`, `hexAuthTag`, `z.string().cuid()`
- `src/app/api/teams/[teamId]/rotate-key/route.ts` — reference for entry re-encryption transaction pattern + advisory lock pattern
