# Coding Deviation Log: 433-key-rotation-gaps

This file records deviations from the plan at `./433-key-rotation-gaps-plan.md`.
Items where the implementation followed the plan exactly are NOT recorded.

## Deferred to follow-up (not implemented in this PR)

### ~~D1. Integration test against real DB — RESOLVED~~

Now implemented at `src/__tests__/db-integration/vault-rotate-key-gaps.integration.test.ts`. Five real-DB scenarios covering `markGrantsStaleForOwner` (STALE flip + ephemeral pubkey null + forensic-trail retention; ACCEPTED untouched; keyVersion guard; legacy NULL keyVersion eligibility) and `invalidateUserSessions(KEY_ROTATION)` (all 6 user-bound token classes revoked). All 5 pass.

### ~~D2. E2E spec extension + seedAttachment helper — RESOLVED~~

`seedAttachment` helper added to `e2e/helpers/password-entry.ts` (with companion unit tests locking the aad_version=1 + encryption_mode=0 invariants). New Playwright scenario in `e2e/tests/settings-key-rotation.spec.ts` covers the data-loss acknowledge flow end-to-end (seed attachment → open dialog → submit → assert ack step → click acknowledge → assert orphan row remains in DB).

### D3. ECDH cross-domain "compromise rotation" mode

- **Plan reference**: Considerations & Constraints / S8.
- **Status**: Documented only; no code added in this PR.
- **Why**: Personal vault rotation does NOT rotate the user's stable
  `User.ecdhPublicKey`. An attacker who recovers the OLD secretKey via any
  of the four gaps + has a backup of `encryptedEcdhPrivateKey` can decrypt
  team entries via the user's stable ECDH identity. The plan documents this
  attack chain in the whitepaper; a separate "compromise rotation" mode that
  also rotates `ecdhPublicKey` + reissues every `TeamMemberKey` row for the
  user is a substantial follow-up (touches every team the user is a member
  of, requires per-team coordination).
- **Risk**: Backup-compromise scenarios remain partially exposed. Mitigation
  is operational (whitepaper update advises users to contact tenant admin
  for compromise scenarios).
- **Recovery**: file Phase B+ issue tracking the compromise-rotation mode.

### D4. Phase B — personal attachment re-encryption strategy

- **Plan reference**: Step 16 (file Phase B issue).
- **Status**: Issue not yet filed (will be filed alongside this PR).
- **Why**: Phase B is the substantive design discussion (eager re-encrypt
  vs per-attachment CEK indirection vs background migration). It needs its
  own triangulated plan rather than getting bolted onto this PR.

## Phase 3 review findings handled in this PR

### P3-T1 (Critical) — added: AttachmentAckRequiredError 422 path tests
- Added 5 cases to `src/app/api/vault/rotate-key/route.test.ts`: 422-without-ack
  + 200-with-ack assertion of audit metadata, recoveryKeyInvalidated true/false,
  invalidation counts shape.

### P3-F4 (Major) — fixed: `attachmentsAffected` count truncation
- The original `findMany({ take: CAP+1 }).length` capped the count at
  CAP+1. Replaced with a real `tx.attachment.count(...)` query for the
  user-facing + audit count, then a separate capped `findMany` for the
  forensic ID manifest. Added `affectedAttachmentIdsOverflow: boolean`
  audit field per Functional Req 4.

### P3-T2/T3/T4 (Major) — added: positive coverage for new fields
- `vault/status/route.test.ts`: case where `recoveryKeyInvalidated: true`
  surfaces while `hasRecoveryKey: false` (post-rotation state).
- `recovery-key/generate/route.test.ts`: case where the rotation-cleared
  state correctly maps to `RECOVERY_KEY_REGENERATED` (not CREATED).
- `rotate-key/data/route.test.ts`: positive assertions on
  `attachmentsAffected` (0 and N).

## ~~Phase 3 review findings deferred to follow-up~~ — ALL RESOLVED IN THIS PR

### ~~P3-F1 (Major) — recovery-key banner UX gap — RESOLVED~~

`recovery-key-banner.tsx` now reads `recoveryKeyInvalidated` from vault context and renders the regenerate-flow wording (new i18n key `recoveryKeyBannerMessageInvalidated` in en/ja).

