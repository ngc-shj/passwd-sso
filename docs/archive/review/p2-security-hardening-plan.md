# Plan: p2-security-hardening

## Objective

Implement the 5 P2 items from the external security assessment roadmap:
- #8: Attachment key hierarchy (ItemKey)
- #9: Error tracking (Sentry)
- #10: Argon2id migration path
- #11: Threat model publication
- #12: Cryptography whitepaper

No existing data migration required — changes apply to new data only.

## Requirements

### Functional

1. **ItemKey hierarchy**: Each TeamPasswordEntry gets a per-entry ItemKey. TeamKey wraps ItemKey (with AAD binding teamId+entryId+keyVersion); ItemKey encrypts entry data and attachments. Key rotation rewraps ItemKey only.
2. **Error tracking**: Integrate Sentry for API route errors and client-side error reporting. Scrub sensitive data (passwords, keys, tokens, encrypted fields).
3. **Argon2id**: New vault setups use Argon2id (WASM). Existing PBKDF2 users continue working. KDF params from P0 (`kdfType`, `kdfIterations`, `kdfMemory`, `kdfParallelism`) are already in DB.
4. **Threat model**: Publish STRIDE-based threat model document.
5. **Cryptography whitepaper**: Publish crypto architecture document referencing the existing crypto-domain-ledger.

### Non-functional

- All existing tests must pass
- No breaking changes to existing encrypted data
- Sentry must not leak plaintext passwords or crypto keys
- Argon2id fallback to PBKDF2 must notify the user explicitly

## Technical Approach

### #8: ItemKey Hierarchy

Current: `TeamKey → Entry Data / Attachment Data`
Target:  `TeamKey → ItemKey (per entry) → Entry Data / Attachment Data`

Schema changes to `TeamPasswordEntry`:
- Add `encryptedItemKey` (nullable), `itemKeyIv` (nullable), `itemKeyAuthTag` (nullable) columns
- Add `itemKeyVersion` column (default 0 = no ItemKey, 1 = ItemKey present)
- All new columns are nullable/have defaults — no migration needed for existing rows

Schema changes to `TeamPasswordEntryHistory`:
- Add same ItemKey columns (`encryptedItemKey`, `itemKeyIv`, `itemKeyAuthTag`, `itemKeyVersion`) — required to restore history entries encrypted with ItemKey

Schema changes to `Attachment`:
- Add `encryptionMode` column (default 0 = TeamKey direct, 1 = ItemKey) to distinguish legacy vs new encryption

AAD binding for ItemKey wrapping:
- Add `buildItemKeyWrapAAD(teamId, entryId, teamKeyVersion)` to `crypto-aad.ts` with scope `"IK"`
- Prevents cross-entry transplant attack (swapping encrypted ItemKey blobs between entries)
- Include `itemKeyVersion` in AAD for entry data encryption to prevent version mismatch silent corruption

Client-side flow (new entries):
1. Generate random 256-bit ItemKey
2. Encrypt entry blob/overview with ItemKey (via HKDF domain "passwd-sso-item-enc-v1"), include `itemKeyVersion` in AAD
3. Wrap ItemKey with TeamKey (AES-GCM) using `buildItemKeyWrapAAD`
4. Store wrapped ItemKey + encrypted data

Client-side flow (decryption):
1. Unwrap ItemKey with TeamKey (verify AAD)
2. Derive entry encryption key from ItemKey via HKDF
3. Decrypt entry data (verify AAD including itemKeyVersion)
4. On AAD/version mismatch: fail explicitly, never fall back to alternate decryption path

Key rotation:
- For entries with `itemKeyVersion >= 1`: only rewrap ItemKey with new TeamKey (attachments with `encryptionMode=1` need no change)
- For entries with `itemKeyVersion = 0` (legacy): full re-encrypt as before (attachments with `encryptionMode=0` also re-encrypt)

Rotation API schema changes:
- Each entry in `entries` array gets `itemKeyVersion` field
- `itemKeyVersion >= 1`: requires `rewrappedItemKey`, `itemKeyIv`, `itemKeyAuthTag`; `encryptedBlob`/`encryptedOverview` optional
- `itemKeyVersion = 0`: requires `encryptedBlob`, `encryptedOverview` as before

