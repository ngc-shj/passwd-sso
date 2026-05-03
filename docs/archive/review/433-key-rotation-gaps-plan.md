# Plan: Key Rotation Gaps (#433)

**Revision**: Round 4 (revised after Round 3 expert review). All Critical+Major findings through Round 3 incorporated.

## Project Context

- **Type**: web app (Next.js 16 + Prisma 7 + PostgreSQL 16, end-to-end client-side crypto)
- **Test infrastructure**: unit + integration + E2E (Playwright) + CI/CD (.github/workflows)
- **Branch**: `feature/433-key-rotation-gaps`
- **Linked issue**: https://github.com/ngc-shj/passwd-sso/issues/433
- **Review log**: `./433-key-rotation-gaps-review.md`

## Objective

Close the four rotation-coverage gaps identified in #433 so that personal vault key rotation removes the previous `secretKey` from the trust boundary across all entry types that wrap or are encrypted by it.

## Background — Rotation flow today

`POST /api/vault/rotate-key` ([src/app/api/vault/rotate-key/route.ts](../../src/app/api/vault/rotate-key/route.ts)) currently:

1. Verifies the current passphrase (constant-time compare)
2. Acquires `pg_advisory_xact_lock(hashtext(userId))`
3. Validates the submitted `entries[]` set is exactly all of the user's `PasswordEntry` rows
4. Validates `historyEntries[]` is exactly all `PasswordEntryHistory` for those entries
5. Updates entry/history rows + bumps `keyVersion`
6. Re-wraps `User.encryptedSecretKey`, ECDH private key, etc.
7. Inserts a `VaultKey` row (verification artifact)
8. **Outside transaction (best-effort)**: `markGrantsStaleForOwner`, `revokeAllDelegationSessions`, audit `VAULT_KEY_ROTATION`

Untouched today and the consequence:

| Consumer | Stored data | Effect after rotation |
|---|---|---|
| `User.recovery*` | wraps **old** secretKey | Recovery flow returns old secretKey → user "recovers" into a vault that cannot decrypt anything |
| `EmergencyAccessGrant.encryptedSecretKey` (IDLE/ACTIVATED + **REQUESTED**) | wraps **old** secretKey via grantee ECDH | Grantee can recover old secretKey → with old ciphertext backups, plaintext recovery possible |
| `WebAuthnCredential.prfEncryptedSecretKey` | wraps **old** secretKey via PRF KEK | Vault auto-unlock via passkey returns old secretKey → silent broken state |
| `Attachment.encryptedData` (personal entries) | content encrypted with **old** key directly | Attachments become **unreadable** after rotation. **Silent data loss.** |

The first three share a shape: server stores `wrap(oldSecretKey)`. The cleanest remediation is to **disable decryption** of the wrapping (clear or partially clear the wrapping fields, depending on forensic-trail trade-offs). The fourth (Attachment) cannot be cleared without losing user data; it requires either eager re-encryption or per-attachment CEK indirection (Phase B).

### Cross-domain attack chain (S8 context)

Personal vault rotation does NOT rotate the user's stable `User.ecdhPublicKey` (used by all teams to wrap their TeamKey for this user). An attacker who recovers the OLD `secretKey` via any of the four gaps AND has access to a backup of the OLD `User.encryptedEcdhPrivateKey` recovers the user's stable ECDH private key → unwraps every team's `TeamMemberKey` row for this user → decrypts all team entries the user can access. This raises the urgency on the clearings, especially S1 (REQUESTED-state EA grants).

## Scope decision (revised)

**Phase A (this PR)** delivers all clearings + attachment data-loss safeguard + the new schema columns the clearings require. **Phase B** (a separate issue filed by this PR) covers personal attachment rotation strategy.

### Phase A — In scope

- A.1 Recovery Key clearing (with new `recoveryKeyInvalidatedAt` column for operational observability — **schema change**)
- A.2 Emergency Access partial clear (null only `ownerEphemeralPublicKey` to defeat ECDH derivation while preserving forensic ciphertext) + extend `STALE_ELIGIBLE_STATUSES` to include `REQUESTED`
- A.3 WebAuthn PRF wrapping clear (do NOT reset `prfSupported`) + new endpoint to re-bootstrap PRF with **fresh WebAuthn assertion required** + advisory-lock + keyVersion CAS
- A.4 Personal Attachment data-loss safeguard (`acknowledgeAttachmentDataLoss` flag + audit manifest of affected attachment IDs)
- A.5 Audit metadata extended with per-type counts; new audit action `WEBAUTHN_PRF_REBOOTSTRAP` registered in **all 5 places** (Prisma enum, AUDIT_ACTION constant, AUDIT_ACTION_VALUES list, AUDIT_ACTION_GROUPS_PERSONAL[AUTH], i18n labels)
- A.5b **Sibling fix (R34)**: add VAULT_KEY_ROTATION to AUDIT_ACTION_GROUPS_PERSONAL[AUTH] (currently absent — group-filtered views hide the events)
- A.5c **MCP token revocation parity (S-N2 + memory `feedback_user_bound_token_enumeration.md`)**: replace `revokeAllDelegationSessions` with `invalidateUserSessions(userId, { tenantId, reason: "KEY_ROTATION" })` so rotation also revokes Session / ExtensionToken / ApiKey / McpAccessToken / McpRefreshToken / DelegationSession. Audit metadata captures all counts + `cacheTombstoneFailures`.
- A.6 Verify dashboard audit-logs page (personal + tenant) renders unknown metadata keys without crash
- A.7 Integration test at the canonical path
- A.8 E2E coverage of the new acknowledge flow (required, not optional)
- A.9 Manual test plan (R35 Tier-2 obligation for cryptographic-material change)
- A.10 Whitepaper §6 update — only the new "cleared at rotation" sub-section + ECDH cross-domain context. The pre-existing "Entry data is NOT re-encrypted" drift is split into a separate `docs(whitepaper):` PR.

