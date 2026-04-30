# Plan Review: admin-vault-reset-dual-approval
Date: 2026-04-29T23:20:00+09:00
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

### F1 Major: NotificationType is a Postgres enum requiring ALTER TYPE migration step
- File: `prisma/schema.prisma` (NotificationType), plan §"Notifications" + step 2.2
- Evidence: `enum NotificationType` is a Prisma enum compiled to Postgres ENUM. Pre-existing migration `prisma/migrations/20260305010000_tenant_vault_reset_revoke/migration.sql:6` uses `ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_VAULT_RESET_REVOKED'`.
- Problem: Plan step 2.2 only mentions the TS constant; the schema migration counterpart is absent. Without `ALTER TYPE` the new initiate path errors at runtime.
- Impact: Initiate endpoint runtime failure on the new admin notification path.
- Fix: Add to step 1 / 2.2: `ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_VAULT_RESET_PENDING_APPROVAL';` in the same migration. Note: `ALTER TYPE ... ADD VALUE` is non-transactional in Postgres — must run outside the transaction wrapper.

### F2 Major: Revoke endpoint will fire a "your reset was revoked" notification to a target user who never knew the reset existed
- File: `src/app/api/tenant/members/[userId]/reset-vault/[resetId]/revoke/route.ts:101-114`; plan FR8 + Scenario 5
- Evidence: existing revoke creates `NOTIFICATION_TYPE.ADMIN_VAULT_RESET_REVOKED` to target + email. Plan defers initial notification to approve. A `pending_approval` reset that gets revoked still fires the revoked-notification.
- Problem: FR8 invariant "target was never told before approval" breaks at revoke time.
- Impact: UX confusion + Scenario 5 leaks attempted-attack signal to victim before incident response is ready.
- Fix: Make revoke conditional on `approvedAt`: only notify/email target if `approvedAt != null`. Add to step 7.

### F3+S2 Major: Cross-tenant session-invalidation gap (raised by both Functionality and Security)
- File: `src/lib/auth/session/user-session-invalidation.ts:14-39`; `src/lib/vault/vault-reset.ts`; plan FR7 + step 6.2
- Evidence: helper requires `{ tenantId }` and applies `tenantFilter`. `executeVaultReset(targetUserId)` deletes ALL `passwordEntry`, `vaultKey`, `tag`, `folder` where `userId = targetUserId` (no tenant filter). `Session.tenantId` is per-row.
- Problem: A target who is a `TenantMember` of multiple tenants keeps sessions in T2/T3 alive after T1 reset.
- Impact: A compromised session in another tenant can re-authenticate the user (re-setup vault, re-accept share-links) violating FR7.
- Fix: Either (a) drop the tenantId filter when called from the vault-reset path, (b) loop over all `TenantMember.tenantId` for the target user, or (c) extend `invalidateUserSessions` with `allTenants: true`. Document choice + ADR for cross-tenant session retention.

### F4+F9 Major: i18n status-key mapping breaks for new states + plan cites wrong file
- File: `src/components/settings/security/tenant-reset-history-dialog.tsx:137`; plan FR11, step 9.1, step 9.3
- Evidence: existing template `t(\`status\${r.status.charAt(0).toUpperCase() + r.status.slice(1)}\`)` produces `statusPending_approval` for `pending_approval`. Plan step 9.3 says "AdminConsole.json"; consuming component reads from `messages/en/TenantAdmin.json:19-22` which contains `statusPending`/`statusExecuted`/...
- Problem: 5-state UI does not render correctly without code change; key-naming convention undefined; plan cites wrong i18n file.
- Impact: Runtime missing-key error.
- Fix: (a) add explicit mapping `pending_approval → statusPendingApproval`, `approved → statusApproved` (or rename status enum to camelCase); (b) update step 9.3 to specify `messages/{en,ja}/TenantAdmin.json`.

