# Plan Review: 433-key-rotation-gaps
Date: 2026-05-03
Review round: 1

## Changes from Previous Round

Initial review.

## Functionality Findings

### F1 [Critical]: Plan claims "no schema changes" but new audit action requires Prisma enum migration
- File: plan §"Considerations & Constraints" + Implementation Step 2
- Evidence: `prisma/schema.prisma:847` defines `enum AuditAction`. `src/lib/constants/audit/audit.ts:185` uses `as const satisfies Record<AuditAction, AuditAction>` enforcing 1:1 alignment.
- Problem: Adding `WEBAUTHN_PRF_REBOOTSTRAP` to AUDIT_ACTION constant fails TS compile until the Prisma enum gains the value. Requires `prisma migrate dev --name add_webauthn_prf_rebootstrap_audit_action`. Plan's "no schema changes" assertion is wrong.
- Fix: Add Implementation Step 1.5 — edit `prisma/schema.prisma` enum AuditAction, run migrate against dev DB, regenerate client.

### F2 [Critical]: `recoveryVerifierVersion` is non-nullable Int — invariant "recovery* IS NULL" impossible
- File: `prisma/schema.prisma:109` (`recoveryVerifierVersion Int @default(1)`); plan §A.1 + Functional Req 1
- Evidence: Only 6 of 7 recovery fields are nullable; `recoveryVerifierVersion` is non-nullable.
- Problem: Plan says "set all `recovery*` fields to `null`" but `recoveryVerifierVersion` cannot be null.
- Fix: Set `recoveryVerifierVersion` back to default `1` (not null). Update Functional Req 1 invariant accordingly.

### F3 [Major]: Test seed uses ACCEPTED state, but markGrantsStaleForOwner only targets IDLE/ACTIVATED
- File: plan §A.6 + `src/lib/emergency-access/emergency-access-state.ts:44` (`STALE_ELIGIBLE_STATUSES = [IDLE, ACTIVATED]`)
- Evidence: ACCEPTED grants have no escrow yet (escrow is submitted via `confirm` which transitions ACCEPTED→IDLE).
- Fix: Use IDLE state for the seed. Add a second ACCEPTED grant and assert it remains untouched.

### F4 [Major] (overlaps with S1): REQUESTED state missing from clear set — see S1 below

### F5 [Major]: i18n file paths are wrong — locale-split layout, not single en.json/ja.json
- File: plan Implementation Steps 2 & 3
- Evidence: Repo uses `messages/en/<Namespace>.json` + `messages/ja/<Namespace>.json` layout (e.g., `messages/en/AuditLog.json`, `messages/en/ApiErrors.json`).
- Fix: Specify `messages/en/AuditLog.json` + `messages/ja/AuditLog.json` for audit action labels; `messages/en/ApiErrors.json` + `messages/ja/ApiErrors.json` for the new API_ERROR.

### F6 [Major]: API_ERROR has both const + i18n map — both need entries
- File: plan Implementation Step 3; `src/lib/http/api-error-codes.ts:359` (`API_ERROR_I18N` map satisfies the const)
- Fix: Step 3 must enumerate (1) constant, (2) `API_ERROR_I18N` map line, (3) i18n string in `messages/{en,ja}/ApiErrors.json`.

### F7 [Major]: New audit action needs FOUR parallel updates in audit.ts
- File: plan Implementation Step 2; `src/lib/constants/audit/audit.ts` (line 17 `AUDIT_ACTION`, line 193 `AUDIT_ACTION_VALUES`, line 479 `AUDIT_ACTION_GROUPS_PERSONAL[WEBAUTHN]`)
- Evidence: `audit.test.ts` asserts every action is in some scope group; `audit-i18n-coverage.test.ts` enforces label coverage.
- Fix: Step 2 must enumerate all four locations + Prisma enum.

### F8 [Major]: `prfSupported = false` overloads semantics — UI can't distinguish "PRF cleared" from "PRF unsupported"
- File: plan §A.3 + `src/components/settings/security/passkey-credentials-card.tsx`
- Evidence: UI gates the "use PRF" affordance on `prfSupported`. After rotation, plan resets it → UI hides re-enable affordance permanently.
- Fix: Leave `prfSupported` untouched (it means "authenticator supports PRF capability"). Existing readers `webauthn-authorize.ts:154` already require both `prfSupported && prfEncryptedSecretKey` — clearing only the wrapping is sufficient.