Affected files:
- `prisma/schema.prisma` — add ItemKey fields to TeamPasswordEntry + TeamPasswordEntryHistory + Attachment
- `src/lib/crypto-team.ts` — add ItemKey generate/wrap/unwrap functions
- `src/lib/crypto-aad.ts` — add `buildItemKeyWrapAAD` with scope `"IK"`
- `docs/security/crypto-domain-ledger.md` — register `passwd-sso-item-enc-v1`
- `src/app/api/teams/[teamId]/passwords/route.ts` — create flow
- `src/app/api/teams/[teamId]/passwords/[id]/route.ts` — read/update flow
- `src/app/api/teams/[teamId]/rotate-key/route.ts` — optimized rotation with new schema
- `src/components/team-password-*.tsx` — client encrypt/decrypt with ItemKey
- Attachment routes — encrypt with ItemKey, set `encryptionMode=1`

### #9: Error Tracking (Sentry)

- Install `@sentry/nextjs`
- Configure via `instrumentation.ts` (server) and `sentry.client.config.ts`
- Add `NEXT_PUBLIC_SENTRY_DSN` and `SENTRY_DSN` env vars
- Default: disabled (no DSN = no Sentry)
- Scrubbing: implement `beforeSend` hook as an exported testable utility that recursively strips keys matching sensitive patterns (substring match): `password`, `passphrase`, `secret`, `key`, `token`, `auth`, `mnemonic`, `seed`, `private`, `pepper`, `verifier`, `blob`, `ciphertext`, `encrypted` — from event data, breadcrumbs, and request bodies
- Source maps upload via CI (optional, behind `SENTRY_AUTH_TOKEN`)

### #10: Argon2id Migration

P0 already added KDF metadata columns. Now implement actual Argon2id:

- Add `argon2-browser` (WASM) dependency for web client
- In `crypto-client.ts`, extend `KdfParams` interface: add `kdfMemory?: number`, `kdfParallelism?: number`
- Extend `deriveWrappingKeyWithParams()`:
  - `kdfType=0`: PBKDF2 (existing)
  - `kdfType=1`: Argon2id (new)
- Default KDF for new vault setup: Argon2id (`kdfType=1`, memory=64MB, parallelism=4, iterations=3)
- Fallback: if WASM is unavailable, fall back to PBKDF2 and save `kdfType=0` — **display explicit UI notification** to user explaining fallback
- Low-end device consideration: detect available memory and reduce to 32MB if needed
- CSP update: add `'wasm-unsafe-eval'` to `script-src` in `proxy.ts` (required for WebAssembly in Chrome 95+; does not enable JS eval)
- `/api/vault/setup`: update Zod schema to accept `kdfType: 0 | 1`, require `kdfMemory`+`kdfParallelism` when `kdfType=1`; save all KDF params to user record
- `/api/vault/unlock/data`: return `kdfMemory` and `kdfParallelism` in response alongside `kdfType` and `kdfIterations`
- Extension: add Argon2id support (WASM) + update manifest CSP with `'wasm-unsafe-eval'`
- CLI: add Argon2id support (`argon2` npm native binding)

### #11: Threat Model (STRIDE)

Create `docs/security/threat-model.md`:
- Asset inventory (vault data, keys, sessions, tokens)
- Trust boundaries (client ↔ server, server ↔ DB, extension ↔ app)
- STRIDE per component (Spoofing, Tampering, Repudiation, Information Disclosure, DoS, Elevation)
- Mitigations mapping to existing controls
- Residual risks

### #12: Cryptography Whitepaper

Create `docs/security/cryptography-whitepaper.md`:
- Key hierarchy diagram (passphrase → wrappingKey → secretKey → encryptionKey)
- Team key hierarchy (TeamKey → ItemKey → entry data)
- KDF specification (PBKDF2, Argon2id params)
- Domain separation (reference crypto-domain-ledger.md)
- Emergency access crypto (ECDH-P256)
- Threat analysis (what-if scenarios)

## Implementation Steps

### Phase A: Documentation (#11, #12)

1. Create `docs/security/threat-model.md` with STRIDE analysis
2. Create `docs/security/cryptography-whitepaper.md` with full crypto architecture

### Phase B: ItemKey Hierarchy (#8)