### F5+T3 Major: Response-shape breaking change + R19 exact-shape tests not enforced
- File: `src/app/api/tenant/members/[userId]/reset-vault/route.ts:213-217`, `route.test.ts:478-494`; plan response shape + step 8 + step 11.3
- Evidence: existing GET returns `pending|executed|revoked|expired`. New shape returns `pending_approval|approved|...`. The `pending` value is renamed, not just additive. Existing test uses `toHaveProperty` (subset assertion) at lines 485-493; status assertions at 395-465 use `toMatchObject`.
- Problem: External consumers switching on `status === "pending"` silently break. Subset assertions silently pass after the new fields land — regression in approvedAt/approvedBy serialization is invisible.
- Impact: Stale CLI/extension/external consumers break. Test suite cannot detect approvedAt/approvedBy mistakes.
- Fix: (a) grep for `"pending"` in CLI / extension / docs; either keep `pending` as back-compat alias OR document breaking change + bump REST API v1 version; (b) flip lines 478-494 to `expect(json[0]).toEqual({...comprehensive shape including approvedAt + approvedBy})`; (c) add tests for "derives pending_approval" and "derives approved" branches; (d) add test asserting `approvedBy` is null for pending and `{name, email}` for approved.

### F6 Major: DB column grants for new admin_vault_resets columns (R14)
- File: plan step 1
- Evidence: CLAUDE.md describes three DB roles (`passwd_app`, `passwd_user`, `passwd_outbox_worker`). New columns `approvedAt`, `approvedById`, `encryptedToken` are added; the plan does not verify the existing GRANT pattern.
- Problem: If existing pattern is column-scoped, new columns are unreadable/unwritable from `passwd_app`.
- Impact: Possible runtime failure on initiate (write encryptedToken) + GET history (read approvedById/approvedAt).
- Fix: Add sub-step to step 1 — verify grant pattern; add column-level grants if needed, or note "table-scoped grant covers new columns".

### F7+S4 Major: Approve-path ordering — decrypt-fail-after-CAS leaves a phantom approval
- File: plan step 5.2; security checklist (key rotation gap)
- Evidence: Step 5.2 reads "On success: decrypt encryptedToken, send target user's email + in-app notification, emit ADMIN_VAULT_RESET_APPROVE audit." If decrypt fails after CAS (e.g., key rotation gap during 24h window), row is `approved` but target never receives email.
- Problem: Step 5.2 ordering not idempotent / recoverable.
- Impact: Phantom approval; only mitigation is manual revoke + re-initiate.
- Fix: Reorder step 5.2: (1) decrypt FIRST (cheap, no side effects); on failure return 500 `RESET_TOKEN_DECRYPT_FAILED` and leave row PENDING. (2) CAS. (3) Send email + notification (best-effort, logged on failure). (4) Emit audit. Add operator runbook note: "drain pending resets before key rotation".

### F8+S5 Minor: Backfilled legacy rows with `approvedById = initiatedById` create an audit-trail invariant
- File: plan NFR3 + Approve CAS (FR4)
- Evidence: NFR3 sets `approvedById = initiatedById` for legacy rows. New rows enforce `initiatedById: { not: actor.id }`.
- Problem: Future SOC2/audit-export consumer cannot distinguish "post-deploy self-approved (impossible)" from "legacy-pre-deploy backfilled".
- Impact: Compliance pipelines see a gap for legacy rows (no `_APPROVE` audit event).
- Fix: (a) document the sentinel invariant in NFR3 explicitly, OR (b) emit a one-shot synthetic `ADMIN_VAULT_RESET_APPROVE` audit at backfill time with `metadata.legacyBackfill: true`.

### F10 Minor: Plan implies pendingResets count change but query already counts approved rows
- File: `src/app/api/tenant/members/route.ts` (no `approvedAt` filter); plan step 9.2
- Evidence: existing groupBy filters `executedAt: null, revokedAt: null, expiresAt > now`. After the schema change, `pending_approval` and `approved` both match.
- Problem: Step 9.2 implies a code change that is not actually needed.
- Fix: Step 9.2 → "Verify pendingResets query already counts approved rows; update test fixtures if they pin `approvedAt: null`."

### F11 Minor: CAS WHERE on execute conflates "not approved" with other CAS failures
- File: plan step 6.1; `src/app/api/vault/admin-reset/route.ts:99-119`
- Evidence: today, CAS count=0 returns `VAULT_RESET_TOKEN_USED` 410. Adding `approvedAt: { not: null }` to CAS makes a not-yet-approved row also fall into the 410 branch.
- Problem: Wrong status code returned for not-approved case.
- Fix: After `findUnique`, BEFORE CAS, add: `if (resetRecord.approvedAt === null) return 409 VAULT_RESET_NOT_APPROVED`. CAS WHERE additionally enforces this for safety.