### ~~P3-F2 (Major) — operator alert banners — RESOLVED~~

Rotation route 200 response carries `rotationEffects` with the invalidation counts + `cacheTombstoneFailures`. The dialog surfaces three new toasts: persistent warning on cacheTombstoneFailures > 0, persistent warning on `invalidationFailed`, 10s info toast naming the count of revoked MCP tokens.

### ~~P3-F3 (Major) — silent PRF re-bootstrap — RESOLVED~~

Implemented as an explicit "Re-enable" affordance (not silent — see commit message `9b37bce3` for rationale): the credentials list exposes `prfWrappingPresent`, the card renders an amber `vaultUnlock` badge + a `Re-enable` button when wrapping is missing, and the button runs the new options + write endpoints with the current secretKey + keyVersion CAS. 9 i18n keys added in en/ja covering the badge tooltip, button label, hint, success/failure toasts, and the stale-keyVersion explanation.

### Original P3-F1/F2/F3 deferral text retained for audit trail

#### P3-F1 (Major) — recovery-key banner UX gap
- The banner component (`src/components/vault/recovery-key-banner.tsx`) does
  not yet read `recoveryKeyInvalidated` from the vault context; it shows
  the same generic "first-time setup" copy whether the user has never set
  recovery up OR lost it via rotation. The dialog body (the regenerate
  warning) DOES branch correctly, so the user sees the right wording once
  they click into the dialog.
- **Why deferred**: cosmetic UX gap, not a security or data-correctness
  issue. The S5 "operational visibility" goal is met at the API/audit
  level (admins can query `recoveryKeyInvalidatedAt`); the dialog itself
  shows the right wording; only the banner's at-a-glance message is
  generic.
- **Risk**: users may dismiss the banner without realizing rotation
  invalidated their recovery.
- **Follow-up**: file an issue for "post-rotation banner copy + ICU plural
  in `messages/{en,ja}/Vault.json`".

### P3-F2 (Major) — operator alert banners
- The plan called for two post-rotation banners (cacheTombstoneFailures > 0
  → "sign out other devices"; invalidatedMcpAccessTokens+RefreshTokens > 0
  → "MCP tokens were revoked"). Neither lands in this PR. The audit
  metadata DOES capture the counts, so admins can query them; the
  user-facing banners do not exist yet.
- **Why deferred**: requires the rotation route to extend its 200 response
  with the invalidation counts (currently only `{ success, keyVersion }`)
  AND the dialog to surface them. Half-implementing one but not the other
  would be a half-step. Deferring both keeps the PR consistent.
- **Risk**: in a Redis outage during rotation, users won't see the "sign
  out other devices manually" prompt; admins can still detect via audit
  log. MCP token revocation is silent to the user but visible to admins.
- **Manual test correction**: scenario E in the manual test plan claims
  the banner surfaces — that is currently inaccurate. See the manual
  test plan note added in the same commit.
- **Follow-up**: file an issue for "rotate-key 200 response shape +
  post-rotation banners".

### P3-F3 (Major) — silent PRF re-bootstrap on next sign-in
- The plan called for the client to silently re-bootstrap PRF wrapping on
  the next passkey sign-in when `prfWrappingPresent === false`. The new
  endpoints exist (Batch 4) but the client `unlockWithPasskey` /
  `unlockWithStoredPrf` flows do not yet auto-call them.
- **Why deferred**: scope. The implementation is non-trivial — the client
  must produce a fresh assertion via the new options endpoint (or reuse
  the just-completed sign-in assertion if the API exposes it), POST the
  new wrapping with the current keyVersion, and handle the 409 stale-CAS
  gracefully. Each integration point needs coverage.
- **Risk**: after rotation, users sign in with passkey, vault unlock
  falls back to passphrase, and PRF auto-unlock stays broken until the
  user manually triggers the rebootstrap (no UI affordance for that
  yet either).
- **Follow-up**: file an issue for "client-side PRF re-bootstrap on next
  sign-in".

