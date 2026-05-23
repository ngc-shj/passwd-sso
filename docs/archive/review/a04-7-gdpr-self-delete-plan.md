# A04-7 — GDPR Self-Delete (Right-to-Erasure)

**OWASP**: A04 Insecure Design — no user-initiated account deletion / data-erasure path
**Branch**: TBD (this PR is PLAN-ONLY; implementation deferred to a follow-up)
**Plan author**: orchestrator (Claude Opus 4.7)
**Date**: 2026-05-23 (v2 — Round 1 plan-review findings applied)
**Status**: PLAN-ONLY — implementation is out of scope for the current `fix/owasp-batch3-followups` PR

---

## Project Context

- **Type**: web app (Next.js 16 App Router) + service workers + Postgres 16 + Prisma 7
- **Test infrastructure**: unit + integration (Vitest, real-DB integration tests) + CI; no E2E
- **Stage**: pre-1.0 (`0.x.y`) — backwards-compatibility shims are NOT required; schema migrations may be additive-then-strict
- **Identity model** (from CLAUDE.md): global User keyed by email, one active tenant per user (`User.tenantId`), multi-tenant access via `TenantMember`. **A04-7 must operate within this model — deleting a User cascades or anonymizes references across ALL tenants the user has joined**.

## Objective

Provide an authenticated user with a self-service "delete my account and erase my data" endpoint that:

1. **Hard-deletes** data OWNED by the user (personal vault entries, sessions, tokens, recovery key) so the data is irrecoverable post-deletion. This is the GDPR Article 17 "right to erasure" surface.
2. **Anonymizes** references to the user in audit / forensic / shared records that MUST be retained for legal/operational reasons (audit logs, team-entry creator refs, share-link creator refs) by re-pointing those FKs to a sentinel `DELETED_USER` row.
3. **Blocks (or migrates) cleanly** when the user holds resources that cannot be auto-deleted without external coordination.

The endpoint MUST be safe under multi-tenancy and MUST maintain audit-chain integrity. **Per F2 verification of `src/lib/audit/audit-chain.ts:53-67`, the audit chain hashes only `{id, createdAt, chainSeq, prevHash, payload}` where `payload = metadata`. The `user_id` COLUMN is OUTSIDE the hash — anonymizing it does NOT break the chain.** What MUST NOT be rewritten is embedded `userId` strings inside `metadata` JSON — those are part of the hashed payload.

## Legal / Compliance Framing

- **GDPR Article 17** ("right to erasure") gives EU data subjects the right to request deletion of personal data.
- **GDPR Recital 39** explicitly permits retention of data necessary for "legitimate interests" of the data controller — including security audit logs, fraud-detection records, and other accountability evidence.
- **Japanese 個人情報保護法 (APPI)** Article 30 similarly recognizes deletion requests but allows retention of records required by other laws or for legitimate business purposes.

**Decision**: audit_logs are RETAINED with `user_id` COLUMN re-pointed to the `DELETED_USER` sentinel (chain-safe per F2). `metadata` JSON content is NOT rewritten — embedded user-id references inside metadata remain as forensic evidence; the legitimate-interest exception applies.

## Threat Model