### F12 Minor: Audit metadata `pendingApproval: true` duplicates state already in column
- File: plan step 4.4
- Evidence: plan §"Why no status enum" emphasizes "deriving from approvedAt keeps the convention". Storing `pendingApproval: true` in audit metadata duplicates info already in `approvedAt: null`.
- Fix: Drop `pendingApproval: true` from initiate metadata; store `resetId` and `expiresAt` instead.

### F13 Minor: Approve emails the target with a token created up to 24h ago — no expiresAt reset
- File: plan FR5
- Evidence: TTL = `createdAt + 24h`. Approve at hour 23 gives target only 1h.
- Fix: (a) reset `expiresAt = approvedAt + EXECUTE_TTL_MS`, OR (b) include precise expiry in approval email body. Decide and add to step 5.2 / FR5.

### F15 Minor: step 11.1 vs 11.4 contradiction about CAS race tests (R5)
- File: plan steps 11.1 + 11.4
- Evidence: 11.1 lists "CAS race wins/loses" under Unit (mocked Prisma). 11.4 says "No mocked-DB tests for the parallel approve race — mocks pass vacuously".
- Fix: 11.1 → "CAS happy path + each WHERE-clause-rejection branch". Move actual race assertions to 11.2 (real DB).

### F16 Minor: Approve when initiator's TenantMember has been deactivated since initiate
- File: plan FR2 + FR3 + step 5.1
- Problem: No requirement covers "what if initiator's TenantMember was deactivated/role-downgraded after initiate?". Pending row persists; CAS only checks `initiatedById: { not: actor.id }`.
- Fix: Either document "approval succeeds even if initiator is now deactivated" OR add a deactivation hook that revokes pending resets.

### F17 Minor: AAD format `${tenantId}:${resetId}` lacks delimiter-escape documentation
- File: plan step 3.2
- Fix: Add comment in `admin-reset-token-crypto.ts` noting UUID-only assumption (covered by F14+S1 fix).

## Security Findings

### S1 Major: AAD lacks domain separator in shared envelope helper
- File: plan step 3.2; `src/lib/crypto/account-token-crypto.ts:38-39`
- Evidence: existing AAD = `${provider}:${providerAccountId}`; plan adopts `${tenantId}:${resetId}` for the new helper, both consuming the same shared envelope and master key.
- Problem: shared helper without per-caller domain prefix invites future cross-subsystem ciphertext substitution (DB-write attacker swaps `account_tokens.encrypted` into `admin_vault_resets.encrypted_token` if AADs ever overlap on a UUID).
- Impact: Cross-subsystem ciphertext substitution via DB-write attacker.
- Fix: Require a `domain: string` parameter prepended with `\x00` in the shared envelope helper. Set `"admin-reset-token-v1"` and `"account-token-v1"` respectively. Updates `src/lib/crypto/envelope.ts` signature.

### S3 Major: Email-channel token disclosure window enables attacker who already controls target's email
- File: plan FR8 + step 5.2
- Evidence: post-approval email contains plaintext URL+token; valid for up to 24h; sits in target mailbox + SMTP relay logs.
- Problem: dual-admin gate prevents destruction by a rogue admin alone but does NOT protect against the case where the target's email is compromised — the attacker just intercepts the post-approval email and redeems the URL themselves.
- Impact: Attacker controlling target's email box → fresh attacker-controlled vault under victim identity.
- Fix: (a) require step-up at execute (session must originate from passkey/SSO, not email magic-link), OR (b) shorten effective TTL to ~1h after approval, OR (c) bind email to AAD (see S9). Recommend (b) + (c).

### S6 Minor: Pending-approval notification broadcast surface
- File: plan steps 4.3 + 10.1
- Problem: notification body discloses `target.email` to every OWNER/ADMIN. Acceptable within tenant trust boundary (admins already see member emails) but worth confirming with design review since the existing `ADMIN_VAULT_RESET` notification was target-only.
- Fix: Explicitly restrict to admins with `MEMBER_VAULT_RESET` permission rather than role >= ADMIN (verify the gate).

### S7 Minor: EXPIRE state transition has no audit entry
- File: plan FR9 (lists INITIATE/APPROVE/EXECUTE/REVOKE — omits EXPIRE)
- Problem: A malicious admin can probe the dual-approval flow by initiating then letting it expire, leaving only the INITIATE row.
- Fix: Emit a sweep audit (e.g., periodic `ADMIN_VAULT_RESET_EXPIRE` lazily computed on read, emit-once via a flag column), OR document the gap explicitly.