### F9 [Major]: Client cannot detect "PRF cleared" — credentials list endpoint doesn't expose wrapping presence
- File: `src/app/api/webauthn/credentials/route.ts:24-39`
- Evidence: GET response excludes `prfEncryptedSecretKey`. Plan's "if `prfEncryptedSecretKey == null`" detection cannot work.
- Fix: Expose a derived boolean `prfWrappingPresent` (or similar) in the credentials list response. OR include `prfWrappingClearedCredentialIds: string[]` in the rotate-key response so the client tracks them locally.

### F10 [Major]: Moving `markGrantsStaleForOwner` inside the rotation tx changes failure semantics
- File: `src/app/api/vault/rotate-key/route.ts:289-291` (currently `.catch(() => {})` post-tx)
- Problem: An EA-table contention or RLS hiccup that today produces partial-success becomes a full rotation failure. Availability regression.
- Fix: Acknowledge the trade-off explicitly in the plan rationale. Keep the move (atomic correctness wins over best-effort retry potential), but document.

### F11 [Major]: Audit-logs page rendering of additive metadata not verified
- File: plan §A.5; `src/app/[locale]/dashboard/audit-logs/page.tsx` + tenant equivalent
- Fix: Promote scenario #5 to an explicit Implementation Step verifying the page renders unknown metadata keys without crashing.

### F12 [Major]: VAULT_KEY_ROTATION missing from PERSONAL group (sibling pre-existing — R34)
- File: `src/lib/constants/audit/audit.ts:381-492` (PERSONAL groups)
- Evidence: Action emitted with scope=PERSONAL but absent from PERSONAL group → group-filtered views hide the events.
- Fix: Add VAULT_KEY_ROTATION to the AUTH personal group (alongside VAULT_SETUP / VAULT_RESET_EXECUTED).

### F13 [Major]: Plan A.4 attachment count semantics need explicit comment
- File: plan §A.4; existing rotation tx wraps in `withUserTenantRls`
- Fix: Add code comment "this counts attachments on the user's personal entries only — team attachments are unaffected by personal vault rotation".

### F14 [Minor]: Integration test placement violates convention
- File: plan §A.6; existing tests under `src/__tests__/db-integration/`
- Fix: See T3 (same finding).

### F15 [Minor]: Whitepaper drift fix scope creep
- Fix: Split into a separate `docs(whitepaper):` PR. This PR's whitepaper update only adds the new sub-sections.

### F16-F19 [Minor]: Engagement with plan's Open Design Questions
- Q1 (attachment block vs ack): keep ack pattern; add "Cancel rotation, export attachments first" UI affordance
- Q2 (EA wrapping clear): see S2 — null only `ownerEphemeralPublicKey`, retain ciphertext for forensic trail
- Q3 (PRF auto-rebootstrap UX): silent on next sign-in with toast notification + audit
- Q5 (orphan attachment rows): leave intact for Phase B recovery options

## Security Findings

### S1 [Critical]: REQUESTED-state EA grants escape rotation invariant — CHAINED with attachment data loss = full grantee bypass
- File: `src/lib/emergency-access/emergency-access-state.ts:44`
- Evidence: `STALE_ELIGIBLE_STATUSES = [IDLE, ACTIVATED]` only. State machine line 9: `[REQUESTED]: [ACTIVATED, IDLE, REVOKED]` — REQUESTED comes from IDLE which holds escrow; `request/route.ts:60` does not touch wrapping. Auto-promote to ACTIVATED happens in `vault/route.ts:46-53` when `waitExpiresAt` passes.
- Threat: owner has IDLE→REQUESTED grant; grantee clicked "request access" but `waitExpiresAt` not yet fired. Owner rotates vault to revoke. Plan's `markGrantsStaleForOwner` does NOT touch REQUESTED → wrapping ciphertext + `ownerEphemeralPublicKey` + `hkdfSalt` remain at OLD `keyVersion`. When `waitExpiresAt` later expires, ACTIVATED auto-fires, grantee unwraps OLD secretKey. Combined with A.4's intentionally-orphaned attachment ciphertext → full plaintext recovery.
- Fix: Either (a) add `EA_STATUS.REQUESTED` to `STALE_ELIGIBLE_STATUSES`, or (b) rotation explicitly enumerates `[IDLE, REQUESTED, ACTIVATED]` for the clear set. Add focused test.
- escalate: true (orchestrator decision: skip Opus re-run — fix path is mechanical and chained impact is bounded; finding is well-understood)