### Phase B — Out of scope (new issue, filed by this PR)

- Personal Attachment re-encryption strategy (eager re-encrypt during rotation vs per-attachment CEK indirection)
- Removing the `acknowledgeAttachmentDataLoss` safeguard once Phase B lands
- "Compromise rotation" mode (rotate `ecdhPublicKey` + reissue all `TeamMemberKey` rows) per S8 — separate issue

### Out of scope entirely

- Server master-key rotation (`/api/admin/rotate-master-key`)
- Schema redesign of `Attachment.keyVersion` storage
- Team rotation (already complete; ItemKey indirection)

## Requirements

### Functional

1. After `POST /api/vault/rotate-key` returns 200, the following must hold (assertable from DB state):
   - `User.recoveryEncryptedSecretKey IS NULL`, `recoverySecretKeyIv IS NULL`, `recoverySecretKeyAuthTag IS NULL`, `recoveryHkdfSalt IS NULL`, `recoveryVerifierHmac IS NULL`, `recoveryKeySetAt IS NULL`, **`recoveryKeyInvalidatedAt = NOW()` (newly set)**, `recoveryVerifierVersion = 1` (default — **NOT null** because the column is non-nullable)
   - For every `WebAuthnCredential` of this user: `prfEncryptedSecretKey IS NULL`, `prfSecretKeyIv IS NULL`, `prfSecretKeyAuthTag IS NULL`, **`prfSupported` UNCHANGED** (it represents authenticator capability, not wrapping presence)
   - For every `EmergencyAccessGrant` where `ownerId = user.id` AND `status` ∈ **`[IDLE, REQUESTED, ACTIVATED]`** AND `keyVersion < newKeyVersion`: `status = STALE`, **`ownerEphemeralPublicKey = NULL`** (other wrapping ciphertext fields RETAINED for forensic trail; clearing the ephemeral pubkey alone defeats ECDH unwrap per `crypto-emergency.ts:269-302`)
2. `POST /api/vault/rotate-key` rejects (422 with `API_ERROR.ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED`) when the user has any `Attachment` rows reachable via `passwordEntryId.userId = user.id` AND the request body does not include `acknowledgeAttachmentDataLoss: true`. Response includes `{ attachmentsAffected: <count> }`.
3. New PRF re-bootstrap flow:
   - **Options endpoint**: `POST /api/webauthn/credentials/[id]/prf/options` issues a one-shot challenge stored in Redis under **dedicated key** `webauthn:challenge:prf-rebootstrap:${userId}` (S-N1 — separate namespace from the sign-in `webauthn:challenge:authenticate:${userId}`). Returns `{ challenge, allowCredentials: [{ id }] }` scoped to the URL credential ID. Rate limit per-user 10/60s.
   - **Verify + write endpoint**: `POST /api/webauthn/credentials/[id]/prf` accepts `{ assertionResponse, prfEncryptedSecretKey, prfSecretKeyIv, prfSecretKeyAuthTag, keyVersion }`:
     - **Step-up auth (S3 fix)**: `assertionResponse` is verified via the new shared helper `verifyAuthenticationAssertion(userId, response, challengeKey)` (extracted from the existing `/api/webauthn/authenticate/verify/route.ts` per F20). Helper consumes the challenge from the dedicated PRF Redis key (`getdel`), looks up the credential, runs `verifyAuthentication`, performs counter CAS via raw SQL. Returns `{ verified, credentialId }`. The endpoint rejects when `credentialId !== URL[id]`.
     - **Advisory lock + CAS (S4 fix)**: handler runs in a transaction acquiring `pg_advisory_xact_lock(hashtext(userId))`. UPDATE filter: `WHERE userId = ? AND id = ? AND <user has keyVersion = body.keyVersion>`. Mismatch returns 409 with current keyVersion.
     - Audit: new action `WEBAUTHN_PRF_REBOOTSTRAP` with metadata `{ credentialId, keyVersionAtBind: body.keyVersion }`.
     - Rate limit: per-user 10/60s.
4. Audit `VAULT_KEY_ROTATION` metadata extended (additive):
   ```json
   {
     "fromVersion": int, "toVersion": int,
     "entriesRotated": int, "historyEntriesRotated": int,
     "recoveryKeyInvalidated": bool,
     "emergencyGrantsCleared": int,
     "prfCredentialsCleared": int,
     "attachmentsAffected": int,
     "attachmentDataLossAcknowledged": bool,
     "affectedAttachmentIds": string[],   // capped at 1000 — overflow flag if exceeded
     "invalidatedSessions": int,          // S-N2: from invalidateUserSessions result
     "invalidatedExtensionTokens": int,
     "invalidatedApiKeys": int,
     "invalidatedMcpAccessTokens": int,
     "invalidatedMcpRefreshTokens": int,
     "invalidatedDelegationSessions": int,
     "cacheTombstoneFailures": int        // matches existing vault-reset audit shape
   }
   ```
