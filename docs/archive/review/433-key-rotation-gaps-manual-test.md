# Manual Test Plan: Key Rotation Gaps (#433)

**R35 tier**: 2 (Critical) — change touches cryptographic material (recovery wrapping, EA escrow, PRF wrapping) and user-bound auth artifacts (Session/ExtensionToken/ApiKey/MCP*/DelegationSession).

**Boot signal (R32)**: not applicable — no new long-running runtime artifact.

**Branch**: `feature/433-key-rotation-gaps`

## Pre-conditions

- Local dev stack up (`npm run docker:up`) with the new migration applied
  (`20260503101424_add_recovery_key_invalidated_at_and_prf_rebootstrap_action`).
- A test user with vault set up + at least one password entry.
- A test user with a recovery key generated (for scenario A2).
- A test user paired with another user as Emergency Access grantee
  (for scenario B; both users in the same tenant).
- A passkey credential registered with PRF support
  (browser developer mode authenticator works for scenario C).
- A test user with at least one personal-entry attachment
  (for scenarios D1 / D2).
- A test user with an active `mcp_*` token issued via /tenant/service-accounts
  (for scenario E).

## Scenarios

### A — Recovery key invalidation

**A1** (no recovery)
- Pre: user has not generated a recovery key.
- Steps: rotate the vault from settings → key rotation; enter passphrase; submit.
- Expected:
  - Rotation succeeds.
  - Audit log shows `VAULT_KEY_ROTATION` with `recoveryKeyInvalidated: false`.
  - The recovery setup banner remains in its "first-time" wording.

**A2** (recovery existed)
- Pre: user has generated a recovery key in a prior session.
- Steps: rotate the vault → success → open the recovery dialog.
- Expected:
  - Rotation succeeds.
  - Audit metadata shows `recoveryKeyInvalidated: true`.
  - DB `users.recovery_key_invalidated_at` is set; `recovery_key_set_at` and the
    encrypted recovery wrapping fields are NULL.
  - The recovery dialog now shows the **regenerate-flow** wording (yellow
    warning that re-generating supersedes a prior key) — NOT the first-time
    setup wording. This validates F21+S5.
  - Attempting to recover with the OLD recovery key fails (the wrapping is
    cleared so server has nothing to return).

### B — Emergency Access grantee post-rotation

- Pre: User Owner has an `IDLE` EA grant to User Grantee (key was confirmed in
  a prior session; the grant has stored `encryptedSecretKey` +
  `ownerEphemeralPublicKey` + `hkdfSalt`).
- Steps:
  1. Owner rotates the vault.
  2. Grantee logs in and goes to Emergency Access.
  3. Grantee initiates an emergency request for Owner's vault (RequestAccess).
- Expected:
  - After Owner's rotation, the grant DB row shows
    `status = STALE`, `owner_ephemeral_public_key IS NULL`,
    `encrypted_secret_key` retained for forensic trail (S2 minimum-clear).
  - Grantee's RequestAccess fails — the grant is STALE, not eligible for
    activation. No back-channel decrypt path remains.
  - Audit metadata on Owner's `VAULT_KEY_ROTATION` shows
    `emergencyGrantsCleared` ≥ 1.