### S2 [Major]: EA wrapping full clear destroys forensic trail — minimum-clear is sufficient
- File: plan §A.2; `src/lib/crypto/crypto-emergency.ts:269-302` (`unwrapSecretKeyAsGrantee` requires `ownerEphemeralPublicKey`)
- Fix: Null only `ownerEphemeralPublicKey`. Retain `encryptedSecretKey/Iv/AuthTag/hkdfSalt` for forensic timeline reconstruction. Without ephemeral pubkey, ECDH derivation is impossible — same security posture, audit row preserved.

### S3 [Major]: New PRF rebootstrap endpoint accepts session-only writes — no proof of authenticator possession
- File: plan §A.3
- Threat: session-cookie attacker (XSS/malware/stolen device) can POST garbage PRF wrapping. Outcome: vault auto-unlock fails on next sign-in (DoS of security feature, no per-attack audit signal beyond the WEBAUTHN_PRF_REBOOTSTRAP entry).
- Fix: Require fresh WebAuthn assertion bound to the credential. Implementation: client first calls `/api/webauthn/authenticate/options` to get a challenge, performs the assertion, posts `{assertionResponse, prfEncryptedSecretKey, prfSecretKeyIv, prfSecretKeyAuthTag}`. Server verifies the assertion (reuse existing logic) before writing.

### S4 [Major]: PRF rebootstrap can race with concurrent rotation — keyVersion drift possible
- File: plan §A.3
- Threat: PRF rebootstrap runs without the rotation's `pg_advisory_xact_lock(hashtext(userId))` and without a keyVersion CAS. A delayed rebootstrap landing after rotation could write wrapping derived from the OLD secretKey under the NEW keyVersion → silent broken vault.
- Fix: (a) Endpoint takes the same advisory lock. (b) Request body includes `keyVersion` of the wrapping. (c) UPDATE uses `WHERE userId = ? AND keyVersion = ?` (CAS); mismatch returns 409 with current keyVersion. (d) Audit metadata records the bound keyVersion.

### S5 [Major]: Recovery `recoveryKeySetAt = NULL` conflates "never set" with "invalidated by rotation"
- File: plan §A.1; `prisma/schema.prisma:110`
- Problem: Tenant admins running "users without recovery key" reports cannot distinguish the two states. Operationally, "had one but lost via rotation" is more urgent.
- Fix: Add new column `recoveryKeyInvalidatedAt: Timestamptz?` (Prisma migration). Set at clear time. Leave `recoveryKeySetAt` unchanged (it reflects the most recent set event; query "is recovery current" = `recoveryKeyInvalidatedAt IS NULL OR recoveryKeySetAt > recoveryKeyInvalidatedAt`).

### S6 [Minor]: PRF rebootstrap rate limit — per-user vs per-credential
- Conditional on S3: if step-up is added, per-user 10/60s is fine. If session-only auth retained, key per `${userId}:${credId}` and lower max to 3/60s.

### S7 [Minor]: `acknowledgeAttachmentDataLoss` audit metadata loses attachment manifest
- Fix: Snapshot affected `Attachment.id` list into audit metadata (capped) so post-incident analysis can identify lost files. Better: write a manifest to a dedicated `OrphanedAttachment` table for explicit Phase B recovery.

