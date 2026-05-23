# Plan Review: a04-7-gdpr-self-delete

Date: 2026-05-23
Review round: 1

## Changes from Previous Round
Initial review (plan-only PR — implementation deferred to follow-up).

## Triage Summary

Aggregate counts (deduplicated):
- **Critical (real)**: F1 (auth-adapter unification), F3 (sentinel UUID format)
- **Critical (downgraded to Minor)**: F2 / S1 / T2 (audit chain hash-spec) — **F2 verified the existing chain code: `audit_logs.user_id` column is OUTSIDE the hash; chain is safe under column anonymization. Per R37 verify-before-claim, S1 and T2 were based on an unverified assumption and are downgraded.**
- **Major**: F4, F5, F7, F8, F9, F11; S2, S3, S4, S5, S6, S7, S8, S9, S10; T3, T4, T5, T6, T7, T8, T9, T10, T11, T12 (~21 items)
- **Minor**: F12, F13; S11, S12, S13; T13, T14, T15 (~8 items)
- **Info**: F14, F15; S15 (~3 items)

## Functionality Findings

### F1 Critical — Existing `auth-adapter.deleteUser` path is a parallel deletion path that bypasses the GDPR flow
`src/lib/auth/session/auth-adapter.ts:412` (Auth.js adapter contract) calls `tx.user.delete({...})` directly. Without unification, the GDPR cascade is bypassed when Auth.js itself triggers deletion.

### F2 Critical (RESOLVED — downgraded to plan-fix-only)
F2 verified `src/lib/audit/audit-chain.ts:53-67` (`buildChainInput`) hashes only `{id, createdAt, chainSeq, prevHash, payload}` where `payload = metadata`. The `user_id` column is NOT in the hash. Anonymizing the column is SAFE. The plan v1's NF3 deferred a hash-spec change that turns out to be unnecessary. **The plan v2 corrects NF3 and removes the deferral.** Metadata embedded `userId` strings, however, MUST NOT be rewritten (would change `payload` hash and break the chain).

### F3 Critical — Sentinel UUID format violates project convention
Plan v1 proposed `00000000-0000-0000-0000-DEADBEEF0001`. Project convention (`src/lib/constants/app.ts:56-62`): sentinels are v4-structural (version=4 nibble, variant=8 nibble) so `UUID_RE.test()` passes. Existing `SYSTEM_ACTOR_ID = 00000000-0000-4000-8000-000000000001`.

### F4 Major — Sentinel User row needs tenant binding and DB-level protection
`User.tenantId` is REQUIRED. The sentinel needs a tenant binding (SYSTEM_TENANT_ID) OR a schema patch allowing null. Plus a row-level trigger preventing UPDATE/DELETE on `is_sentinel = true` rows.

### F5 Major — B6 (last team OWNER) is ambiguous; concretize
Plan v1: "User is the only member of an active Team where teams have a role-based ACL." Mirror B1's structure: "User is the only OWNER (TeamRole.OWNER) of a Team with ≥1 other active member."

### F6 Minor — Worker cadence (5 min) deviates from `dcr-cleanup-worker` (1h)
Match the existing 1-hour pattern for irreversible-deletion semantics; configurable env var.

### F7 Major — Schema patch ordering is dangerously vague
Plan v1 mixes "ALTER NULL" with "add new column + drop old". Pick one: `ALTER TABLE … ALTER COLUMN … DROP NOT NULL` (metadata-only) + `DROP CONSTRAINT … ADD CONSTRAINT … NOT VALID; VALIDATE CONSTRAINT …` to avoid table lock.

### F8 Major — Cascade procedure does not stop session/extension/MCP tokens BEFORE deletion (cache invalidation race)
The plan must enumerate ALL user-bound token-class models (Session, ExtensionToken, ApiKey, WebAuthnCredential, DelegationSession, McpAccessToken, McpRefreshToken, MobileBridgeCode, ExtensionBridgeCode) per `feedback_user_bound_token_enumeration.md` and invalidate the in-process session cache after commit.

### F9 Major — Missing FK blocker / anonymization for McpClient.createdBy; B5 inconsistent
McpClient.createdBy is Restrict (line 1873) — completely absent from plan v1. B5 is both a blocker AND a fallback anonymization target — pick one.

### F10 Major — Re-registration UX gap: passkey/WebAuthn devices bound to old userHandle
Documented expectation needed: user must re-enroll authenticators after re-registration.

### F11 Major — §C6 cascade list omits real models
Missing: EmergencyAccessGrant, TeamPasswordFavorite, TeamMemberKey, Attachment (via PasswordEntry cascade). The plan must walk the schema completely.

### F12 Minor — SQL nit in B1 — `!=` → `<>` for SQL-standard portability.

### F13 Minor — Cancellation email threat-model gap (email compromise enables both deletion AND cancellation).

### F14 Info — Audit group placement (PERSONAL[AUTH] vs new ACCOUNT_LIFECYCLE).

### F15 Info — `User.deletedAt` is dead column (`UserDeletion` table holds the schedule).

## Security Findings