3. Add ItemKey columns to `TeamPasswordEntry` and `TeamPasswordEntryHistory` in schema.prisma; add `encryptionMode` to `Attachment`
4. Create Prisma migration
5. Register `passwd-sso-item-enc-v1` in `docs/security/crypto-domain-ledger.md`; also register AAD scope `"IK"` in the AAD Scopes table with fields: teamId, entryId, teamKeyVersion
6. Add `buildItemKeyWrapAAD(teamId, entryId, teamKeyVersion)` to `src/lib/crypto-aad.ts` with scope `"IK"` — export `buildAADBytes` and reuse it to avoid code duplication; also update `buildTeamEntryAAD` (OV scope) to include `itemKeyVersion` field for version mismatch detection
7. Add ItemKey crypto functions to `src/lib/crypto-team.ts` (generateItemKey, wrapItemKey, unwrapItemKey, deriveItemEncryptionKey) — all using AAD
8. Update team password create API to generate and store ItemKey
9. Update team password read/update API to use ItemKey for decrypt/encrypt (fail explicitly on AAD/version mismatch)
10. Update team key rotation API: use Zod discriminated union on `itemKeyVersion` — v0 requires `encryptedBlob`+`encryptedOverview`, v1 requires `rewrappedItemKey`+`itemKeyIv`+`itemKeyAuthTag` with optional blob/overview; update `prisma.teamPasswordEntry.updateMany` data to include ItemKey fields for v1 entries
11. Update attachment encrypt/decrypt to use ItemKey, set `encryptionMode=1` for new attachments; handle `encryptionMode=0` legacy attachments during rotation
12. Update client components to handle ItemKey flow
13. Update history creation to copy ItemKey fields
14. Add unit tests for ItemKey crypto functions (including AAD verification)
15. Add API integration tests for ItemKey create/read/rotate flows (including mixed v0/v1 rotation)

### Phase C: Argon2id (#10)

16. Add `'wasm-unsafe-eval'` to CSP `script-src` in `proxy.ts`; update extension manifest CSP
17. Install `argon2-browser` (web), `argon2` (CLI)
18. Extend `KdfParams` interface with `kdfMemory`, `kdfParallelism`; extend `deriveWrappingKeyWithParams()` for kdfType=1
19. Update existing `kdfType: 1` rejection test → Argon2id success test; add `kdfType: 2` rejection test
20. Update `/api/vault/setup` Zod schema to accept kdfType 0|1 with conditional memory/parallelism; update `prisma.user.update` data to include `kdfMemory` and `kdfParallelism`
21. Update `/api/vault/unlock/data`: add `kdfMemory` and `kdfParallelism` to Prisma `select` and JSON response; return null as-is for PBKDF2 users (client ignores memory/parallelism when kdfType=0)
22. Update vault setup UI to use Argon2id by default; add fallback notification UI
23. Update extension crypto to support Argon2id
24. Update CLI crypto to support Argon2id (native binding)
25. Add tests for Argon2id key derivation (round-trip, param validation, WASM unavailability fallback)

### Phase D: Error Tracking (#9)

26. Install `@sentry/nextjs`
27. Configure instrumentation.ts and sentry.client.config.ts
28. Implement sensitive data scrubbing as exported testable utility; add `encrypted` to pattern list
29. Add SENTRY_DSN to env example files
30. Add automated unit tests for scrubbing (top-level, nested, breadcrumbs, request.data, arrays, non-sensitive preservation)

## Testing Strategy

- Unit tests for all new crypto functions (ItemKey with AAD, Argon2id)
- API integration tests for ItemKey create/read/rotate (including mixed v0/v1, attachment rotation)
- History creation/restoration test with ItemKey
- Sentry scrubbing automated unit tests (not manual-only)
- Existing test suite must pass (3725+ tests)
- crypto-client.test.ts: Argon2id round-trip test, kdfType validation tests
- CSP WASM compatibility verification
- Fallback notification UI verification

## Considerations & Constraints

- No data migration: `itemKeyVersion=0` entries continue to work with direct TeamKey encryption
- Argon2id WASM: ~300KB bundle size increase for web client
- CSP requires `'wasm-unsafe-eval'` for WASM in production (safe — does not enable JS eval)
- Sentry is opt-in (no DSN = disabled) — no privacy impact if not configured
- Extension needs `argon2-browser` bundled; verify CRXJS compatibility; update manifest CSP
- CLI uses native `argon2` package for better performance
- Threat model and whitepaper are documentation-only — no code changes
- ItemKey wrapping always uses AAD to prevent transplant attacks
- Entry data decryption never falls back on version mismatch — fail explicitly
- Attachment `encryptionMode` field distinguishes legacy (TeamKey) vs new (ItemKey) encryption