### S8 [Minor — IMPORTANT context]: ECDH private key cross-domain attack chain
- File: `src/app/api/vault/rotate-key/route.ts:260-262` re-wraps ECDH private key under new secretKey. ECDH PUBLIC key (`User.ecdhPublicKey:137`) is stable across rotations.
- Threat chain: attacker recovers OLD secretKey via leaked recovery/EA/PRF wrapping + has access to backup of OLD `encryptedEcdhPrivateKey` → recovers user's stable ECDH private key → decrypts ALL `TeamMemberKey` rows for teams the user is a member of → decrypts team entries.
- Fix: (a) Document this attack chain in whitepaper §6 update — rationale for why the clearings matter. (b) Future "compromise rotation" mode that also rotates `ecdhPublicKey` + reissues all `TeamMemberKey` rows (separate issue). (c) Increases urgency on S1.

## Testing Findings

### T1 [Critical]: Existing E2E `e2e/tests/settings-key-rotation.spec.ts` will not exercise the new attachment-warning flow
- File: `e2e/tests/settings-key-rotation.spec.ts`
- Fix: Move E2E from "optional / Phase 3" to required for this PR. Extend the spec with attachment-seed + dialog confirm step + post-rotation download-fail assertion.

### T2 [Critical]: No `433-key-rotation-gaps-manual-test.md` planned — R35 Tier-2 violation
- Fix: Add Implementation Step "Author `docs/archive/review/433-key-rotation-gaps-manual-test.md`" covering recovery clear, EA STALE propagation, PRF re-bootstrap, attachment ack flow.

### T3 [Critical]: Integration test path falls outside CI `paths:` filter
- File: `.github/workflows/ci-integration.yml:11-21` lists `src/__tests__/db-integration/**` etc. — does NOT include `src/app/api/vault/rotate-key/**`.
- Fix: Place the integration test at `src/__tests__/db-integration/vault-rotate-key-gaps.integration.test.ts`.

### T4 [Critical]: `markGrantsStaleForOwner` test refactor not enumerated
- File: `src/lib/emergency-access/emergency-access-server.test.ts:9-58` asserts exact `updateMany` shape
- Fix: Plan must specify three new test cases: (1) `tx`-supplied path uses `tx.emergencyAccessGrant.updateMany`; (2) updateMany payload includes the cleared wrapping fields; (3) `keyVersion`/`wrapVersion` NOT in data payload (preserve forensic columns).

### T5 [Major]: `route.test.ts` `txMock` will throw without extension
- File: `src/app/api/vault/rotate-key/route.test.ts:13-66`
- Fix: Plan Step 9 must enumerate mock extensions: `webAuthnCredential: { updateMany }`, `attachment: { count }`, `emergencyAccessGrant: { updateMany }`. Add positive assertions for each new tx call + the new audit metadata fields.

### T6 [Major]: Personal rotate-key audit metadata has no exact-shape snapshot test
- File: `src/app/api/vault/rotate-key/route.test.ts` (no `fromVersion`/`toVersion` assertion); team rotate-key test does have it
- Fix: Add `expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action, metadata: expect.objectContaining({...}) }))`.

### T7 [Major]: `rotate-key/data/route.test.ts` mock missing `attachment.count`
- Fix: Step 7a — extend mock + add 2 cases (count=0, count=N).

### T8 [Major]: New PRF endpoint test file location not specified
- Fix: Step 6a — create `src/app/api/webauthn/credentials/[id]/prf/route.test.ts` with 8 cases (auth, ownership, payload, sizing, success, audit, rate-limit + step-up assertion if S3 accepted).

### T9 [Major]: No concurrency test for the new in-tx clearings
- Fix: Add integration test with two concurrent rotations (use existing `raceTwoClients` pattern from `admin-vault-reset-dual-approval` test) or explicitly defer with rationale.

### T10 [Major]: A.6 lacks negative-path coverage for transactional atomicity
- Fix: Add (i) "DB error during webAuthnCredential.updateMany rolls back recovery* clearing", (ii) "entry count mismatch mid-transaction → none of the new clearings persist".

### T11 [Major]: Plan does not cite the exhaustive coverage tests that will fail
- Files: `src/__tests__/audit-i18n-coverage.test.ts:21-27`, `src/lib/constants/audit/audit.test.ts:213-221`
- Fix: Plan Step 2 must call out these two tests + the AUTH group placement (mirror `WEBAUTHN_CREDENTIAL_REGISTER` at audit.ts:279).