### S8 Minor: Backfill self-approves legacy PENDING rows, bypassing FR4 for any in-flight reset at deploy
- File: plan NFR3 + step 1.2
- Problem: Any legacy row with `expiresAt > now` becomes `approved` with `approvedById = initiatedById`. Email-in-mailbox tokens become redeemable without dual approval post-deploy.
- Fix: Add deployment checklist: drain or revoke all `executed_at IS NULL AND revoked_at IS NULL AND expires_at > now()` rows before merge.

### S9 Minor: Target email is re-fetched at approve but not bound to AAD or snapshot
- File: plan Risks table
- Problem: Attacker who races email-change between initiate and approve redirects the reset URL to attacker-controlled mailbox. Compounds S3.
- Fix: Snapshot `targetEmailAtInitiate` and refuse approval if email changed, OR bind email into AAD: `${tenantId}:${resetId}:${targetEmailAtInitiate}`.

## Testing Findings

### T1 Critical: Parallel-approve integration test must be true concurrency, not interleaved sequential
- File: plan step 11.2 + NFR2
- Evidence: Step 11.2 says "two parallel approve calls — only one wins". Does not specify HOW (Promise.all under one client? distinct Prisma clients? barrier?).
- Problem: A common false-pass shape is `await approve(); await approve();` — sequential under a single client. With CAS this still produces (1,0), but does NOT exercise concurrency the test claims to validate; reordering bug would still pass. (project_integration_test_gap memory note.)
- Impact: NFR2's only safety net is a vacuously passing test.
- Fix: Step 11.2 must REQUIRE: (a) two distinct Prisma client instances (separate `pg.Pool` connections), (b) `pg_advisory_lock` barrier so both calls enter at once, (c) loop ≥10 iterations, (d) assert exactly one count===1 and one count===0 AND `approvedById` is one of the two actor ids. Cite `pepper-dual-version.integration.test.ts` as precedent.

### T2 Critical: Migration backfill not exercised against non-empty DB; NFR3 mentions phantom `approvalRequiredAt` column
- File: plan step 1.2-1.3 + NFR3
- Evidence: Step 1.3 is a manual UI check, not an automated test. NFR3 prescribes `approvalRequiredAt = createdAt + 24h` but Schema definition omits any `approvalRequiredAt` column AND step 1.2 SQL omits it too.
- Problem: No regression test for the backfill. NFR3 vs schema contradiction blocks the test from being authored.
- Impact: A future developer changing the migration cannot detect broken legacy semantics; only signal is a manual check that does not run in CI.
- Fix: (a) Add integration test `src/__tests__/db-integration/admin-vault-reset-migration.integration.test.ts` that seeds 3 legacy rows in pre-migration shape (PENDING/EXECUTED/REVOKED), runs the data-backfill UPDATE, asserts `deriveResetStatus()` matches expected post-state. (b) Reconcile NFR3 vs step 1.2 SQL — drop the `approvalRequiredAt` reference from NFR3.

### T4 Major: Audit-action-group exhaustive test extension is implied but not pinned to the four group locations
- File: `src/lib/constants/audit/audit.test.ts:201`; plan §"Audit log" + step 2.1
- Evidence: `audit.test.ts` does NOT contain an exhaustive group-membership assertion for ADMIN_VAULT_RESET_*. Existing tests at 79-90 only check "every grouped action is a valid action" (one-direction inclusion). Plan points at line 201 — a NEGATIVE assertion for TEAM_WEBHOOK groups.
- Problem: APPROVE could be omitted from one of the four group arrays (especially the ambiguous line 512-513) with no test failing.
- Fix: Step 2.1 must add an explicit positive test asserting all 4 ADMIN_VAULT_RESET_* actions belong to each of the 4 group sites (with a documented decision about line 512-513).

