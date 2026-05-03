# Coding Deviation Log: 433-key-rotation-gaps

This file records deviations from the plan at `./433-key-rotation-gaps-plan.md`.
Items where the implementation followed the plan exactly are NOT recorded.

## Deferred to follow-up (not implemented in this PR)

### D1. Integration test against real DB

- **Plan reference**: Step 14.f (`src/__tests__/db-integration/vault-rotate-key-gaps.integration.test.ts`).
- **Status**: Deferred.
- **Why**: PRF rebootstrap unit tests at the route level (Step 14.d/d.b)
  cover the security invariants of the new endpoints + assertion contract.
  The rotation-route unit test (Step 14.b) covers the new in-tx clearings.
  An integration test against the live DB adds confidence on the cross-table
  atomicity (rotation + EA stale + invalidation counts) but is ~half a day of
  additional work and adds a dependency on docker DB up + integration CI job
  path tuning.
- **Risk**: Cross-table atomicity assertions live only at unit level. If a
  future refactor moves the EA stale call back outside the tx accidentally,
  the unit test would catch the call-shape change but a real-DB partial-write
  scenario could slip through.
- **Recovery**: file follow-up issue with the seed shape from Step 14.f.

### D2. E2E spec extension + seedAttachment helper

- **Plan reference**: Step 14.g (extend `e2e/tests/settings-key-rotation.spec.ts`
  + add `seedAttachment` helper to `e2e/helpers/password-entry.ts`).
- **Status**: Deferred.
- **Why**: The dialog UX change is small (one extra acknowledge step gated by
  `attachmentsAffected > 0`). The unit tests in Batch 5 + the manual test
  plan cover the user flow. A Playwright spec adds ~1-2 hours of work
  including the `seedAttachment` helper that does not yet exist
  (`e2e/helpers/password-entry.ts` has no attachment-seeding API today).
- **Risk**: Regression in the dialog flow not caught by unit tests (e.g.,
  mis-wired button disabled state) would only surface in QA / production.
- **Recovery**: file follow-up issue.

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

### C5. verifyAuthenticationAssertion helper unit test deferred

- **Plan reference**: Step 14.e.b ("Unit — verifyAuthenticationAssertion helper").
- **Status**: Deferred — file follow-up.
- **Why**: The helper's behavior is exercised through the route tests for
  both consumers (sign-in `verify/route.test.ts` and
  `credentials/[id]/prf/route.test.ts`) AND the ownership / counter CAS
  invariants are documented in code comments. A dedicated helper unit test
  would lock in the exact challenge / lookup / CAS sequence but is not
  blocking for the security invariants of #433.
- **Risk**: A refactor of the helper (e.g., changing the lookup strategy) is
  not directly tested at the helper level — would only surface via consumer
  tests breaking.

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