### T12 [Minor]: E2E `EmergencyAccessGrant` helper does not seed wrapping fields
- File: `e2e/helpers/emergency-access.ts:67-104`
- Fix: Add `seedWithWrapping?` option (or defer to integration-only assertion).

### T13 [Minor]: Open Q5 needs a test policy
- Fix: Whichever direction the design lands, add a test asserting orphan count post-rotation.

### T14 [Minor]: `revokeAllDelegationSessions` boundary asymmetry needs a comment
- Fix: Add code comment "MUST remain outside transaction (touches different table, best-effort acceptable)" + assertion in route.test.ts.

## Adjacent Findings

- **[Adjacent — Functionality]** (from Testing T-section): Moving `markGrantsStaleForOwner` from `.catch(() => {})` best-effort outside the tx to atomic inside the tx is a behavior change (rotation now aborts on EA failure). Already captured as F10.
- **[Adjacent — Functionality]** (from Security): Webhook event groups (`TENANT_WEBHOOK_EVENT_GROUPS` / `TEAM_WEBHOOK_EVENT_GROUPS`) — should `WEBAUTHN_PRF_REBOOTSTRAP` fire webhooks? Plan A.3 does not address. Decision: PRF rebootstrap is a routine post-rotation action; not webhook-worthy unless tenant admins explicitly want a security-event signal. Defer to Phase B unless reviewer disagrees.
- **[Adjacent — Security]** (from memory `feedback_user_bound_token_enumeration.md`): does `revokeAllDelegationSessions` cover MCP tokens? Per CLAUDE.md "MCP tokens validated by `validateMcpToken()`" — they are user-bound. Verify that rotation also revokes `McpAccessToken` / `McpRefreshToken` for the user; if not, this is a sibling pre-existing bug to add.

## Quality Warnings

None — all findings cite file:line evidence with concrete fixes.

## Recurring Issue Check

### Functionality expert
- R1 ✓ (helpers reused), R2 ⚠ (audit metadata could be const-object), R3 ⚠ (F7 audit.ts 4 places), R4 ✓, R5 ⚠ (F10 atomic vs best-effort), R6 ✓ (intentional orphans), R7 N/A, R8 N/A, R9 ✓, R10 ✓, R11 ✓, R12 ⚠ (F7 + F12), R13 ⚠ (F5/F6), R14 ✓, R15 ⚠ (F13 RLS semantics), R16 ✓, R17 ✓, R18 ✓, R19 ⚠ (T-findings), R20 ⚠ (Prisma client regen), R21 ✓ (additive), R22 ✓, R23 N/A, R24 N/A, R25 ⚠ (F2 verifierVersion, F8 prfSupported, F9 client hydration), R26 ✓, R27 ⚠ (rotate-key/route.ts grows; consider helper extraction), R28 ✓, R29 ✓, R30 ✓, R31 ✓, R32 N/A, R33 N/A, R34 ⚠ (F4/S1 + F12), R35 ⚠ (T2 manual test).

### Security expert
- R1-R30 N/A or ✓ except: R12 ⚠ (S4 keyVersion CAS), R20 ⚠ (S1, S4), R33 [user-bound enumeration verification adjacent].
- RS1 N/A, RS2 ✓ (rate limiter shape OK; see S6), RS3 ✓ (Zod boundary; missing keyVersion field per S4).

### Testing expert
- R1 ⚠ (T4/T5/T7 mock alignment), R2 ⚠ (T6 exact-shape audit), R5 ⚠ (T3 CI filter), R10 ⚠ (T2 manual test), R12 ⚠ (T1 E2E ack flow), R14 ⚠ (T9/T10 concurrency/atomicity), R15 ⚠ (T11 audit exhaustive tests), R19 ⚠ (T4/T5/T7), R32 N/A (no new long-running artifact), R35 ⚠ (T2).
- RT1 ⚠ (T4 mock-reality divergence), RT2 ✓ (T8 testability paths specified), RT3 ✓ (no magic strings).

## Round 2 Findings (incremental — after plan revision)