**B-adversarial (REQUESTED state — #433/S1)**
- Pre: Owner has an EA grant in `REQUESTED` state (Grantee already pressed
  RequestAccess, waiting period in progress).
- Steps:
  1. Owner rotates the vault.
  2. Wait until `wait_expires_at` passes (or fast-forward in test DB).
  3. Grantee triggers ActivateAccess.
- Expected:
  - Activation FAILS — the grant was marked STALE during rotation despite
    being in REQUESTED state. Grantee cannot recover Owner's old secretKey.
  - This validates the S1 fix; without the REQUESTED-in-STALE_ELIGIBLE
    extension, the grant would still wrap the OLD secretKey and the grantee
    would obtain it on auto-promotion to ACTIVATED.

### C — PRF re-bootstrap after rotation

**C1** (sign-in stops auto-unlocking)
- Pre: user has a PRF-capable passkey wired up; vault auto-unlocks on
  passkey sign-in.
- Steps: rotate the vault → sign out → sign back in with the passkey.
- Expected:
  - Auto-unlock fails / does not happen — the PRF wrapping was cleared
    during rotation.
  - DB `webauthn_credentials.prf_encrypted_secret_key IS NULL`,
    `prf_supported` UNCHANGED (still true). `GET /api/webauthn/credentials`
    returns `prfWrappingPresent: false` for that credential.

**C2** (re-bootstrap success path)
- Pre: state from C1 (PRF cleared by rotation).
- Steps: from settings → security, trigger "Re-enable passkey auto-unlock" for
  the affected credential. Browser prompts for the passkey ceremony.
- Expected:
  - `POST /api/webauthn/credentials/[id]/prf/options` issues a challenge to the
    DEDICATED key `webauthn:challenge:prf-rebootstrap:${userId}`.
  - `POST /api/webauthn/credentials/[id]/prf` accepts the assertion + new
    wrapping; CAS check succeeds (current keyVersion matches request).
  - Subsequent passkey sign-in auto-unlocks again.
  - Audit log has `WEBAUTHN_PRF_REBOOTSTRAP` with `result: "success"`.

**C3** (stale rebootstrap from concurrent rotation)
- Pre: user starts the C2 ceremony; before they complete the assertion, a
  second rotation runs (e.g., via another tab or admin reset).
- Steps: complete the C2 ceremony with the now-stale keyVersion.
- Expected:
  - 409 + `currentKeyVersion`. Wrap update did NOT proceed.
  - Audit log shows `result: "stale_keyversion"` with the bound keyVersion +
    the current keyVersion.
  - This validates S4 + S-N5.

### D — Attachment data-loss safeguard

**D1** (no attachments)
- Pre: user has no personal-entry attachments.
- Steps: rotate the vault from settings.
- Expected: rotation succeeds with no extra UI step.

**D2** (attachments present)
- Pre: user has ≥ 1 personal-entry attachment.
- Steps: rotate the vault → enter passphrase → submit.
- Expected:
  - The dialog rejects the rotation and surfaces the attachment-data-loss
    warning naming the count (e.g., "Your vault has 3 attachments…").
  - The "Acknowledge data loss and rotate" button is the ONLY way to proceed
    — the original submit button is disabled.
  - Clicking the acknowledge button retries with
    `acknowledgeAttachmentDataLoss: true`. Rotation succeeds.
  - Audit metadata shows `attachmentsAffected = N`,
    `attachmentDataLossAcknowledged: true`, and `affectedAttachmentIds` lists
    the IDs (capped at 1000).
  - Post-rotation the attachment row(s) STILL EXIST in the DB (Phase B
    recovery design depends on this) but downloads of those attachments fail
    or return undecryptable bytes.

### E — User-bound token enumeration (S-N2)

- Pre: user has at least one of each: ExtensionToken, ApiKey, an active MCP
  client session (mcpAccessToken + mcpRefreshToken), and a DelegationSession.
- Steps: rotate the vault → use each credential / client to attempt an API
  call within ~5 seconds after rotation.
- Expected:
  - Every call returns 401 (token revoked).
  - Audit metadata shows non-zero counts for the corresponding fields:
    `invalidatedSessions / invalidatedExtensionTokens / invalidatedApiKeys /
    invalidatedMcpAccessTokens / invalidatedMcpRefreshTokens /
    invalidatedDelegationSessions`.
  - `cacheTombstoneFailures` is 0 in a healthy environment. If you simulate a
    Redis outage during the rotation, the count appears in the audit metadata.
- **Known limitation (P3-F2 — deferred to follow-up)**: the user-facing
  banner "sign out other devices manually" / "MCP tokens were revoked" is
  NOT yet implemented. The signal is admin-visible via audit log only.

## Adversarial scenarios

- **Cross-flow Redis-key consumption** — open the sign-in flow on Tab A
  (issue `webauthn:challenge:authenticate:${userId}`); start a PRF rebootstrap
  on Tab B (issue `webauthn:challenge:prf-rebootstrap:${userId}`). Complete
  Tab A's sign-in. Tab B's rebootstrap challenge MUST still be valid (the two
  keys do not collide). Repeat in reverse order — Tab A's sign-in challenge
  must survive Tab B's rebootstrap. Validates S-N1.
- **PRF rebootstrap without assertion** — POST to `/api/webauthn/credentials/[id]/prf`
  with a stolen session cookie but a forged or stale `assertionResponse`.
  MUST be rejected; no wrapping is written. Audit shows `result:
  "assertion_failed"`.
- **Counter replay across endpoints** — capture a sign-in assertion, replay it
  against `/api/webauthn/credentials/[id]/prf`. The challenge keys differ, so
  the rebootstrap helper consumes a NULL challenge from the prf-rebootstrap
  Redis key and rejects with 400 / `Challenge expired or already used`.
  Validates S-N4 + S-N1 together.

## Rollback

- The migration is a non-destructive additive change (one new nullable
  column; one new enum value). To roll back the deployed code while keeping
  the DB schema, redeploy the previous binary; the new column simply stays
  `NULL` and the new enum value is unused. The new endpoints become 404 once
  the new code is removed.
- If the new schema must be reverted: write a follow-up migration that
  `ALTER TABLE users DROP COLUMN recovery_key_invalidated_at`. The
  AuditAction enum value cannot be removed from a deployed Postgres enum
  without recreating the type — leave it (harmless if unused).