5. UI (rotation dialog in `src/lib/vault/vault-context.tsx` + dialog component):
   - Pre-flight uses extended GET `/api/vault/rotate-key/data` response (now includes `attachmentsAffected: number`)
   - If count > 0, dialog shows confirm step with "Cancel rotation, export attachments first" affordance
   - On user accept, sets `acknowledgeAttachmentDataLoss: true` in POST body
   - After success, dashboard banner: "Recovery key was invalidated, regenerate it." Toast on next passkey sign-in: "Auto-unlock re-enabled for [credential name]" (after PRF re-bootstrap completes silently per F18)
6. **MCP token revocation (S-N2 — confirmed gap, fixed in this PR)**: rotation calls `invalidateUserSessions(userId, { tenantId, reason: "KEY_ROTATION" })` after the transaction commits (matches existing `revokeAllDelegationSessions` placement at route.ts:294 and the `invalidateUserSessions` internal transactional integrity per Promise.all of updateMany/deleteMany at user-session-invalidation.ts:86-129). The returned `InvalidateUserSessionsResult` counts are merged into audit metadata (Functional Req 4). The call REPLACES the existing `revokeAllDelegationSessions` call at line 294.

### Non-functional

- Recovery / PRF clearings happen via the same transaction client `tx` as the existing rotate-key route.
- The EA clearing extends `markGrantsStaleForOwner` to be transaction-aware (it currently uses the global `prisma` client outside any transaction). Behavioral change acknowledged per F10: a transient EA-table contention now aborts the entire rotation rather than producing partial-success. Trade-off accepted: atomicity > best-effort retry potential.
- The new PRF rebootstrap endpoint takes its own `pg_advisory_xact_lock(hashtext(userId))` (S4).
- No new external dependencies.

## Schema changes (revised — was "no schema changes")

**Migration** (descriptive name per F22 + project convention): `npm run db:migrate -- --name add_recovery_key_invalidated_at_and_prf_rebootstrap_action` against dev DB. Two changes in one migration:

1. **Prisma `enum AuditAction`** (`prisma/schema.prisma:847`): add `WEBAUTHN_PRF_REBOOTSTRAP`
2. **`User` model**: add `recoveryKeyInvalidatedAt DateTime?` column

After migration: `npx prisma generate` to refresh the typed client. The existing `check:migration-drift` CI job validates.

**Test fixture impact (T18)**: after `prisma generate`, grep `recoveryKeySetAt:` in test files (`src/app/api/vault/status/route.test.ts:79,119,149,174`, `src/app/api/vault/recovery-key/generate/route.test.ts:61,172`). Add `recoveryKeyInvalidatedAt: null` to fixtures consumed by routes that `select` the new column. Spot-check fixture shapes before running the test suite to avoid R19 silent vacuous-pass.

## Implementation Steps

1. **Branch checked out** (`feature/433-key-rotation-gaps`); main is up-to-date.
2. **Schema + migration** (NEW step from F1, S5; descriptive name per F22):
   - Edit `prisma/schema.prisma`: add `WEBAUTHN_PRF_REBOOTSTRAP` to `enum AuditAction` (line 847); add `recoveryKeyInvalidatedAt DateTime?` to `User` model
   - Run `MIGRATION_DATABASE_URL=<...> npm run db:migrate -- --name add_recovery_key_invalidated_at_and_prf_rebootstrap_action`
   - Run `npx prisma generate`
   - Verify `check:migration-drift` passes locally
   - **Fixture sweep (T18)**: grep `recoveryKeySetAt:` in `src/**/*.test.ts`; for each file that `select`s the User row, add `recoveryKeyInvalidatedAt: null` to the fixture object
3. **Audit action registration (4 places per F7 + T11)**:
   - `src/lib/constants/audit/audit.ts` line 17: add to `AUDIT_ACTION` const
   - Same file line 193: add to `AUDIT_ACTION_VALUES` array (used by `audit.test.ts:213` + Zod query validators)
   - Same file line 479 (PERSONAL.WEBAUTHN group): add `WEBAUTHN_PRF_REBOOTSTRAP` (mirrors `WEBAUTHN_CREDENTIAL_REGISTER:279` placement)
   - **R34 sibling fix (F12)**: add `VAULT_KEY_ROTATION` to `AUDIT_ACTION_GROUPS_PERSONAL[AUTH]` (alongside `VAULT_SETUP` / `VAULT_RESET_EXECUTED`)
   - i18n: `messages/en/AuditLog.json` + `messages/ja/AuditLog.json` add labels for both new entries (the keys ARE the action constant names per existing convention)
   - **Coverage tests that fire if missed**: `src/__tests__/audit-i18n-coverage.test.ts:21-27`, `src/lib/constants/audit/audit.test.ts:213-221`
4. **API error code (3 places per F6)**:
   - `src/lib/http/api-error-codes.ts`: add `ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED` to `API_ERROR` const
   - Same file: add to `API_ERROR_I18N` map (key e.g., `attachmentDataLossNotAcknowledged`)
   - i18n: `messages/en/ApiErrors.json` + `messages/ja/ApiErrors.json`