- **Pre-A04-7**: no self-service deletion; GDPR Article 17 cannot be honored within 30 days without admin intervention.
- **Post-A04-7**: any authenticated user can initiate self-deletion. Gates:
  - Recent re-authentication (60s for the deletion path — see NF3 for the tightened gate vs change-passphrase's 15-min). WebAuthn step-up REQUIRED if the user has any registered WebAuthn credential.
  - 24h grace period with email cancellation link + in-app pending-deletion banner.
  - Per-user rate limit (1/24h request) + per-IP rate limit on cancel endpoint.
- **Attack vectors mitigated**:
  - Stolen session → deletion: 60s re-auth + WebAuthn step-up gate.
  - Email compromise (attacker reads cancellation link): in-app banner provides a non-email recovery channel.
  - Coerced deletion: 24h grace period.
  - Mass deletion via single compromise: per-user rate limit.
  - Tenant lockout: pre-flight blocker B1 (last OWNER of a tenant).
- **Accepted trade-off** (S3 / F13): if the user's email is compromised, the attacker can both initiate AND cancel via email. The in-app banner shifts this risk by giving the legitimate logged-in user a second cancel surface. The 24h grace period bounds the attacker's deletion window. Documented as the accepted residual risk.

## Requirements

### Functional
- **FR1**: `POST /api/user/delete-account` — session-authenticated; gated by 60-second re-auth check (NF3) AND WebAuthn step-up if any WebAuthn credentials are registered.
- **FR2**: Body validation: `z.object({ confirmEmail: z.string().email().max(EMAIL_MAX) }).strict()`. `confirmEmail` MUST match `session.user.email`.
- **FR3**: Returns `202 Accepted` with `{ scheduledAt, cancellationToken, blockers: [] }`. The actual deletion fires after a 24h grace period.
- **FR4**: `POST /api/user/delete-account/cancel` — two paths:
  - (a) session-authenticated (in-app banner button); or
  - (b) cancellation token via URL (?token=…) from the email.
- **FR5**: At T+24h, the deletion worker runs the cascade procedure (C6) inside a single DB transaction.
- **FR6**: After deletion, re-registration with the same email succeeds (no soft-tombstone). Note re-registered users with prior passkey enrollments must re-enroll devices (different userHandle).
- **FR7**: Pre-flight blockers (C7) — if any fire, return 409 with `{ blockers: [...] }` and do NOT create a UserDeletion row.
- **FR8**: Audit emits: `USER_SELF_DELETE_REQUESTED`, `USER_SELF_DELETE_CANCELLED`, `USER_SELF_DELETE_EXECUTED`. EXECUTED uses `actorType = SYSTEM` (the User no longer exists at emit time) with `metadata.deletedUserId` and `metadata.deletedUserEmail` preserved.
- **FR9**: In-app pending-deletion banner visible on every dashboard page during the grace period with an in-app "Cancel deletion" button (session-authenticated, does not require the email token).
- **FR10**: After deletion, the worker invalidates the in-process session cache and revokes/cascades ALL user-bound token-class rows BEFORE the User.delete CASCADE fires (see C6 step 0 + `feedback_user_bound_token_enumeration.md`).

### Non-functional
- **NF1**: Deletion is irreversible after T+24h.
- **NF2**: Personal vault entries (E2E-encrypted) are hard-deleted from the server.
- **NF3 (CORRECTED v2)**: Audit chain hashes only `{id, createdAt, chainSeq, prevHash, payload=metadata}` per `audit-chain.ts:53-67`. Anonymizing `audit_logs.user_id` COLUMN does NOT change `prev_hash` of any row. Embedded `userId` strings inside `metadata` MUST NOT be rewritten. The chain validator script (`scripts/verify-audit-chain.sh` or `src/app/api/maintenance/audit-chain-verify/route.ts`) is run post-deletion as part of C10 integration tests. Re-auth window for THIS endpoint is 60 seconds (tighter than the change-passphrase 15-min window) per S4.
- **NF4**: Multi-tenant safety: cascade across ALL TenantMember rows.
- **NF5 (REVISED v2)**: The `DELETED_USER` sentinel User row has UUID `DELETED_USER_ID = "00000000-0000-4000-8000-DE1ED0000001"` (v4-structural per the project SENTINEL convention; verified against `UUID_RE.test()`). The row has `isSentinel: true`, `tenantId: SYSTEM_TENANT_ID` (NOT nullable), `email: null`. DB-level protection: a PG trigger rejects UPDATE/DELETE on rows where `is_sentinel = true` (except for the migration itself).
- **NF6**: Audit metadata containing email of deleted users is retained for the audit-log retention period; on expiry, `metadata.email` is anonymized to `sha256(salt || email)`.
- **NF7**: Worker DB role: dedicated `passwd_deletion_worker` (NOSUPERUSER + minimal grants + BYPASSRLS only for audit_logs anonymization). NOT `MIGRATION_DATABASE_URL`.

## Contracts (Stable IDs)

### C1 — `DELETED_USER` sentinel row + schema patches

- **Files**: `prisma/schema.prisma`, new migration
- **Sentinel definition**:
  ```ts
  // src/lib/constants/app.ts
  export const DELETED_USER_ID = "00000000-0000-4000-8000-DE1ED0000001";
  export const SENTINEL_ACTOR_IDS = new Set([
    SYSTEM_ACTOR_ID,
    DELETED_USER_ID,
    // ... others
  ]);
  ```
- **User schema patch**:
  ```prisma
  model User {
    // ... existing fields ...
    isSentinel  Boolean   @default(false) @map("is_sentinel")
    // No deletedAt column — UserDeletion table holds the schedule (F15).
  }
  ```
- **Sentinel row insertion** (idempotent in migration):
  ```sql
  INSERT INTO users (id, email, tenant_id, is_sentinel, created_at)
  VALUES ('<DELETED_USER_ID>', NULL, '<SYSTEM_TENANT_ID>', true, NOW())
  ON CONFLICT (id) DO NOTHING;
  ```
- **DB-level sentinel protection**:
  ```sql
  CREATE OR REPLACE FUNCTION reject_sentinel_user_mutation() RETURNS trigger AS $$
  BEGIN
    IF (OLD.is_sentinel = true) THEN
      RAISE EXCEPTION 'Sentinel user row cannot be modified or deleted (id=%)', OLD.id;
    END IF;
    RETURN NULL;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER protect_sentinel_user
    BEFORE UPDATE OR DELETE ON users
    FOR EACH ROW
    WHEN (OLD.is_sentinel = true)
    EXECUTE FUNCTION reject_sentinel_user_mutation();
  ```
- **FK policy patches** (use the lock-light pattern: `DROP CONSTRAINT … ADD CONSTRAINT … NOT VALID; VALIDATE CONSTRAINT …` per F7):
  - `team_password_entries.created_by_id`: REQUIRED → REQUIRED + onDelete: SetDefault(sentinel) via post-trigger UPDATE OR REQUIRED + onDelete: SetNull + post-deletion sentinel-rewrite
  - `team_password_entries.updated_by_id`: same
  - `team_password_entry_histories.changed_by_id`: same
  - `password_shares.created_by_id`: same
  - `team_invitations.invited_by_id`: same
  - `personal_log_access_grants.requester_id`/`target_user_id`: REQUIRED → nullable + SetNull
  - `service_accounts.created_by_id`: keep REQUIRED + Restrict (B5 blocks deletion until ownership transferred — see C7.5)
  - `mcp_clients.created_by_id` (F9): keep REQUIRED + Restrict OR convert to nullable + SetNull (decide and document)
- **Decision (v2)**: use **nullable + SetNull** for all the patches above, then post-deletion UPDATE re-points the nulls to `DELETED_USER_ID` sentinel inside the deletion transaction. This is two operations but keeps Prisma's onDelete semantics clean. The `ServiceAccount.createdById` exception requires the ownership-transfer UX (C7.5) before deletion can proceed.
- **Acceptance**:
  - C1.AC1: Migration creates the sentinel row idempotently (re-running the migration produces no duplicate row).
  - C1.AC2: An integration test (`src/__tests__/integration/sentinel-user.test.ts`) runs the migration twice, asserts row count = 1, asserts UUID matches the constant.
  - C1.AC3: The protect_sentinel_user trigger is in place; UPDATE/DELETE on the sentinel row throws.
  - C1.AC4: All FK patches use the lock-light `NOT VALID` + `VALIDATE` pattern; no migration step holds ACCESS EXCLUSIVE for >100ms on the large tables.
  - C1.AC5: Static guard catches direct `DELETED_USER_ID` references outside the deletion-flow module (C11).

### C2 — Deletion request endpoint

- **File**: `src/app/api/user/delete-account/route.ts` (NEW). Grep first for any existing endpoint that might conflict.
- **Auth**: session-required; **60-second re-auth gate** (tighter than change-passphrase's 15-min per S4). If user has any WebAuthn credentials registered, REQUIRE WebAuthn step-up (RPID + PRF challenge).
- **Validation**:
  ```ts
  z.object({
    confirmEmail: z.string().email().max(EMAIL_MAX),
  }).strict()
  ```
- **Pre-checks** (C7) — return 409 with detailed `blockers[]` if any fail.
- **Response shape (frozen — C2.AC5)**:
  ```ts
  {
    scheduledAt: string,           // ISO 8601
    cancellationToken: string,     // 43-char base64url, 256 bits
    blockers: [],                  // empty on success
  }
  ```
- **Token generation (S2)**: `crypto.randomBytes(32)` → `base64url`. 256 bits of entropy. Stored as `sha256(token)` in `cancellation_token_hash`.
- **Acceptance**:
  - C2.AC1: 401 when no session.
  - C2.AC2: 401 when re-auth is older than 60 seconds.
  - C2.AC3: 401 when user has WebAuthn registered but step-up not provided.
  - C2.AC4: 400 when `confirmEmail` mismatches.
  - C2.AC5: 202 on success with the documented response shape (token has 43 chars, scheduledAt is now+24h).
  - C2.AC6: 409 with populated `blockers[]` when any C7 blocker fires; no UserDeletion row created.
  - C2.AC7: Audit `USER_SELF_DELETE_REQUESTED` with `metadata.scheduledAt`, `metadata.tenantIds[]` (all tenants the user is a member of).
  - C2.AC8: Rate limit: 1 successful request per user per 24h (idempotent retry within window returns the existing row's data).

### C3 — Pending-deletion model

- **File**: `prisma/schema.prisma`
- **New model** (unchanged from v1, plus `passwd_deletion_worker` GRANT in migration):
  ```prisma
  model UserDeletion {
    id                    String    @id @default(uuid(4)) @db.Uuid
    userId                String    @unique @map("user_id") @db.Uuid
    emailAtRequest        String    @map("email_at_request") @db.VarChar(320)
    requestedAt           DateTime  @default(now()) @map("requested_at") @db.Timestamptz(3)
    scheduledAt           DateTime  @map("scheduled_at") @db.Timestamptz(3)
    cancellationTokenHash String    @map("cancellation_token_hash") @db.VarChar(64)
    cancelledAt           DateTime? @map("cancelled_at") @db.Timestamptz(3)
    executedAt            DateTime? @map("executed_at") @db.Timestamptz(3)
    createdAt             DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)

    user User @relation(fields: [userId], references: [id], onDelete: Cascade)

    @@index([userId, executedAt])
    @@index([scheduledAt, executedAt])
    @@map("user_deletions")
  }
  ```
- **Invariants**: one pending deletion per user; token hash is sha256(plaintext); worker scans by `WHERE scheduledAt < now AND executedAt IS NULL AND cancelledAt IS NULL FOR UPDATE SKIP LOCKED` (T4 — concurrency-safe).
- **Migration includes**: `GRANT SELECT, UPDATE ON user_deletions TO passwd_deletion_worker;`

### C4 — Cancellation endpoint

- **File**: `src/app/api/user/delete-account/cancel/route.ts` (NEW)
- **Auth**: two entry paths:
  - (a) session-required (in-app banner button)
  - (b) cancellation token via URL (`?token=...` from email)
- **Token compare**: `timingSafeEqual(sha256(token), storedHash)` (RS1).
- **Rate limit (S2)**: per-IP 5/min + per-token 1/sec to make brute-force impractical.
- **Acceptance**:
  - C4.AC1: 200 on successful cancel; `cancelledAt = now`.
  - C4.AC2: 410 if already executed.
  - C4.AC3: 410 if already cancelled.
  - C4.AC4: 404 on bad token (timing-uniform).
  - C4.AC5: Audit `USER_SELF_DELETE_CANCELLED` with `metadata.cause` ∈ {"user_session", "cancellation_token"}.
  - C4.AC6 (T14): After UserDeletion row is replaced (initiated→cancelled→initiated again), the OLD token returns 404.
  - C4.AC7 (S2): Cancel endpoint rate-limited at 5/min per IP. Brute-force test: 1000 random tokens, 0 successes, all 404/429.

### C5 — Delete worker

- **File**: `src/workers/user-deletion-worker.ts` (NEW)
- **Cadence**: 1-hour default (matching `dcr-cleanup-worker` per F6), env-configurable via `USER_DELETION_INTERVAL_MS` (default 3_600_000).
- **Ready signal (R32)**: `user-deletion-worker: ready (interval=3600000ms)` — pinned string for the boot smoke test.
- **DB role**: connect via `USER_DELETION_DATABASE_URL` env (dedicated `passwd_deletion_worker` role). Refuse to start if connected as SUPERUSER.
- **Loop**:
  1. Scan `UserDeletion WHERE scheduledAt < now AND executedAt IS NULL AND cancelledAt IS NULL FOR UPDATE SKIP LOCKED` (T4).
  2. For each locked row, run the cascade-delete + anonymize procedure (C6) inside a single transaction.
  3. Mark `executedAt = now`.
  4. Emit `USER_SELF_DELETE_EXECUTED` audit (`actorType: SYSTEM`).
- **Idempotency (T3)**: if the worker crashes mid-transaction, the row's `executedAt` is still null → next loop's FOR UPDATE SKIP LOCKED grabs it again. Cascade-delete is naturally idempotent (rows already deleted = no-op; sentinel UPDATEs on already-sentinel rows are no-ops because WHERE filters by the original userId).

### C6 — Cascade-delete + anonymize procedure

Inside a single DB transaction, in fixed order:

**Step 0 (F8 — token-class enumeration BEFORE delete)**: Enumerate ALL user-bound token-class rows and stage them for cache invalidation. Models per `feedback_user_bound_token_enumeration.md`:
- Session, ExtensionToken, ApiKey, WebAuthnCredential, DelegationSession, McpAccessToken, McpRefreshToken, MobileBridgeCode, ExtensionBridgeCode, OperatorToken

These are all Cascade-deleted in step 4; staging them here just gives the post-commit step a list of `tokenHash` / `tokenId` values to invalidate in the in-process session cache.

**Step 1 — pre-anonymize REQUIRED FKs that don't cascade**:
- `team_password_entries.created_by_id` → sentinel (WHERE `created_by_id = userId`)
- `team_password_entries.updated_by_id` → sentinel
- `team_password_entry_histories.changed_by_id` → sentinel
- `password_shares.created_by_id` → sentinel
- `team_invitations.invited_by_id` → sentinel

**Step 2 — anonymize SetNull / forensic refs**:
- `audit_logs.user_id` → sentinel (per F2: column UPDATE is chain-safe). Use scoped `withBypassRls(SYSTEM_MAINTENANCE)` PER STATEMENT (S8), with WHERE `user_id = <deletedUserId>`.
- `access_requests.approved_by_id`, `requester_user_id` → sentinel
- `admin_vault_resets.approved_by_id` → sentinel
- `master_key_rotations.initiated_by_id` / `approved_by_id` / `executed_by_id` / `revoked_by_id` → sentinel
- `scim_tokens.created_by_id` → sentinel
- `personal_log_access_grants.requester_id` / `target_user_id` → sentinel (revoke first — set `status = REVOKED`, `revokedAt = now`)
- `emergency_access_grants` — see Step 3 (S6)
- `mcp_clients.created_by_id` (F9) → sentinel

**Step 3 — cancel email-keyed pending state (S10)**:
- `team_invitations` WHERE `email = userEmail AND status = PENDING` → `status = CANCELLED`
- `emergency_access_grants` WHERE `grantee_email = userEmail AND status IN (PENDING, REQUESTED, ACTIVATED)` → `status = REVOKED, revoked_at = now`
- Magic-link / passwordless tokens for `userEmail` → DELETE

**Step 4 — DELETE the User row**. Prisma's `onDelete: Cascade` rules auto-delete:
- Account, Session, PasswordEntry (+ cascades PasswordEntryHistory, Attachment)
- Tag, Folder, VaultKey, ExtensionToken, ApiKey, WebAuthnCredential, ExtensionBridgeCode, MobileBridgeCode
- TeamMember, TenantMember, TeamPasswordFavorite (F11), TeamMemberKey (F11)
- Notification, DelegationSession
- EmergencyAccessGrant where user is owner (Cascade per schema)
- McpAccessToken, McpRefreshToken (user-bound MCP tokens)
- OperatorToken (subjectUser is Cascade)
- UserDeletion itself (cascade through self-reference is intentional — the row's purpose ends here)

**Step 5 — post-commit (outside transaction)**:
- Invalidate in-process session cache for every session token enumerated in step 0 (matches `auth-adapter.deleteUser` line 412+ pattern).
- Schedule S3/blob-store attachment deletion via the existing attachment-lifecycle path.

- **Acceptance**:
  - C6.AC1: Post-deletion, `SELECT * FROM users WHERE id = <deleted-id>` returns 0 rows.
  - C6.AC2: Post-deletion, `SELECT count(*) FROM audit_logs WHERE user_id = <deleted-id>` returns 0 (all anonymized to sentinel).
  - C6.AC3: Post-deletion, all 5 REQUIRED-FK tables in step 1 have `created_by_id`/`updated_by_id`/`changed_by_id`/`invited_by_id` = sentinel for the deleted user's prior rows.
  - C6.AC4: Audit-chain validator (`audit-chain-verify` route) passes post-deletion (NF3 — column UPDATE doesn't touch the hash).
  - C6.AC5: Re-registration with the same email succeeds (no soft-tombstone). New User row has a different UUID.
  - C6.AC6: NO EmergencyAccessGrant, TeamInvitation, or magic-link token survives in PENDING/ACTIVATED state for the deleted user's email.
  - C6.AC7 (F8): Session cache is invalidated for every token previously held by the user.
  - C6.AC8 (T5): A DMMF-introspection integration test enumerates every Prisma model with a `User` relation and asserts each is either (a) zero rows for the deleted userId OR (b) sentinel-rewritten.

### C7 — Pre-flight blocker checks (B1-B8)

Synchronously, in the request endpoint, BEFORE creating a UserDeletion row:

- **B1**: User is the only OWNER of a tenant with ≥1 other active member.
  ```sql
  SELECT t.id FROM tenants t
  WHERE EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id = t.id AND tm.user_id = <userId> AND tm.role = 'OWNER')
    AND NOT EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id = t.id AND tm.role = 'OWNER' AND tm.user_id <> <userId>)
    AND EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id = t.id AND tm.user_id <> <userId>)
  ```
- **B2**: User has active operator tokens issued FOR someone else (token's `subjectUserId != userId` AND user owns it). (Tokens cascade-deleted if subjectUser is the user themselves; B2 catches the "I issued tokens for others" case.)
- **B3**: User has in-progress AdminVaultReset where they are initiator or target.
- **B4**: User has in-progress MasterKeyRotation where they are initiator.
- **B5**: User has active ServiceAccount they created (force ownership-transfer via C7.5 first).
- **B6 (concretized v2 per F5)**: User is the only OWNER (`TeamRole.OWNER`) of any Team with ≥1 other active (non-revoked) member.
- **B7 (NEW v2 per S6)**: Active EmergencyAccessGrant where the user is grantee OR owner with status ∈ {REQUESTED, ACTIVATED}.
- **B8 (NEW v2 per S7)**: Active PersonalLogAccessGrant where the user is target (in-progress break-glass investigation).

**Blocker shape** (T10):
```ts
const BlockerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("B1"), tenantId: z.string().uuid(), otherActiveMembers: z.number().int() }),
  z.object({ kind: z.literal("B2"), tokenIds: z.array(z.string().uuid()) }),
  z.object({ kind: z.literal("B3"), resetIds: z.array(z.string().uuid()) }),
  z.object({ kind: z.literal("B4"), rotationIds: z.array(z.string().uuid()) }),
  z.object({ kind: z.literal("B5"), serviceAccountIds: z.array(z.string().uuid()) }),
  z.object({ kind: z.literal("B6"), teamIds: z.array(z.string().uuid()) }),
  z.object({ kind: z.literal("B7"), grantIds: z.array(z.string().uuid()) }),
  z.object({ kind: z.literal("B8"), grantIds: z.array(z.string().uuid()) }),
]);
```

- **Acceptance**:
  - C7.AC1: Each blocker has a unit test asserting 409 + `BlockerSchema.parse(body.blockers[0])` succeeds.
  - C7.AC2: Integration test seeds each blocker condition independently and verifies 409 (no UserDeletion row created).

### C7.5 — ServiceAccount ownership-transfer (NEW v2 per S5)

- **File**: `src/app/api/tenant/service-accounts/[id]/transfer/route.ts` (NEW)
- **Purpose**: Allow user to transfer ownership of their ServiceAccount to another tenant admin BEFORE self-deletion.
- **Auth**: session + tenant admin role + the target user must be in the same tenant.
- **Action**: `UPDATE service_accounts SET created_by_id = <newUserId> WHERE id = <saId> AND created_by_id = <oldUserId>`.
- **Audit**: emit `SERVICE_ACCOUNT_OWNERSHIP_TRANSFERRED` with metadata.
- **Acceptance**: C7.5.AC1: B5 unblocks after ownership transfer.

### C8 — Audit actions + i18n

- **Files**: `prisma/schema.prisma`, `src/lib/constants/audit/audit.ts`, `messages/{en,ja}/AuditLog.json`
- **New actions** (3):
  - `USER_SELF_DELETE_REQUESTED`
  - `USER_SELF_DELETE_CANCELLED`
  - `USER_SELF_DELETE_EXECUTED`
- **Plus** `SERVICE_ACCOUNT_OWNERSHIP_TRANSFERRED` (1) per C7.5.
- **Group placement**: AUDIT_ACTION_GROUPS_PERSONAL[AUTH] for the 3 lifecycle events (per existing convention; F14 documented). SERVICE_ACCOUNT_OWNERSHIP_TRANSFERRED → AUDIT_ACTION_GROUPS_TENANT[ADMIN].
- **i18n keys**: en + ja entries in `AuditLog.json`.

### C9 — Email templates

- **Files**:
  - `src/lib/email/templates/user-deletion-requested.ts` (NEW)
  - `src/lib/email/templates/user-deletion-cancelled.ts` (NEW)
  - `src/lib/email/templates/user-deletion-executed.ts` (NEW)
- **`requested` template content**:
  - Scheduled execution time
  - Cancellation link with PLAINTEXT token (URL: `{APP_URL}/account-deletion-cancel?token=<plaintext>`)
  - Locale-aware (en + ja)
- **`executed` template content**:
  - Confirmation that data has been deleted
  - Note about passkey re-enrollment requirement if user re-registers
- **Acceptance** (T9):
  - C9.AC1: Each template has a snapshot test (3 templates × 2 locales = 6 snapshots).
  - C9.AC2: `sendEmail` is mock-asserted to be called with the correct template + locale + cancellation URL format containing plaintext token.

### C10 — Tests

- **Unit tests** (mocked Prisma):
  - C2 route: every AC1-AC8 case.
  - C4 cancel route: every AC1-AC7 case. **Brute-force test (C4.AC7)**: 1000 random tokens → 0 successes, all 404/429.
  - C5 worker: scan + cascade flow with mocked Prisma + ALSO assert `FOR UPDATE SKIP LOCKED` is in the WHERE clause (T4).
  - C6 procedure (T13): smoke test only — primary verification is the integration test.
  - C7 blocker checks: one test per B1-B8 (T10: BlockerSchema.parse each shape).
  - C7.5 ownership transfer: happy path + cross-tenant rejection.
  - Token entropy (T6): generated tokens are 43-char base64url, statistical sample of 1000 has no collisions and decoded length is 32 bytes.
- **Integration tests** (real DB):
  - **`src/__tests__/integration/sentinel-user.test.ts`** (T1): two-run migration test; sentinel row idempotent.
  - **`src/__tests__/integration/user-deletion-cascade-completeness.test.ts`** (T5): introspect `Prisma.dmmf.datamodel.models`, find every model with a `User` relation, assert each is (a) zero rows OR (b) sentinel-rewritten post-delete.
  - **`src/__tests__/integration/user-deletion-rereg.test.ts`** (T7): full Scenario E flow.
  - **`src/__tests__/integration/user-deletion-race.test.ts`** (T4): cancel-during-worker test using `Promise.all([cancel(), workerTick()])` × 50 iterations; assert no "both succeeded" outcome and the FOR UPDATE lock provides serializability.
  - **`src/__tests__/integration/user-deletion-chain-integrity.test.ts`** (NF3): post-delete, run audit-chain validator; expect 0 failures (since column UPDATE doesn't touch the hash).
  - **`src/__tests__/integration/user-deletion-mid-tx-crash.test.ts`** (T3): simulated crash between step 2 and step 4; next worker tick completes idempotently.
- **Manual smoke test**: `docs/archive/review/a04-7-gdpr-self-delete-manual-test.md` (NEW, ships with implementation PR). MUST include:
  - User flow (Scenarios A-E)
  - Worker boot section (T12 — assert `user-deletion-worker: ready (interval=3600000ms)` on stdout)
  - Adversarial scenarios (R35 Tier-2): stolen-session deletion, email-compromise scenario, ownership-transfer flow

### C11 — pre-pr.sh static guards

- **New guards**:
  1. `user-deletion-sentinel-only-in-deletion-flow`: grep for `DELETED_USER_ID` outside allowlist. **Allowlist (T11)** — explicit globs:
     ```
     src/lib/user-deletion/**
     src/workers/user-deletion-worker.ts
     src/app/api/user/delete-account/**
     src/lib/constants/app.ts
     **/*.test.ts
     **/*.test.tsx
     prisma/seed.ts
     prisma/migrations/**
     ```
  2. `user-deletion-no-direct-prisma-user-delete`: grep for `.user.delete(` / `.user.deleteMany(` outside allowlist. **Allowlist (T11 + F1)** — same as above PLUS `src/lib/auth/session/auth-adapter.ts` (which calls into the deletion module per F1).
  3. `user-deletion-audit-anonymize-rls-bypass-narrow`: every `withBypassRls` call inside the deletion module MUST wrap a SINGLE Prisma statement (S8). The grep finds `withBypassRls` blocks and asserts the block contains no `await prisma.` second call.
  4. `assert-not-sentinel-on-auth-paths` (S9): every function in `src/auth/**`, `src/lib/auth/**`, and every token-resolver function calls `assertNotSentinel(userId)` before issuing a session.
- **Acceptance**: `pre-pr.sh` exits 0 with +4 static checks (target: 28 → 32 PASS).

### C12 — Auth.js adapter unification (NEW v2 per F1)

- **File**: `src/lib/auth/session/auth-adapter.ts`
- **Change**: `deleteUser` adapter method MUST delegate to the same `runUserDeletionProcedure(userId)` helper from `src/lib/user-deletion/`. No direct `tx.user.delete({ where: { id: userId } })`.
- **Rationale**: Auth.js can trigger user deletion via internal flows (admin "force unlink"); without unification, the GDPR cascade is bypassed.
- **Acceptance**:
  - C12.AC1: `auth-adapter.deleteUser` is a thin wrapper calling the unified module.
  - C12.AC2: Integration test triggers Auth.js's deleteUser path (e.g., via a test-only admin endpoint) and asserts identical sentinel + anonymization state as the user-initiated path.

## Go/No-Go Gate

| ID    | Subject                                          | Status |
|-------|--------------------------------------------------|--------|
| C1    | DELETED_USER sentinel + schema patches            | locked |
| C2    | Delete-account request endpoint                   | locked |
| C3    | UserDeletion pending model                        | locked |
| C4    | Cancellation endpoint                             | locked |
| C5    | 1h grace-period delete worker (dedicated DB role) | locked |
| C6    | Cascade-delete + anonymize procedure (with FOR UPDATE) | locked |
| C7    | Pre-flight blocker checks (B1-B8)                 | locked |
| C7.5  | ServiceAccount ownership-transfer endpoint         | locked |
| C8    | Audit actions + i18n                              | locked |
| C9    | Email templates                                   | locked |
| C10   | Tests (unit + integration + manual)               | locked |
| C11   | pre-pr.sh static guards (×4)                      | locked |
| C12   | Auth.js adapter unification                       | locked |

All contracts begin `locked` for Round 1 plan-review; flip to `pending` if Round 2 requires it (not required for plan-only PR per Resolution Plan in review log).

## User Operation Scenarios

### Scenario A — Happy path
1. Alice signs in, opens Settings → Delete Account.
2. App requires recent re-auth (<60s) + WebAuthn step-up if she has any.
3. Alice types her email and confirms.
4. App: `POST /api/user/delete-account` → 202 + `{ scheduledAt: now+24h, cancellationToken }`.
5. Alice receives email AND sees in-app banner.
6. 24h passes. Worker fires (within 1h of scheduledAt). Cascade-delete + anonymize runs. `USER_SELF_DELETE_EXECUTED` audit emitted.
7. Sessions invalidated; Alice cannot log in. Personal vault entries gone. Old passkeys bound to old userHandle.
8. Audit rows anonymized (`user_id → DELETED_USER`); chain validator passes.

### Scenario B — Cancellation via email
1. Alice initiates (Scenario A 1-5).
2. 2h later, Alice clicks the email cancellation link.
3. App: `POST /api/user/delete-account/cancel?token=...` → 200.
4. `UserDeletion.cancelledAt = now`. Audit `USER_SELF_DELETE_CANCELLED, cause: cancellation_token`.

### Scenario B' — Cancellation via in-app banner (S11)
Same as B but Alice cancels from the dashboard banner using her active session. Audit cause: `user_session`.

### Scenario C — Blocked by tenant ownership (B1)
- Alice is the only OWNER of tenant T1 with other active members.
- Alice initiates → 409 `{ blockers: [{ kind: "B1", tenantId: T1, otherActiveMembers: 3 }] }`.
- Alice must transfer ownership first.

### Scenario D — Blocked by service account (B5) + transfer flow (C7.5)
- Alice owns 2 active ServiceAccount rows.
- Alice initiates → 409 `{ blockers: [{ kind: "B5", serviceAccountIds: [...] }] }`.
- Alice calls `POST /api/tenant/service-accounts/{id}/transfer` for each to transfer to Bob.
- Alice retries delete → 202.

### Scenario E — Re-registration after deletion
1. Alice deletes (Scenario A completes).
2. 30 days later, Alice signs up again with the same email.
3. New User row with NEW UUID. Old anonymized audit rows remain (`user_id = DELETED_USER`); new Alice's rows use the new UUID.
4. Alice MUST re-enroll passkeys — her existing devices are bound to the old userHandle (will produce silent sign-in failures).
5. Old TeamInvitation / EmergencyAccessGrant referencing her email were cancelled at deletion time (Step 3 of C6).

## Considerations & Constraints

- **Pre-1.0 break**: schema patches converting REQUIRED FKs to nullable are acceptable; migration uses lock-light `NOT VALID` + `VALIDATE` pattern.
- **GDPR scope**: only the data controller (deployment operator) decides legal jurisdiction. Feature flag `USER_SELF_DELETE_ENABLED` (default false).
- **Audit chain integrity (NF3 — corrected v2)**: per F2 verification, `user_id` COLUMN is outside the hash; anonymization is chain-safe. Metadata-embedded user-id references are NOT rewritten.
- **R32 (long-running worker)**: deletion worker boot test required pre-merge (T12).
- **R34 Anti-Deferral**: 8 schema-blocker FKs MUST be patched in the implementation PR.
- **R35 Tier-2 (security-sensitive)**: manual smoke test REQUIRED in implementation PR.
- **R36 user-bound token enumeration (F8)**: implementation must mirror `auth-adapter.deleteUser`'s token enumeration BEFORE the user.delete cascade.
- **R37 verify-before-claim (F2)**: this plan v2 corrects NF3 based on verified `audit-chain.ts` code, not assumption.
- **WebAuthn re-enrollment after re-registration (F10)**: documented as expected user-facing behavior.

## Out of Scope (Explicit Deferrals)

This PR (plan-only):
- Implementation. Schema migrations, routes, worker, tests, email templates, manual-test doc.
- 3-sub-agent code review of any implementation (deferred to the implementation PR's Phase 3).
- Round 2 plan review (not required per Resolution Plan in `a04-7-gdpr-self-delete-review.md` — v2 changes are incorporation of verified findings, not scope expansion).

For the implementation PR:
- Admin-side "delete user" UI (separate flow; tenant admin permission).
- Legal hold mechanism (regulatory holds suspending deletion) — operational concern.
- Data portability / export (GDPR Article 20) — different right; separate plan.
- Cross-deployment user deletion (federation / SSO sync) — out of scope.
- Cross-tenant info leakage via sentinel-rewrite (S13) — accepted as documented behavior; tenant members can see "an ex-member created this" via the sentinel.

## Recurring Issue Check (planning side, v2)

| Rule | Status | Note |
|------|--------|------|
| R9 fire-and-forget in tx | OK | logAuditAsync after commit; createNotification analog |
| R10 circular import | OK | deletion-flow → prisma + audit, one-way |
| R11 display vs subscription group | OK | New actions in PERSONAL[AUTH] only |
| R12 every action in groups + i18n + tests | OK | C8 + C10 |
| R13 delivery-failure loop | OK | Not introduced |
| R14 DB role permissions + RLS | OK | Dedicated `passwd_deletion_worker` role; per-statement `withBypassRls` (S8) |
| R15 hardcoded env values | OK | Sentinel UUID in constants module; env-flag for feature |
| R29 external standard citation | OK | GDPR Article 17 + Recital 39, APPI Article 30 (verify section numbers before implementation) |
| R32 new long-running runtime artifact | OK | Pinned ready signal + manual smoke test (T12) |
| R34 Anti-Deferral | OK | All Critical + Major findings from Round 1 applied; F2 verification removed the hash-spec deferral |
| R35 Tier-2 manual-test | OK | C10 manual-test doc in same PR (with worker boot section + adversarial scenarios) |
| R36 user-bound token enumeration | OK | C6 Step 0 enumerates all token classes |
| R37 verify-before-claim | OK | F2 verified `audit-chain.ts:53-67` before correcting NF3 |
| RS1 timing-safe comparison | OK | timingSafeEqual on cancellation token |
| RS2 rate limiter on new routes | OK | 1/24h per user on delete-account + 5/min per IP on cancel (S2) |
| RS3 input validation at boundaries | OK | Zod .strict() on all schemas; reason length-cap |
| RS4 personal data in artifacts | OK | Manual-test doc uses placeholders per existing convention |