### T5 Major: Mock-reality divergence (RT1) on `invalidateUserSessions` return value
- File: `src/lib/auth/session/user-session-invalidation.test.ts:63`; plan step 6.3
- Evidence: real helper returns `{ sessions, extensionTokens, apiKeys }`. Plan names audit metadata `invalidatedSessions, invalidatedExtensionTokens, invalidatedApiKeys`. Plan does not specify the route maps source-truth keys → renamed audit keys.
- Problem: Mock writers will return whatever shape the audit metadata expects → the REAL helper returns `{ sessions }` → audit metadata silently `undefined`.
- Fix: Plan must specify the mapping in step 6.2/6.3 AND require the unit test to mock with the REAL helper's shape and assert the audit metadata translates correctly.

### T6 Major: No test specified for the new `encryptedToken` lifecycle (NULL on revoke + NULL on execute)
- File: plan steps 6.4 + 7
- Fix: Add unit-test assertions on `updateMany` `data` for both revoke + execute routes (`expect.objectContaining({ encryptedToken: null })`), plus an integration test confirming the column actually becomes NULL.

### T7 Major: Encrypted-token round-trip test for `admin-reset-token-crypto.ts` not enumerated
- File: plan step 3.2
- Evidence: Plan step 11.1 mentions "encrypted-token decrypt happy path" only inside the approve route test (mocked). No dedicated test file mirroring `account-token-crypto.test.ts`.
- Fix: Require `src/lib/vault/admin-reset-token-crypto.test.ts` mirroring `account-token-crypto.test.ts` 1:1 (round-trip, random IV, sentinel matcher, null/undefined input, AAD mismatch, malformed ciphertext, tampered tag — 7 cases). Assert `account-token-crypto.test.ts` continues to pass with zero edits post-R22-refactor of the shared envelope.

### T8 Major: Notification messages exhaustive test not pinned for the new NOTIFICATION_TYPE
- File: plan §"Notifications" + steps 2.2, 10.1
- Evidence: Plan says "exhaustive test should already cover all NOTIFICATION_TYPE_VALUES entries" but does not name the test file (likely `notification-messages.test.ts` per ls of `src/lib/notification/`).
- Fix: Step 2.2 must name the file, assert exhaustive `NOTIFICATION_TYPE_VALUES` coverage in BOTH `en` and `ja`. Create the test if missing.

### T9 Minor: `tenant-reset-history-dialog` test not enumerated for 5-state coverage
- File: plan step 9.1
- Fix: Add component test enumerating all 5 statuses × 2 actor relationships (10 render paths), asserting Approve button visibility per FR10 + R26 disabled-cue rule.

### T10 Minor: Notification recipients test for "OTHER tenant admins" race semantics undefined
- File: plan step 4.3
- Fix: Add 3 unit tests for the initiate route covering recipient-set edge cases (zero other admins, multiple admins, OWNER+ADMIN mix).

### T11 Minor: Manual test plan adversarial scenarios miss FR7 multi-device probe
- File: plan step 12
- Fix: Add explicit FR7 multi-device probe to manual-test artifact (sign in 3 browsers, run dual-approval + execute from one, verify all 3 receive 401 within `TOMBSTONE_TTL_MS`).

### T12 Minor: Shared constants in tests (RT3) — "APPROVE" / "DELETE MY VAULT" literal sprawl
- File: plan step 11
- Fix: Export `VAULT_CONFIRMATION_PHRASE.{APPROVE,DELETE_VAULT}` constants; refactor existing route + test to consume them in this PR.

## Adjacent Findings

- F14 [Adjacent → Security]: encrypted token storage shares share-master KeyProvider — covered as S1.
- T13 [Adjacent → Functionality]: `approvalRequiredAt` referenced in NFR3 but missing from schema — covered as T2.

## Quality Warnings

- F9 [VAGUE]: pinpointed in F4+F9 merged finding now explicitly cites file path.
- T12 [VAGUE]: clarified to specify `VAULT_CONFIRMATION_PHRASE.APPROVE` constant name and refactor scope.
- T8 [NO-EVIDENCE]: file path candidate `src/lib/notification/notification-messages.test.ts` cited; plan revision must verify existence.
- T5 [UNTESTED-CLAIM]: fix specifies "require unit test to mock with real helper's shape" — adds the verification.

## Recurring Issue Check