### P3-F5 / P3-F6 / P3-F7 (Minor) — non-blocking
- F5: missing explicit "MUST remain outside transaction" wording at the
  invalidateUserSessions call site comment.
- F6: invalidationResult null vs 0 distinguishability in audit metadata.
- F7: `TxOrPrisma` type duplicated between webauthn-server.ts and
  emergency-access-server.ts (no shared alias).

### P3-T5 / P3-T6 / P3-T7 (Minor) — non-blocking
- T5: cacheTombstoneFailures not asserted in the existing rotation route
  tests (resolved by P3-T1 work above which adds the audit-shape assertion).
- T6: TxFn alias uses `any`. Per coding-style.md "Never use `any`"; pre-
  existing in audit-outbox-worker.test.ts.
- T7: API_ERROR count test message — sufficient as-is (resolved-no-finding).

## Plan corrections applied during implementation

### C1. Migration captured Prisma 7 alignment noise

- **Plan reference**: Step 2.
- **What happened**: `prisma migrate dev` auto-detected three "drift" lines
  that the project's prior migrations had been carrying forward as recurring
  pseudo-drift (the `audit_chain_anchors.prev_hash` bytea default
  representation; the `system_settings.updated_at` default; the
  `admin_vault_resets` index name truncation). My migration is the first to
  align two of those (system_settings, admin_vault_resets). Including them
  in `20260503101424_add_recovery_key_invalidated_at_and_prf_rebootstrap_action`
  is consistent with the project pattern.
- **Impact**: zero functional impact; CI fresh-DB build + production
  deployments execute the same SQL.

### C2. `revokeAllDelegationSessions` fully replaced (not extended)

- **Plan reference**: Step 6 + S-N2 disposition.
- **What happened**: The plan said "replace `revokeAllDelegationSessions` with
  `invalidateUserSessions`". The route's `revokeAllDelegationSessions` import
  is now unused → removed. The audit metadata `delegationSessions` count
  comes from the `invalidateUserSessions` result (which covers it as one of
  the 6 token classes).
- **Impact**: equivalent semantics + 5 additional token classes invalidated.

### C3. Pre-existing typecheck cleanup in audit-outbox-worker.test.ts

- **Plan reference**: not in plan.
- **What happened**: per user direction ("無関係と言わず修正のこと"), pre-existing
  typecheck errors in `src/workers/audit-outbox-worker.test.ts` (5 inline
  `(tx: unknown) => Promise<unknown>` signatures that did not satisfy the
  `mockTransaction` parameter type) were aligned with the file-local `TxFn`
  alias.
- **Impact**: closes 9 pre-existing typecheck errors that main was carrying.
  No runtime change.

### C4. Verify-route test rewritten at helper boundary

- **Plan reference**: Step 5.5 (extract helper) + Step 14 implicit.
- **What happened**: The existing `webauthn/authenticate/verify/route.test.ts`
  mocked the lower-level primitives (Redis, prisma, verifyAuthentication
  from @simplewebauthn). After the helper extraction, the test now mocks
  at the `verifyAuthenticationAssertion` boundary (T16/RT1 alignment). The
  primitive-level coverage moves to the helper's own unit tests (deferred —
  see below).

### ~~C5. verifyAuthenticationAssertion helper unit test — RESOLVED~~

Now implemented at `src/lib/auth/webauthn/verify-authentication-assertion.test.ts` (12 cases covering namespace flexibility, counter CAS rollback safety, credential lookup userId scoping, every failure code path).

## Tests/contracts changed during implementation (intentional)

- `src/lib/emergency-access/emergency-access-server.test.ts`: updated
  exact-shape assertion of `markGrantsStaleForOwner` to reflect the new
  `data: { status: STALE, ownerEphemeralPublicKey: null }` payload and the
  STALE_ELIGIBLE list now including REQUESTED.
- `src/app/api/vault/rotate-key/route.test.ts`: replaced "succeeds even if
  markGrantsStaleForOwner fails" (best-effort semantics) with "aborts
  rotation when markGrantsStaleForOwner throws" (atomic semantics, F10).
- `src/app/api/vault/status/route.test.ts`: response shape extended with
  `recoveryKeyInvalidated: false` for the existing fixtures.