5. **Refactor `markGrantsStaleForOwner`** (`src/lib/emergency-access/emergency-access-server.ts`):
   - Accept optional `tx?: PrismaTransactionClient`, default to global `prisma`
   - Extend `STALE_ELIGIBLE_STATUSES` (in `emergency-access-state.ts:44`) to include `EA_STATUS.REQUESTED` (S1 fix)
   - In `updateMany.data`: set `status = STALE`, `ownerEphemeralPublicKey = null` (S2 minimum-clear). Retain other wrapping fields.
   - Update its unit test (`emergency-access-server.test.ts`) per T4: 3 new test cases (tx-supplied path, exact-shape with `ownerEphemeralPublicKey: null`, forensic columns retained); plus 1 case (Step 12.e) confirming a REQUESTED grant is now matched.

5.5. **Extract `verifyAuthenticationAssertion` helper (NEW from F20 + S-N4)**:
   - File: `src/lib/auth/webauthn/webauthn-server.ts`
   - **Signature accepts a tx client (S-N4 fix)**: `verifyAuthenticationAssertion(tx: PrismaTransactionClient | typeof prisma, userId: string, response: AuthenticationResponseJSON, challengeKey: string): Promise<{ verified: boolean; credentialId: string }>`. Reason: counter CAS uses `$executeRaw UPDATE ... WHERE counter = ?`; running on the global `prisma` would commit the counter advance even when the surrounding tx aborts (e.g., when the new endpoint's keyVersion CAS rejects). Helper MUST run the counter UPDATE on the supplied `tx`.
   - Body covers: challenge `getdel` from the supplied Redis key, credential lookup with RLS, AuthenticatorDevice construction, `verifyAuthentication` invocation, **counter CAS via `tx.$executeRaw`**
   - Refactor existing `src/app/api/webauthn/authenticate/verify/route.ts` to call the helper with `challengeKey = "webauthn:challenge:authenticate:${userId}"` and `tx = prisma` (the existing route is not transactional; passing `prisma` preserves current semantics). The PRF response shaping stays in the route.
   - **Test refactor (F-N2)**: update `src/app/api/webauthn/authenticate/verify/route.test.ts` to mock `verifyAuthenticationAssertion` from `@/lib/auth/webauthn/webauthn-server` instead of `verifyAuthentication` from `@simplewebauthn/server`. Verify all existing assertions still meaningfully fire.
   - New unit tests for the helper: challenge consumed, missing challenge → 401, counter regression → 401, counter advance rolls back when caller's tx aborts, success → returns credentialId
6. **Extend `POST /api/vault/rotate-key/route.ts`**:
   - Add `acknowledgeAttachmentDataLoss: z.boolean().optional()` to Zod schema
   - Inside the existing transaction (after entry/history validation):
     1. Count attachments `tx.attachment.count({ where: { passwordEntry: { userId } } })` — comment per F13 ("personal entries only")
     2. If count > 0 AND not acknowledged: throw structured rejection
     3. Snapshot affected attachment IDs (cap 1000) for audit metadata per S7
     4. Update `User.update`: clear all 6 nullable `recovery*` fields, set `recoveryVerifierVersion = 1` (NOT null), set `recoveryKeyInvalidatedAt = new Date()`
     5. `tx.webAuthnCredential.updateMany({ where: { userId, prfEncryptedSecretKey: { not: null } }, data: { prfEncryptedSecretKey: null, prfSecretKeyIv: null, prfSecretKeyAuthTag: null } })` — leave `prfSupported` untouched (F8); capture count
     6. Invoke refactored `markGrantsStaleForOwner(userId, newKeyVersion, tx)` and capture count
   - **Replace `revokeAllDelegationSessions` (S-N2)** with `invalidateUserSessions(userId, { tenantId, reason: "KEY_ROTATION" })`. The call stays OUTSIDE the rotation transaction (matching the existing best-effort placement at line 290-294). Capture the returned `InvalidateUserSessionsResult` for audit metadata.
   - Extend `logAuditAsync` metadata payload with all new fields per Functional Req 4 (including the 6 invalidation counts + `cacheTombstoneFailures`)
7. **Extend `GET /api/vault/rotate-key/data/route.ts`**:
   - Add `attachmentsAffected: <count>` to response (additive)
   - Update test mock `prisma.attachment.count` (T7)
8. **New options endpoint `src/app/api/webauthn/credentials/[id]/prf/options/route.ts`** (POST):
   - Auth: session required; ownership check on credential `[id]`
   - Generate a one-shot challenge; store in Redis under dedicated key `webauthn:challenge:prf-rebootstrap:${userId}` with TTL **= the existing `WEBAUTHN_CHALLENGE_TTL_SEC` constant (F-N1)** — reuse the same constant the sign-in flow uses; if no shared constant exists yet, extract one in this PR. A code comment cross-references the sign-in TTL site so future tuning stays synchronized.
   - Return `{ challenge, allowCredentials: [{ id }] }` — restricted to the single credential being re-bootstrapped
   - Rate limit: per-user 10/60s

9. **New write endpoint `src/app/api/webauthn/credentials/[id]/prf/route.ts`** (POST):
   - Auth: session required; ownership check on credential `[id]`
   - Zod schema (RS3): `{ assertionResponse: <existing AuthenticationResponseJSON shape, mirror sign-in verify>, prfEncryptedSecretKey: hex(max=PRF_ENCRYPTED_KEY_MAX_LENGTH), prfSecretKeyIv: hex(24), prfSecretKeyAuthTag: hex(32), keyVersion: int }`
   - **Lock + Step-up + CAS (S3 + S-N1 + S4)**: open transaction, `pg_advisory_xact_lock(hashtext(userId))`. Inside the tx: (a) call `verifyAuthenticationAssertion(tx, userId, body.assertionResponse, "webauthn:challenge:prf-rebootstrap:${userId}")` — counter CAS rolls back atomically with the rest if any subsequent step fails; (b) reject if asserted credentialId ≠ URL `[id]`; (c) read user.keyVersion; if `body.keyVersion !== user.keyVersion` return 409 with `{ currentKeyVersion }`; (d) update credential row with new wrapping fields (do NOT touch `prfSupported`)
   - Audit `WEBAUTHN_PRF_REBOOTSTRAP` with metadata `{ credentialId, keyVersionAtBind, result: "success" }`. **For 409 stale-keyVersion mismatch (S-N5)**: emit the same audit action with `result: "stale_keyversion"` so adversarial rebootstrap-storm post-rotation produces a security signal beyond rate-limit logs.
   - Rate limit: per-user 10/60s
10. **Expose PRF wrapping presence to client (F9)** — `src/app/api/webauthn/credentials/route.ts` GET response: add derived `prfWrappingPresent: boolean` (from `prfEncryptedSecretKey != null`); do NOT expose ciphertext

11. **Recovery key UI semantic update (F21 from R2 + T-N1 from R3)**:
    - `src/app/api/vault/recovery-key/generate/route.ts`:
      - **Extend the `select` block at line 62** to include `recoveryKeyInvalidatedAt: true` — without this, the new field is `undefined` at runtime and the fix below silently no-ops (T-N1)
      - Line 124 — change `isRegeneration = !!user.recoveryKeySetAt` to `isRegeneration = !!user.recoveryKeySetAt || !!user.recoveryKeyInvalidatedAt`
    - `src/components/vault/recovery-key-dialog.tsx:187` — same logic update on the client side; ensure the data fetch that supplies the User object also includes `recoveryKeyInvalidatedAt`
    - This ensures users who lost recovery via rotation see the regenerate-flow wording, not first-time-setup

12. **Update `src/lib/vault/vault-context.tsx` rotation flow**:
    - Pre-flight reads `attachmentsAffected` from data fetch response
    - If > 0, show confirm step with "Cancel and export first" affordance + on accept set `acknowledgeAttachmentDataLoss: true`
    - After success, store post-rotation banner state (recovery regen + PRF rebootstrap-needed credential IDs) in vault context
    - **Banner copy (S-N3 from R2)**: "Rotation re-wrapped your personal vault. It does NOT rotate your team membership key — for compromise scenarios contact your tenant admin for compromise rotation."
    - **Operator alert + MCP banner (S-N2 caveat from R3)**: if response audit metadata shows `cacheTombstoneFailures > 0`, surface a banner "Some session caches did not invalidate; sign out other devices manually." If `invalidatedMcpAccessTokens + invalidatedMcpRefreshTokens > 0`, surface "Pre-rotation MCP tokens were revoked; you may need to re-mint at /tenant/service-accounts."
    - On next passkey sign-in, if a credential has `prfWrappingPresent = false`, perform silent PRF re-bootstrap: (a) call new options endpoint, (b) get authenticator assertion, (c) call new write endpoint with assertion + new wrapping. Show toast on success (silent UX per F18)

13. **Verify audit-logs page renders extended metadata** (F11): manual check of `src/app/[locale]/dashboard/audit-logs/page.tsx` (personal) and tenant equivalent. If they iterate known keys, add labels for the new keys; if they JSON-render unknown keys, no change needed.
14. **Tests** (per T-findings):
    - **a. Unit — refactored `markGrantsStaleForOwner`** (T4): 3 new cases per Step 5 above
    - **b. Unit — `rotate-key/route.test.ts`** (T5, T6, T16): extend `txMock` with `webAuthnCredential` / `attachment` / `emergencyAccessGrant`. Use `vi.mock('@/lib/auth/session/user-session-invalidation', () => ({ invalidateUserSessions: vi.fn() }))` for the new invalidation call. Add cases for: rejection without ack flag, success with ack, recovery* clearing, PRF clearing, EA mark-stale-and-clear-ephemeral-pubkey via tx, audit metadata exact-shape (including all new fields). **T17 atomicity moves here**: case "DB error injected via `txMock.webAuthnCredential.updateMany.mockRejectedValueOnce(...)` → recovery* clearing also rolls back" (unit-level using existing txMock pattern).
    - **c. Unit — `rotate-key/data/route.test.ts`** (T7): mock `attachment.count`, test 0 and N cases
    - **d. Unit — new PRF write endpoint** (T8, T16): create `src/app/api/webauthn/credentials/[id]/prf/route.test.ts`. **Mock layer (T16)**: `vi.mock('@/lib/auth/webauthn/webauthn-server', () => ({ verifyAuthenticationAssertion: mockVerifyAssertion }))` — same pattern as `webauthn/authenticate/verify/route.test.ts:14`. Cases: 401 unauth, 404 missing cred, 403 wrong owner, 400 missing/malformed payload, 400 missing assertionResponse, 401 assertion verification fails, 409 keyVersion mismatch, 200 success + `prfSupported` UNCHANGED, audit emit, 429 rate-limited
    - **d.b. Unit — new PRF options endpoint**: create sibling `options/route.test.ts` with 401 / 403 / 200 challenge issued cases
    - **e. Unit — `STALE_ELIGIBLE_STATUSES` extension**: add test confirming REQUESTED is included and a REQUESTED grant gets cleared
    - **e.b. Unit — `verifyAuthenticationAssertion` helper** (Step 5.5): challenge consumption, missing challenge, counter regression, success
    - **f. Integration — `src/__tests__/db-integration/vault-rotate-key-gaps.integration.test.ts`** (T3 corrected path):
       - Seed: 2 entries, recovery key, 1 IDLE EA grant + 1 REQUESTED EA grant + 1 ACCEPTED EA grant (untouched control), 1 WebAuthn credential with PRF wrapping, 1 attachment, 1 active McpAccessToken + 1 active McpRefreshToken (for the user)
       - Case 1: rotate without ack → 422 with `attachmentsAffected: 1`
       - Case 2: rotate with ack → 200; assert all post-state per Functional Req 1: recovery cleared + invalidatedAt set, IDLE+REQUESTED grants STALE with null ephemeralPubkey, ACCEPTED grant untouched (negative case), MCP tokens revoked, audit metadata includes all new counts
       - Case 3 (T9 concurrency): two concurrent rotations using `raceTwoClients` from `src/__tests__/db-integration/helpers.ts:238` → only one wins; advisory lock holds
       - **Note (T17)**: atomicity rollback case is at unit level (Case b) since real-DB injection seam is harder to construct; integration test relies on Postgres transaction semantics for atomicity (same approach as existing rotation/admin-reset tests)
    - **g. E2E — extend `e2e/tests/settings-key-rotation.spec.ts`** (T1, T15):
       - **T15 sub-step**: add `seedAttachment(prisma, { entryId, encryptedDataB64, ivHex, authTagHex })` helper to `e2e/helpers/password-entry.ts` (no existing helper — see Round 2 finding). Reuse from integration test in step 12.f.
       - Spec extension: seed an attachment via the new helper, open rotation dialog, assert ack step rendered + button disabled until checked, perform rotation, assert post-rotation: attachment row remains but download fails with documented message
    - **h. Unit — `recovery-key/generate/route.test.ts`** (Step 11 pairing, T-N1): add cases asserting `isRegeneration` returns true when `recoveryKeyInvalidatedAt` is set + `recoveryKeySetAt` is null (post-rotation state); add `recoveryKeyInvalidatedAt: null` to existing fixtures at lines 61, 172.
    - **i. Unit — `webauthn/credentials/route.test.ts`** (Step 10 pairing): add case asserting GET response includes derived `prfWrappingPresent` field (true / false / null per cred state).
15. **Manual test plan** (T2 — R35 Tier-2 obligation): create `docs/archive/review/433-key-rotation-gaps-manual-test.md` covering:
    - Recovery: rotate, verify recovery banner appears, attempt recovery → expect rejection
    - EA grantee: pre-rotation IDLE grant; rotate; grantee attempts unwrap → expect failure (no ephemeral pubkey)
    - PRF: rotate; sign in with passkey; verify auto-unlock fails first time, re-bootstrap prompt fires, succeeds; subsequent sign-ins auto-unlock
    - Attachment: rotate without ack → blocked; rotate with ack → succeeds; download attachment → fails with documented message
    - Adversarial scenarios: REQUESTED grant pre-rotation, wait out `waitExpiresAt` post-rotation, attempt activation → expect STALE rejection
16. **File Phase B issue** ("Personal vault attachment rotation strategy") with eager-re-encrypt vs CEK indirection trade-off + back-link to #433
17. **Whitepaper §6 update** (A.10 — SCOPE-LIMITED): add only the new sub-sections "6.1.x — Cleared at rotation" (recovery, EA partial, PRF) and "6.1.y — Known limitation: personal attachments + ECDH cross-domain context (S8)". The pre-existing "Entry data is NOT re-encrypted" drift is split per F15 into a separate `docs(whitepaper):` PR (cross-link).
18. **Add code comment** at the `invalidateUserSessions` call site (T14): "MUST remain outside transaction (touches different DB connection; best-effort placement matches existing vault-reset audit shape)"
19. **Mandatory pre-commit checks**: `npx vitest run`, `npx next build`, `bash scripts/pre-pr.sh`. Fix all failures before commit.

## Testing Strategy (revised)

### Unit
- Per Implementation Step 12.a-12.e

### Integration (real DB)
- Per Implementation Step 12.f at the canonical path `src/__tests__/db-integration/`

### E2E (Playwright) — REQUIRED, not optional
- Per Implementation Step 12.g

### Manual (R35 Tier-2)
- Per Implementation Step 13

### Negative paths covered
- Rotation without `acknowledgeAttachmentDataLoss` and attachments present → 422
- Rotation with concurrent attempt → second blocked by advisory lock
- PRF re-bootstrap with credential ID belonging to another user → 403
- PRF re-bootstrap with stale `keyVersion` → 409
- PRF re-bootstrap without valid WebAuthn assertion → 401
- REQUESTED EA grant pre-rotation → cleared (post-rotation activation rejected)
- DB error mid-rotation transaction → all clearings roll back

## Considerations & Constraints

- **Recovery banner UX**: existing dashboard likely surfaces a banner when recovery is unset. Verify before relying on it; if absent, add one in this PR.
- **PRF re-bootstrap UX**: silent on next passkey sign-in with toast notification + audit (per F18 decision on Open Q3).
- **Auditor experience**: extended audit metadata; downstream renderers JSON-render unknown keys (verify per F11). The new `WEBAUTHN_PRF_REBOOTSTRAP` action lands in PERSONAL/AUTH group filter.
- **Migration drift check**: schema migration is required (was previously claimed unnecessary). `check:migration-drift` will validate the additive enum + nullable column.
- **RLS**: new endpoint and new updates run within `withUserTenantRls(userId)` or the existing rotation transaction (RLS context set once). Confirm no `bypass_rls` is needed.
- **Cross-domain attack chain (S8)**: documented in whitepaper update. A future "compromise rotation" mode (rotate `ecdhPublicKey` + reissue all `TeamMemberKey` rows) is out of scope here — separate Phase B+ issue.
- **rotate-key/route.ts file growth**: route file is already ~317 lines and gains substantial inline logic. If it grows past 500 lines (project soft cap), extract clearings into helpers (`clearRotationConsumers(tx, userId, newKeyVersion): Promise<{recoveryKeyInvalidated, emergencyGrantsCleared, prfCredentialsCleared}>`).

## User Operation Scenarios

1. **User with no attachments rotates** — sees no warning step. Rotation succeeds. Dashboard banner: "Recovery key invalidated — regenerate."
2. **User with attachments tries to rotate** — sees warning "5 attachments will become unrecoverable", with "Cancel and export first" link to entries view. On accept, sets ack flag and proceeds. Post-rotation: attachment list still renders entries; downloads fail with documented Phase B-pointer message.
3. **User signs in with passkey post-rotation** — auto-unlock fails (PRF wrapping cleared); client silently re-bootstraps PRF via the new endpoint (which requires the assertion response that the sign-in just produced). Toast: "Auto-unlock re-enabled for [credential name]." Subsequent sign-ins auto-unlock normally.
4. **User had an in-flight REQUESTED EA grant** (granted user has clicked request, waiting period in progress) — rotation marks it STALE and clears `ownerEphemeralPublicKey`. When `waitExpiresAt` later fires, grantee's auto-promotion to ACTIVATED fails because the grant is STALE; grantee receives clear error pointing back to grantor.
5. **Operator runs audit log download with `actorType=HUMAN`** — sees `VAULT_KEY_ROTATION` event with the extended metadata shape (now also visible in PERSONAL/AUTH group filter per the R34 sibling fix). Sees `WEBAUTHN_PRF_REBOOTSTRAP` events for each post-rotation re-bootstrap. Sees `mcpAccessToken` / `mcpRefreshToken` revocation counts in metadata (S-N2 from R2).
6. **AI agent / MCP client holding pre-rotation `mcp_*` token attempts a vault operation post-rotation** — token returns 401 (revoked); operator must mint a new token.

## Resolution of Round 1 Open Design Questions

| Q | Resolution |
|---|---|
| Q1 (block vs ack flag for attachments) | Keep ack flag (F16). Add "Cancel and export first" affordance to soften the data-loss UX. |
| Q2 (EA wrapping clear vs cosmetic) | Partial clear — null only `ownerEphemeralPublicKey` (S2). Defeats unwrap, preserves forensic ciphertext + keyVersion + wrapVersion. |
| Q3 (PRF UX silent vs confirm) | Silent (F18) on next passkey sign-in, with toast + audit. The user already authenticated via passphrase to perform rotation; second confirm adds friction without surfacing actionable security signal. |
| Q4 (whitepaper drift fix scope) | Split (F15). This PR's whitepaper update only adds the new sub-sections. Drift fix → separate `docs(whitepaper):` PR, cross-linked. |
| Q5 (delete attachment rows on ack vs leave orphans) | Leave intact (F19). Phase B's recovery options depend on the orphan rows. Audit metadata captures `affectedAttachmentIds` for post-incident manifest. |

## Round 1 Findings → Round 2 Plan Mapping

| Finding | Severity | Disposition | Plan section |
|---|---|---|---|
| F1 (Prisma migration needed) | Critical | Adopted | Step 2 |
| F2 (recoveryVerifierVersion non-null) | Critical | Adopted | Functional Req 1, Step 6.4 |
| F3 (test seed state) | Major | Adopted | Step 12.f seed |
| F4 (REQUESTED gap) | Major | Same as S1 — adopted | Step 5 (extend STALE_ELIGIBLE) |
| F5 (i18n paths) | Major | Adopted | Step 3, Step 4 |
| F6 (API_ERROR i18n map) | Major | Adopted | Step 4 |
| F7 (audit.ts 4 places) | Major | Adopted | Step 3 |
| F8 (don't reset prfSupported) | Major | Adopted | Functional Req 1, Step 6.5 |
| F9 (expose prfWrappingPresent) | Major | Adopted | Step 9 |
| F10 (atomic vs best-effort trade-off) | Major | Adopted (acknowledged in Non-functional) | Non-functional section |
| F11 (audit-logs page render verify) | Major | Adopted | Step 11 |
| F12 (VAULT_KEY_ROTATION sibling fix) | Major | Adopted (R34) | A.5b, Step 3 |
| F13 (attachment count comment) | Major | Adopted | Step 6 |
| F14 (integration test path) | Minor | Same as T3 — adopted | Step 12.f |
| F15 (whitepaper split) | Minor | Adopted | A.10, Step 15 |
| F16-F19 (Open Q answers) | Minor | Resolved | Resolution table above |
| S1 (REQUESTED gap) | Critical | Adopted (escalation skipped) | Step 5 |
| S2 (EA partial clear) | Major | Adopted | Step 5 |
| S3 (PRF step-up) | Major | Adopted | Step 8 |
| S4 (PRF lock + CAS) | Major | Adopted | Step 8 |
| S5 (recoveryKeyInvalidatedAt) | Major | Adopted (schema change) | Step 2, Functional Req 1 |
| S6 (PRF rate limit) | Minor | Resolved (S3 adopted → per-user 10/60s OK) | Step 8 |
| S7 (attachment manifest) | Minor | Adopted (capped at 1000) | Functional Req 4, Step 6.3 |
| S8 (ECDH cross-domain) | Minor (context) | Adopted (whitepaper docs + Phase B+ issue note) | Background, Step 15, Constraints |
| T1 (E2E required) | Critical | Adopted | Step 12.g |
| T2 (manual test plan) | Critical | Adopted | Step 13 |
| T3 (CI path) | Critical | Adopted | Step 12.f |
| T4 (markGrantsStaleForOwner test) | Critical | Adopted | Step 5, Step 12.a |
| T5 (route.test.ts mock) | Major | Adopted | Step 12.b |
| T6 (audit metadata snapshot) | Major | Adopted | Step 12.b |
| T7 (data/route.test.ts mock) | Major | Adopted | Step 7, Step 12.c |
| T8 (PRF endpoint test file) | Major | Adopted | Step 12.d |
| T9 (concurrency test) | Major | Adopted (optional but preferred) | Step 12.f Case 4 |
| T10 (atomicity test) | Major | Adopted | Step 12.f Case 3 |
| T11 (exhaustive coverage tests) | Major | Adopted | Step 3 (cited tests) |
| T12 (E2E EA helper) | Minor | Deferred to integration test (Step 12.f covers EA assertion at integration level; E2E does not need to seed wrapping) | Step 12.f |
| T13 (orphan policy test) | Minor | Adopted (resolved with leave-intact policy + assertion) | Step 12.f Case 2 |
| T14 (delegation revoke comment) | Minor | Adopted | Step 16 |

## Adjacent Findings — Routing

- **MCP token revocation parity** (S-N2 from R2): RESOLVED — adopted in Functional Req 6 + Step 6 + Step 18. Rotation now calls `invalidateUserSessions` covering all 6 token classes.
- **Webhook event groups for `WEBAUTHN_PRF_REBOOTSTRAP`**: deferred — PRF rebootstrap is a routine post-rotation action, not webhook-worthy. If tenant admins later request signal, file separately.

## Round 2 Findings → Round 3 Plan Mapping

| Finding | Severity | Disposition | Plan section |
|---|---|---|---|
| F20 (extract verifyAuthenticationAssertion helper) | Major | Adopted | Step 5.5 |
| F21 (isRegeneration UX update) | Minor | Adopted | Step 11 |
| F22 (migration name convention) | Minor | Adopted | Schema changes section + Step 2 |
| S-N1 (PRF challenge keyspace) | Major | Adopted | Functional Req 3 (separate Redis key) + Steps 8/9 |
| S-N2 (MCP token revocation) | Major | Adopted | A.5c, Functional Req 4/6, Step 6, Step 18 |
| S-N3 (compromise rotation banner copy) | Minor | Adopted | Step 12 banner copy |
| T15 (seedAttachment E2E helper) | Major | Adopted | Step 14.g |
| T16 (vi.mock pattern for verifyAuthentication) | Minor | Adopted | Step 14.b, 14.d |
| T17 (atomicity test demoted to unit) | Major | Adopted | Step 14.b (unit) + Step 14.f Note |
| T18 (recoveryKeyInvalidatedAt fixture sweep) | Minor | Adopted | Schema changes section + Step 2 |

## Round 3 Findings → Round 4 Plan Mapping

| Finding | Severity | Disposition | Plan section |
|---|---|---|---|
| F-N1 (PRF challenge TTL constant) | Major | Adopted | Step 8 (reuse `WEBAUTHN_CHALLENGE_TTL_SEC`) |
| F-N2 (refactor breaks existing verify route test) | Minor | Adopted | Step 5.5 test refactor sub-step |
| F-N3 (case numbering drift) | Minor | Acknowledged — Round 1→2 mapping table refers to historical step numbers; Round 2→3 + Round 3→4 mapping tables (this section + above) are authoritative for current step numbers | This table |
| S-N2 caveat (b)/(c): operator alert + MCP banner | Major | Adopted | Step 12 (banner conditions on cacheTombstoneFailures + MCP counts) |
| S-N4 (helper counter CAS must accept tx) | Major | Adopted | Step 5.5 (signature accepts tx) |
| S-N5 (audit 409 stale_keyversion) | Minor | Adopted | Step 9 audit metadata |
| T-N1 (Step 11 must extend select clause) | Major | Adopted | Step 11 select extension |
| T-N2 (cacheTombstoneFailures explicit in 14.b) | Minor | Adopted | Implicit in 14.b's "audit metadata exact-shape including all new fields" — Functional Req 4 lists the field |
| Plan: 14.h + 14.i for Step 10/11 unit pairs | Major | Adopted | Step 14.h, 14.i |