### Functionality expert
- R1 (shared utility reuse): Checked — plan extracts envelope helper. No issue.
- R2 (request lifecycle / proxy): N/A — no proxy or CSP changes.
- R3 (pattern propagation): F4 + F2.
- R4 (state-machine completeness): Checked.
- R5 (mocked tests pass vacuously): F15.
- R6 (TOCTOU/CAS): Checked.
- R7 (FK cascade): Checked — verify during impl.
- R8 (transaction boundary): Checked.
- R9 (audit emission tx-boundary): Mostly OK; F7 covers decrypt-fail-after-CAS edge.
- R10 (audit cross-actor): N/A — HUMAN-only.
- R11 (display vs subscription group): Checked — plan flags it.
- R12 (audit action group coverage): Checked.
- R13 (notification-type group coverage): F1 covers Postgres enum migration concern.
- R14 (DB role/permission grants): F6.
- R15 (migration env-dependent values): N/A.
- R16 (RLS policy update): Checked.
- R17 (existing utility reuse): Checked — F14 flags key-domain question.
- R18 (idempotency): Checked.
- R19 (response-shape exact-shape): F5.
- R20 (timezone/Date): Checked.
- R21 (i18n key coverage): F9.
- R22 (perspective inversion): Checked.
- R23 (no mid-stroke validation): Checked.
- R24 (additive nullable + backfill): Checked.
- R25 (admin-only authn-authz layering): Checked.
- R26 (UX clarity for permission gating): Checked.
- R27 (logging without PII): Checked.
- R28 (rate-limit per-actor): Checked.
- R29 (external standard citation): Checked — plan flags NIST as unverified.
- R30 (deprecated alias removal): N/A.
- R31 (no destructive ops on read paths): Checked.
- R32 (failure-mode propagation): F7 partial.
- R33 (multi-tenant identity boundary): F3.
- R34 (token plaintext lifecycle): Checked — F8 audit-trail concern noted.
- R35 (Tier-2 manual test artifact): Checked.

### Security expert
- R1: OK — shared envelope extracted.
- R2: OK — matches existing nullable-timestamp convention.
- R3: OK — plan calls out R3 in §"Why no status enum" and S-6 sequencing.
- R4: OK — four group sites enumerated.
- R5: T1 raised.
- R6: OK — CAS on approve/revoke/execute.
- R7: OK — `withTenantRls` reuse.
- R8: OK — NFR5.
- R9: OK — step 5.3.
- R10: N/A — proxy gate.
- R11: T4 (line 512-513 ambiguity).
- R12: T4 + T8.
- R13: T8.
- R14: T8 (en/ja parity).
- R15: N/A.
- R16: OK.
- R17: OK.
- R18: N/A — always-on.
- R19: T3.
- R20: T5.
- R21: OK.
- R22: T7.
- R23: OK — step 9.4.
- R24: OK — but T2 blocks.
- R25: N/A.
- R26: OK — step 9.1.
- R27: N/A.
- R28: N/A.
- R29: OK — citation flagged unverified.
- R30: N/A.
- R31: OK — FR1+FR4 dual-confirmation.
- R32: OK — manual-test artifact location declared.
- R33: N/A — new plan addition.
- R34: N/A.
- R35: T11.
- RS1 (timing-safe compare): N/A — indexed `findUnique` on tokenHash, no direct compare.
- RS2 (rate limiter): per-actor present; recommend per-target too.
- RS3 (input validation at boundaries): N/A — Zod for resetId UUID.

### Testing expert
- R1: OK — plan extracts shared envelope helper.
- R2: OK — matches existing convention.
- R3: OK — plan flags R3 in §"Why no status enum" and S-6.
- R4: OK — four group sites enumerated.
- R5: T1.
- R6: OK — CAS on approve/revoke/execute.
- R7: OK — `withTenantRls` reuse.
- R8: OK — NFR5.
- R9: OK — step 5.3.
- R10: N/A — proxy gate.
- R11: T4.
- R12: T4 + T8.
- R13: T8.
- R14: T8.
- R15: N/A.
- R16: OK.
- R17: OK.
- R18: N/A.
- R19: T3.
- R20: T5.
- R21: OK.
- R22: T7.
- R23: OK.
- R24: OK — but T2 blocks.
- R25: N/A.
- R26: OK.
- R27: N/A.
- R28: N/A.
- R29: OK.
- R30: N/A.
- R31: OK.
- R32: OK.
- R33: N/A.
- R34: N/A.
- R35: T11.
- RT1: T5 (mock-reality divergence).
- RT2: T6 + T11 (testability verification).
- RT3: T12 (shared constants in tests).
