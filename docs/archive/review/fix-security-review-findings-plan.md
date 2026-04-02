# Plan: fix-security-review-findings

## Objective

Address confirmed findings from the external security review of passwd-sso. Focus on the three actionable items that represent real security gaps.

## Requirements

### Functional
- Block new `aadVersion: 0` entries from being written (FUNC-1)
- Zero secret key bytes after IPC transfer in decrypt agent (SEC-3)
- Document HKDF zero-salt design decision with risk acceptance rationale (SEC-1)

### Non-functional
- No breaking changes to existing read paths (aadVersion: 0 entries must still decrypt)
- All existing tests must pass
- Production build must succeed

## Technical Approach

### FUNC-1: Block aadVersion:0 Writes

The write path currently allows `aadVersion: 0` when `userId` is undefined. Since `userId` is always available in authenticated contexts, this is a defensive measure.

**Files to modify:**
1. `src/lib/personal-entry-save.ts` — Throw error if `userId` is not provided (it's always available from session)
2. `src/app/api/passwords/[id]/attachments/route.ts` — Default `aadVersion` to `AAD_VERSION` (1) instead of 0, matching team attachments pattern
3. `src/components/passwords/password-import-importer.ts` — Same pattern: throw if no userId

**Read paths are NOT changed** — `aadVersion >= 1` checks in decrypt logic remain to support existing entries.

### SEC-3: Zero secretBytes After IPC Send

**Files to modify:**
1. `cli/src/commands/agent-decrypt.ts` — Add `secretBytes.fill(0)` after hex encoding in `forkDaemon()`, and after key derivation in `runDaemonChild()`
2. `cli/src/lib/vault-state.ts` — Add `clearSecretKeyBytes()` export that zeros and nulls the stored bytes

### SEC-1: HKDF Zero-Salt Documentation

**Files to modify:**
1. `src/lib/crypto-client.ts` — Expand comment on HKDF salt with risk acceptance rationale
2. `cli/src/lib/crypto.ts` — Same comment expansion
3. `extension/src/lib/crypto.ts` — Same comment expansion

## Implementation Steps

1. **FUNC-1a**: Make `userId` required in `savePersonalEntry` — change from `userId?: string` to `userId: string`
2. **FUNC-1b**: Update `personal-entry-submit.ts` interface to match (userId already flows from session)
3. **FUNC-1c**: Fix attachment route to default `aadVersion` to `AAD_VERSION` instead of 0
4. **FUNC-1d**: Fix import importer to throw if `userId` is missing
5. **SEC-3a**: In `forkDaemon()`, zero `secretBytes` immediately after `hexEncode()`
6. **SEC-3b**: In `runDaemonChild()`, zero `secretBytes` after `deriveEncryptionKey()`
7. **SEC-1**: Expand HKDF salt comments in all 3 crypto files
8. Run tests + build

## Testing Strategy

- Existing crypto tests cover decrypt paths (no changes needed there)
- `personal-entry-save.test.ts` may need update if `userId` becomes required
- Run full test suite + production build

## Considerations & Constraints

- **No migration script** for existing aadVersion:0 entries in this PR — that's a separate, larger effort requiring re-encryption of affected entries
- **Read path backward compatibility** is preserved — the `aadVersion >= 1` check remains
- **Node.js memory limitations**: `secretHex` string cannot be reliably zeroed in V8 (strings are immutable). We zero the `Uint8Array` source as best effort
- **No breaking API changes**: attachment upload clients that omit `aadVersion` now get version 1 instead of 0 (improvement, not breakage)