### S1 Critical → Minor (downgraded per F2 verification)
Plan v1 deferred audit-chain hash-spec change; F2 proved it's unnecessary because `user_id` is not in the hash. Plan v2 corrects NF3.

### S2 Major — Cancellation token entropy + missing rate limit on cancel endpoint
Plan must mandate `crypto.randomBytes(32)` (256-bit) and add per-IP / per-token rate limit on the cancel endpoint.

### S3 Major — Confirmation flow inversion (current: schedule then email; industry pattern: confirm via email then schedule)
Recommendation: stay with current flow as ACCEPTED TRADE-OFF (the 24h grace + cancellation token + in-app banner provides depth), but require WebAuthn step-up if user has any.

### S4 Major — 15-min re-auth is too weak for irreversible operation
Recommend: tighten to 60 seconds since last passphrase OR require WebAuthn step-up.

### S5 Major — B5 service-account blocker has no UX escape
Implementation PR MUST ship ownership-transfer UX OR auto-anonymize createdById to sentinel.

### S6 Major — Pre-flight blockers omit EmergencyAccessGrant
Add B7 (active grant where user is grantee or owner).

### S7 Major — Pre-flight blockers omit PasswordShare / PersonalLogAccessGrant target
Decide: block or auto-sentinel-rewrite.

### S8 Major — `withBypassRls(SYSTEM_MAINTENANCE)` scope too broad
Narrow per-statement; static guard.

### S9 Major — Sentinel User must be rejected by every authentication entry point
Add `assertNotSentinel(userId)` helper; required call at every auth path; static guard.

### S10 Major — Re-registration email-keyed pending state cleanup
At deletion, clear all email-keyed pending state: TeamInvitation, EmergencyAccessGrant (granteeEmail), magic-link tokens.

### S11 Minor — Email delivery failure leaves user with no recourse → require in-app pending-deletion banner.

### S12 Minor — `metadata.deletedUserEmail` retention policy → align with audit-log retention.

### S13 Minor — Cross-tenant info leakage via sentinel-rewrite (acceptable per design; document).

### S14 Minor — Worker DB role should be dedicated `passwd_deletion_worker`, not MIGRATION_DATABASE_URL.

### S15 Info — `actorType: SYSTEM` + `metadata.userId` approach is correct.

## Testing Findings

### T1 Critical → Major — Sentinel row idempotency test must be specified
Two-run migration assertion needed.

### T2 Critical → Minor (downgraded per F2)
Audit chain validator concern resolved by F2 verification. T2 was based on the same hash-spec assumption as S1.

### T3 Major — Worker mid-transaction crash idempotency test
Need explicit test seeded with partial-anonymization state.

### T4 Major — Cancel/execute race
Add `SELECT FOR UPDATE SKIP LOCKED` on UserDeletion row before pre-anonymize; add unit test.

### T5 Major — Cascade-completeness via Prisma DMMF introspection (future-proof against new User FKs).

### T6 Major — Cancellation token entropy unit test (assert 256-bit, base64url).

### T7 Major — Re-registration (Scenario E) named integration test.

### T8 Major — B6 testable (concrete role + member predicate).

### T9 Major — Email template snapshot tests (3 templates × 2 locales = 6 snapshots).

### T10 Major — `BlockerSchema` Zod discriminated union + per-blocker shape test.

### T11 Major — pre-pr.sh `.user.delete(` guard allowlist (explicit globs to avoid false positives).

### T12 Major — Worker boot smoke-test pinned ready signal string.

### T13 Minor — C6 unit test demoted to smoke test (rely on integration for primitive verification).

### T14 Minor — Token replay protection on cancellation (after replacement, old token returns 404).

### T15 Minor — Worker DB role choice pinned (passwd_deletion_worker).

## Adjacent Findings
None.

## Quality Warnings
None — all findings have file:line, evidence, and concrete fix.

## Recurring Issue Check
### Functionality expert
- R9: OK
- R10: OK
- R11: OK (F14 notes group placement debate)
- R12: enforced
- R14: OK (with F4, F8 caveats)
- R29: OK (GDPR/APPI cited; verify before impl)
- R34 Anti-Deferral: F1, F9
- R35 Tier-2: OK
- R36 user-bound token enumeration: F8
- R37 verify-before-claim: F2 (resolved S1+T2)

### Security expert
- R9-R15: see plan/findings
- R29: OK
- R32: F12, T12
- R34: S1 (downgraded by F2)
- R35: OK
- RS1: S2
- RS2: S2 (cancel endpoint missing)
- RS3: OK
- RS4: OK

### Testing expert
- R9-R37: see Testing findings
- RT1: T13
- RT4: T4
- RT5: T5

## Resolution Plan

Plan v2 incorporates ALL Critical + Major findings (F1, F3-F11; S2-S10; T1, T3-T12). Minor findings recorded; selectively applied. Info findings noted.

S1 / T2 are explicitly downgraded — the resolution is "F2 verification proved the chain is safe; NF3 is corrected; no hash-spec change needed".

Round 2 plan review: not required for plan-only PR — the v2 update is incorporation of verified findings, not a scope change. Orchestrator self-verify is appropriate.