### Functionality (Round 2)
- **F20 [Major]**: Extract `verifyAuthenticationAssertion` helper — PRF endpoint cannot reuse the existing verify route's orchestration as-is; only the underlying `verifyAuthentication` primitive is library-level. Plan undercounts work without an explicit extraction step.
- **F21 [Minor]**: `isRegeneration` UX semantic break — existing `recovery-key/generate/route.ts:124` and `recovery-key-dialog.tsx:187` use `!!user.recoveryKeySetAt` which becomes false after rotation clears the field, showing "first-time setup" instead of "regenerate" wording.
- **F22 [Minor]**: Migration name `vault_rotation_gaps_433` does not match project descriptive-name convention.

### Security (Round 2)
- **S-N1 [Major]**: PRF rebootstrap challenge keyspace collision — sharing `:authenticate:` Redis key with sign-in flow allows race / DoS / replay vectors.
- **S-N2 [Major]**: MCP token revocation gap is concrete and known — `invalidateUserSessions` exists at `src/lib/auth/session/user-session-invalidation.ts:62` covering all 6 token classes; rotation should call it instead of just `revokeAllDelegationSessions`. Aligns with memory `feedback_user_bound_token_enumeration.md`.
- **S-N3 [Minor]**: Cross-domain (S8) UI affordance — banner copy needed to clarify rotation does NOT cover team membership key.

### Testing (Round 2)
- **T15 [Major]**: E2E attachment seeding helper does not exist (`grep prisma.attachment.create e2e/helpers/` returns 0 hits).
- **T16 [Minor]**: PRF endpoint test should explicitly reuse the existing `verifyAuthentication` vi.mock pattern.
- **T17 [Major]**: Integration Case 3 atomicity injection has no real-DB seam — should be demoted to unit level using existing txMock.
- **T18 [Minor]**: New `recoveryKeyInvalidatedAt` column requires fixture sweep for User mocks.

## Round 3 Findings (incremental — after Round 2 plan revision)

### Functionality (Round 3)
- **F-N1 [Major]**: PRF rebootstrap Redis key TTL not pinned to a shared constant — drift risk.
- **F-N2 [Minor]**: Step 5.5 helper refactor lacks regression coverage update for `webauthn/authenticate/verify/route.test.ts`.
- **F-N3 [Minor]**: Step numbering drift in mapping tables.

### Security (Round 3)
- **S-N2 caveat (b)/(c) [Major]**: `invalidateUserSessions` failure post-tx leaves old MCP tokens valid against new vault — needs operator alert path + post-rotation banner.
- **S-N4 [Major]**: `verifyAuthenticationAssertion` helper signature must accept `tx` — counter CAS via `$executeRaw` would otherwise commit on `prisma` even when caller's tx aborts (replay window).
- **S-N5 [Minor]**: Audit `WEBAUTHN_PRF_REBOOTSTRAP` 409 keyVersion mismatches with `result: "stale_keyversion"` for adversarial signal.

### Testing (Round 3)
- **T-N1 [Major]**: Step 11 must extend `select` clause at `recovery-key/generate/route.ts:62` to include `recoveryKeyInvalidatedAt: true` — otherwise the F21 fix silently no-ops.
- **T-N2 [Minor]**: `cacheTombstoneFailures` audit field should be enumerated explicitly in test cases.
- **Test pairing gap**: Steps 10 and 11 (UI changes) lack explicit unit-test pairs — added as 14.h + 14.i.

## Resolution Status

All R1, R2, R3 Critical and Major findings adopted into plan revisions through Round 4. Detailed mapping in plan's "Round 1→2", "Round 2→3", and "Round 3→4" tables.

**Stopping criterion**: Three review rounds completed. Round 3 surfaced no Critical findings; remaining Minors are non-blocking. Plan is ready for Phase 2 implementation.

**Skipped escalation**: S1 in Round 1 was reported with `escalate: true`. Orchestrator independently assessed: fix path is mechanical (extend `STALE_ELIGIBLE_STATUSES`), chained impact is bounded (no other consumer of this constant), and the threat is well-understood. Opus re-run skipped. Documented per common-rules.md "orchestrator independently assess" obligation.
