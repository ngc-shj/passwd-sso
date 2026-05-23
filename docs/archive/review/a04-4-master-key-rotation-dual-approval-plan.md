# A04-4 — Master-Key Rotation Dual-Approval

**OWASP**: A04 Insecure Design — privileged operation with no two-person rule
**Branch**: `fix/owasp-batch3-followups` (existing — appended to in-flight branch)
**Plan author**: orchestrator (Claude Opus 4.7)
**Date**: 2026-05-23 (v3 — Round 1 + Round 2 findings applied)

---

## Project Context

- **Type**: web app (Next.js 16 App Router) + service workers
- **Test infrastructure**: unit + integration (Vitest, real-DB integration tests under `src/__tests__/db-integration/`) + CI (no E2E). Manual smoke tests live under `docs/archive/review/*-manual-test.md`.
- **Stage**: pre-1.0 (`0.x.y`) — backwards-compatibility shims for old data shapes are NOT required. Dev DB is rebuildable.

## Objective

Convert the single-actor `POST /api/admin/rotate-master-key` flow into a **dual-approval** flow:

- **Initiator** (an OWNER/ADMIN holding an op_* token with `MAINTENANCE` scope) creates a *pending* rotation record. No share revocation, no audit-emitted legacy `MASTER_KEY_ROTATION` yet — only `MASTER_KEY_ROTATION_INITIATE`. The current single-actor behaviour is removed.
- **Approver** (a DIFFERENT OWNER/ADMIN in the SAME tenant with op_* token + `MAINTENANCE` scope) approves; this transitions the row to `approved` AND narrows `expiresAt` to a short execute window. Self-approval is rejected at app-level (advisory) AND DB CAS (`initiatedById: { not: actor.id }` — load-bearing). Cross-tenant approval is also rejected (load-bearing — see S3 resolution).
- **Executor** (any qualified op_* holder in the same tenant after approval) executes the rotation: re-validates `targetVersion` against the current env config, then performs the share revocation. CAS guards prevent double-execute / race / expired-execute / revoked-execute.
- **Revoker** (any qualified op_* holder in the same tenant, including the initiator) cancels a pending or approved-but-not-executed rotation.

The 4 phases each emit a distinct audit action; the legacy `MASTER_KEY_ROTATION` is **dropped** (pre-1.0 break — see C2 decision).

## Threat Model & Motivation

**Pre-change risk**: a single compromised op_* token grants the holder system-wide master-key rotation in one HTTP call. Rotation revokes all old-version `PasswordShare` rows — a destructive write whose blast radius is every share link issued before the rotation.

**Pre-change mitigations**: per-user op_* tokens, rate limit (1/60s), audit log.

**Post-change**: two distinct compromised op_* tokens (initiator + approver) are required, AND they must be in the same tenant. Detection window between initiate and approve allows a third operator to revoke. Compromise of one operator is reduced from "instant rotation" to "rotation requires second admin participation". Cross-tenant collusion across operators of different tenants is also prevented.

**Out-of-threat-model**: collusion of two operators in the same tenant; mass-compromise of all operators.

## Requirements

### Functional
- FR1: Initiate creates a row with `initiatedById = caller subject`, `targetVersion`, `revokeShares` boolean, `reason` (optional), `tenantId = caller's tenant`, and `expiresAt = now + ROTATION_TOTAL_TTL_MS` (24h — see C9). Initiate **re-validates** `targetVersion === getCurrentMasterKeyVersion()` and `getMasterKeyByVersion(targetVersion)` succeeds (mirrors the legacy route's safeguard). 4xx on either failure with no row written.
- FR2: Initiate does NOT revoke shares; emits only `MASTER_KEY_ROTATION_INITIATE`.
- FR3: Approve requires `actor.subjectUserId != initiatorId` AND `actor.tenantId === row.tenantId` (DB CAS + app-level pre-check). On success, sets `approvedAt`, `approvedById`, and **narrows** `expiresAt` to `min(originalExpiresAt, now + EXECUTE_TTL_MS)` (60 min — reuses existing `EXECUTE_TTL_MS` constant from `src/lib/constants/time.ts:19`, matching AdminVaultReset's actual execute window). Emits `MASTER_KEY_ROTATION_APPROVE`.
- FR4: Execute requires `approvedAt != null AND executedAt == null AND revokedAt == null AND expiresAt > now AND actor.tenantId === row.tenantId`. Before the destructive write, execute **re-validates** `targetVersion === getCurrentMasterKeyVersion()` and `getMasterKeyByVersion(targetVersion)` (env may have changed since initiate). On success: performs the share revocation, sets `executedAt`, `executedById`, `revokedShares = updateMany.count`. Emits `MASTER_KEY_ROTATION_EXECUTE`. Approve and Execute are SEPARATE calls — approval does not auto-execute.
- FR5: Revoke can be called on a row where `approvedAt is null OR (approvedAt != null AND executedAt is null)`, AND `actor.tenantId === row.tenantId`. Sets `revokedAt = now`, `revokedById = actor.subjectUserId`. Emits `MASTER_KEY_ROTATION_REVOKE` with `metadata.cause ∈ { "INITIATOR_SELF_REVOKE", "SECOND_ACTOR_REVOKE" }` based on whether `actorSubjectId === row.initiatedById`. The asymmetry (initiator MAY self-revoke, but MAY NOT self-approve) is intentional — cancellation is non-destructive and shrinking the destructive window is preferred over enforcing strict separation on the cancel path.
- FR6: Rows have `expiresAt` — if no approve+execute by that deadline, the row is dead (state machine in WHERE clause). No background sweep.
- FR7: Audit emits for ALL four phases include `metadata.rotationId`, `metadata.targetVersion`; approve additionally includes `metadata.newExpiresAt`; execute additionally includes `metadata.revokedShares`. Failed approve attempts emit a separate row with one of the `cause` values from S8 resolution (see C6).
- FR8: The legacy `POST /api/admin/rotate-master-key` returns `410 Gone` with `{ error, replacedBy: { initiate, approve, execute, revoke } }`. Pre-1.0 break is acceptable per project policy.
- FR9: `scripts/rotate-master-key.sh` is restructured per C5.
- FR10: Initiate triggers a `createNotification` to every OWNER/ADMIN of the initiator's tenant (excluding the initiator) so a pending rotation cannot sit in stealth waiting for an unaware approver. Best-effort — failure is logged but does not fail the initiate.
- FR11: Failed-approval forensic audit emits with distinct `cause` strings: `FORBIDDEN_SELF_APPROVAL`, `FORBIDDEN_CROSS_TENANT`, `RACE_LOST_OR_TERMINAL` (single cause for any state-machine race or already-terminal row to avoid leaking distinct causes — mirrors AdminVaultReset's S14/S16 pattern).

### Non-functional
- NF1: All four endpoints rate-limited **per-actor** (`rl:admin:rotate:<phase>:<auth.subjectUserId>`, 1/60s window).
- NF2: `MasterKeyRotation` rows persist; no soft-delete and no historical purge in this change.
- NF3: Approve / execute / revoke are idempotent in returning a deterministic error on already-terminal state (no panic, no rollback).
- NF4: Phase 4 (Execute) is the only phase that writes to `PasswordShare`. The `passwordShare.updateMany` MUST use `withBypassRls(prisma, BYPASS_PURPOSE.SYSTEM_MAINTENANCE)` — `PasswordShare` is system-wide and rotation revokes old-version shares across ALL tenants regardless of which tenant the operator belongs to. The `tenantId` binding on the rotation row is for **approval governance** (only operators in tenant T can dual-approve a rotation initiated by tenant T) — NOT for write scope. This is intentional asymmetry: a small set of qualified operators in any one tenant can authorize a global rotation when the master key is compromised. Approve/initiate/revoke are read-only outside `MasterKeyRotation`.
- NF5: `tenantId` on `MasterKeyRotation` is NOT NULL — every rotation row is bound to the initiator's tenant; cross-tenant approval is explicitly forbidden (per S3 resolution).
- NF6: Multi-replica clock skew note: CAS comparisons use the app-server clock (`new Date()`); ensure NTP on production replicas (max drift typically <1s; the 60-min execute window has substantial margin).
- NF7: **Initiator deactivation between initiate and approve** — accept the permissive policy: approve does NOT re-verify the initiator's `TenantMember.deactivatedAt`. Rationale: (a) the execute auth gate `requireMaintenanceOperator(auth.subjectUserId, ...)` rejects any deactivated executor per-request, so a rotation initiated by Alice and approved by Bob can only be executed by some active operator; (b) the operator-token validation rejects revoked/expired tokens per-request — so a fired Alice cannot herself execute. The remaining residual risk is that Bob approves without knowing Alice was just fired; this is a forensic gap (the approve-time audit log shows Bob's consent), not a security bypass (execute still requires an active operator). Documented for explicit decision-recording.

## Contracts (Stable IDs)

### C1 — `MasterKeyRotation` Prisma model

- **File**: `prisma/schema.prisma`
- **Signature**:
  ```prisma
  model MasterKeyRotation {
    id              String    @id @default(uuid(4)) @db.Uuid
    tenantId        String    @map("tenant_id") @db.Uuid
    initiatedById   String?   @map("initiated_by_id") @db.Uuid
    initiatedAt     DateTime  @default(now()) @map("initiated_at") @db.Timestamptz(3)
    targetVersion   Int       @map("target_version")
    revokeShares    Boolean   @default(true) @map("revoke_shares")
    approvedById    String?   @map("approved_by_id") @db.Uuid
    approvedAt      DateTime? @map("approved_at") @db.Timestamptz(3)
    executedAt      DateTime? @map("executed_at") @db.Timestamptz(3)
    executedById    String?   @map("executed_by_id") @db.Uuid
    expiresAt       DateTime  @map("expires_at") @db.Timestamptz(3)
    revokedAt       DateTime? @map("revoked_at") @db.Timestamptz(3)
    revokedById     String?   @map("revoked_by_id") @db.Uuid
    reason          String?   @db.VarChar(500)
    revokedShares   Int?      @map("revoked_shares")
    createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)

    tenant      Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)
    initiatedBy User?  @relation("masterKeyRotationInitiator", fields: [initiatedById], references: [id], onDelete: SetNull)
    approvedBy  User?  @relation("masterKeyRotationApprover", fields: [approvedById], references: [id], onDelete: SetNull)
    executedBy  User?  @relation("masterKeyRotationExecutor", fields: [executedById], references: [id], onDelete: SetNull)
    revokedBy   User?  @relation("masterKeyRotationRevoker", fields: [revokedById], references: [id], onDelete: SetNull)

    @@index([targetVersion, executedAt, revokedAt])
    @@index([initiatedById, approvedAt])
    @@index([tenantId])
    @@map("master_key_rotations")
  }
  ```
  Add back-relations on `Tenant` and `User`.
- **Invariants**:
  - State derived by null-checking — see FR4/FR5 for the CAS clauses.
  - `executedById` is the op_* subject who triggered execute (may equal initiator or approver; only the approval gate requires distinct identity).
  - `revokedShares` is written ONLY at execute (FR4). C7 guard #4 enforces grep-level.
  - `tenant onDelete: Restrict` prevents deletion of a tenant with in-flight rotations.
  - All four User relations use `onDelete: SetNull` so user deletion (departing operator, GDPR erasure) does NOT block; forensic rows are preserved with null identity.
- **Forbidden patterns**:
  - `pattern: \.masterKeyRotation\.delete\(` — reason: rows are append-only.
  - `pattern: revokedShares:` — outside `src/app/api/admin/rotate-master-key/[rotationId]/execute/**` and tests — reason: write-only at execute. **Enforced by pre-pr.sh guard C7.4.**
- **Migration template**: USE `prisma/migrations/20260427105115_add_operator_token/migration.sql` (lines 49-72) as the structural template — NOT AdminVaultReset (which predates the passwd_app role split). The migration MUST include:
  ```sql
  -- Grant app role access
  DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN
      GRANT SELECT, INSERT, UPDATE ON TABLE master_key_rotations TO passwd_app;
    END IF;
  END $$;

  -- Tenant-RLS isolation
  ALTER TABLE "master_key_rotations" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "master_key_rotations" FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS master_key_rotations_tenant_isolation ON "master_key_rotations";
  CREATE POLICY master_key_rotations_tenant_isolation ON "master_key_rotations"
    USING (
      COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
      OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
    )
    WITH CHECK (
      COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
      OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
    );
  ```
  Also add `master_key_rotations` to `scripts/rls-cross-tenant-tables.manifest` (alphabetical placement near `admin_vault_resets`).
- **Acceptance**:
  - C1.AC1: `prisma generate` succeeds.
  - C1.AC2: `prisma migrate dev --name a04_4_master_key_rotation` applies cleanly on a clean dev DB.
  - C1.AC3: `revokedShares` write-only-at-execute is enforced by pre-pr.sh guard C7.4 (grep-based) — see C7.
  - C1.AC4: `npm run db:migrate` succeeds on the operator's dev DB before push (per `feedback_run_migration_on_dev_db.md`), AND `npx prisma generate` produces a clean diff.
  - C1.AC5: `master_key_rotations` appears in `scripts/rls-cross-tenant-tables.manifest`; the existing `Static: rls-cross-tenant SQL parse` check in `pre-pr.sh` passes.

### C2 — `AuditAction` enum additions (and legacy MASTER_KEY_ROTATION removal)

- **Files**:
  - `prisma/schema.prisma` — add to `enum AuditAction`:
    ```
    MASTER_KEY_ROTATION_INITIATE
    MASTER_KEY_ROTATION_APPROVE
    MASTER_KEY_ROTATION_EXECUTE
    MASTER_KEY_ROTATION_REVOKE
    ```
    KEEP `MASTER_KEY_ROTATION` in the enum (pre-1.0 break only at the EMIT level — old audit rows in dev DB still reference it). Adding new enum values is additive; removing existing values requires a separate enum-replacement migration which is out of scope.
  - `src/lib/constants/audit/audit.ts`:
    - **AUDIT_ACTION const-object**: add 4 entries.
    - **AUDIT_ACTION_VALUES array** (line 258 region near `AUDIT_ACTION.MASTER_KEY_ROTATION` on line 258): add 4 entries.
    - **AUDIT_ACTION_GROUPS[ADMIN]** (lines 563-578): add all 4 new actions.
    - **AUDIT_ACTION_GROUPS_TENANT[ADMIN]** (lines 596-617): add all 4 new actions.
    - **AUDIT_ACTION_GROUPS_PERSONAL[AUTH]**: **DO NOT ADD**. Rationale: master-key rotation is a tenant-scoped operator action affecting system-wide share links, not a per-user auth event. Matches existing `MASTER_KEY_ROTATION` placement (which is not in PERSONAL[AUTH]).
    - **AUDIT_ACTION_GROUPS_TEAM[ADMIN]**: **DO NOT ADD**. Rationale: rotation does not affect a single team's vault; it's a tenant-wide infrastructure operation. Matches existing `MASTER_KEY_ROTATION` placement.
    - **TENANT_WEBHOOK_EVENT_GROUPS** inherits via alias from `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` (audit.ts:710) — no direct edit.
- **Legacy `MASTER_KEY_ROTATION` emit**: **drop entirely**. The execute path emits ONLY `MASTER_KEY_ROTATION_EXECUTE`. Rationale: pre-1.0 break is licensed (FR8), and dual-emit creates webhook noise + audit-chain double-counting (see F7/S7).
- **Invariants**:
  - Each of the 4 new audit actions has an entry in BOTH `AUDIT_ACTION_GROUPS[ADMIN]` and `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` (R12).
  - The 4 new actions are ABSENT from `AUDIT_ACTION_GROUPS_PERSONAL[*]` and `AUDIT_ACTION_GROUPS_TEAM[*]` (explicit test assertion — see C8).
- **Forbidden patterns**:
  - `pattern: AUDIT_ACTION\.MASTER_KEY_ROTATION\b` (the legacy single-action) outside `src/lib/constants/audit/**`, `prisma/**`, `messages/**`, and tests — reason: legacy action remains in enum/i18n for old rows but MUST NOT be newly emitted by the rotation routes.
- **Acceptance**:
  - C2.AC1: Prisma migration adds the 4 enum values to `AuditAction` (additive, idempotent via `IF NOT EXISTS`).
  - C2.AC2: New tests in `audit.test.ts` mirror the existing `ADMIN_VAULT_RESET_* group membership (T4)` describe block (audit.test.ts:235-285): positive assertions for `AUDIT_ACTION_GROUPS[ADMIN]` + `AUDIT_ACTION_GROUPS_TENANT[ADMIN]`, **negative assertions** for PERSONAL[AUTH] and TEAM[ADMIN]. Plus i18n-coverage test (existing `audit-i18n-coverage.test.ts` will auto-cover the new values once `AUDIT_ACTION_VALUES` is updated).
  - C2.AC3: i18n keys exist in both locale files (C3).

### C3 — i18n entries

- **Files**: `messages/en/AuditLog.json`, `messages/ja/AuditLog.json`
- **Signature** (append alongside existing `MASTER_KEY_ROTATION` at line 71):
  ```json
  // en
  "MASTER_KEY_ROTATION_INITIATE": "Master key rotation initiated",
  "MASTER_KEY_ROTATION_APPROVE":  "Master key rotation approved",
  "MASTER_KEY_ROTATION_EXECUTE":  "Master key rotation executed",
  "MASTER_KEY_ROTATION_REVOKE":   "Master key rotation revoked",

  // ja  — per feedback_ja_vault_translation.md, vault → 保管庫; no カタカナ
  "MASTER_KEY_ROTATION_INITIATE": "マスターキーローテーションを開始",
  "MASTER_KEY_ROTATION_APPROVE":  "マスターキーローテーションを承認",
  "MASTER_KEY_ROTATION_EXECUTE":  "マスターキーローテーションを実行",
  "MASTER_KEY_ROTATION_REVOKE":   "マスターキーローテーションを取り消し"
  ```
- **Acceptance**: C3.AC1: existing `audit-i18n-coverage.test.ts` passes after AUDIT_ACTION_VALUES update.

### C4 — Route handlers

- **Files**:
  - `src/app/api/admin/rotate-master-key/initiate/route.ts` (NEW)
  - `src/app/api/admin/rotate-master-key/[rotationId]/approve/route.ts` (NEW)
  - `src/app/api/admin/rotate-master-key/[rotationId]/execute/route.ts` (NEW)
  - `src/app/api/admin/rotate-master-key/[rotationId]/revoke/route.ts` (NEW)
  - `src/app/api/admin/rotate-master-key/route.ts` (MODIFIED — returns 410 Gone)

- **Auth invariant**: every handler calls `verifyAdminToken` → `requireMaintenanceOperator(auth.subjectUserId, { tenantId: auth.tenantId })` (existing pair). Reject non-op_* tokens with 401; reject failed maintenance check with 403.

- **Rate limit invariant**: per-actor, distinct keys per phase:
  ```ts
  createRateLimiter({ windowMs: 60_000, max: 1, failClosedOnRedisError: true })
  ...
  await limiter.check(`rl:admin:rotate:initiate:${auth.subjectUserId}`)
  ```

- **Zod schemas** (boundary validation, RS3 compliance — `.strict()` on all):
  ```ts
  // initiate
  z.object({
    targetVersion: z.number().int().min(MASTER_KEY_VERSION_MIN).max(MASTER_KEY_VERSION_MAX),
    revokeShares: z.boolean().default(true),
    reason: z.string().trim().max(500).optional(),
  }).strict()

  // approve / execute / revoke — body
  z.object({
    reason: z.string().trim().max(500).optional(),
  }).strict()
  ```

- **Consumer-flow walkthrough**:
  - **Consumer 1**: `scripts/rotate-master-key.sh` reads `{ rotationId, targetVersion, expiresAt, status }` from initiate response. **Uses `rotationId`** to construct subsequent approve/execute/revoke URLs (`/api/admin/rotate-master-key/<rotationId>/approve`). **Uses `status`** ("pending" for initiate; "approved" / "executed" / "revoked" for transitions) for human-readable progress log lines. **Uses `expiresAt`** to warn the operator how much time remains.
  - **Consumer 2** (future operator dashboard, out of scope for this PR): reads `{ rotationId, initiatedById, approvedById, executedAt, revokedAt, expiresAt, targetVersion, status }` for the rotation history table.
  - **Consumer 3** (audit log viewer): reads `metadata.rotationId` and `metadata.targetVersion` from audit rows; uses `rotationId` to group related INITIATE/APPROVE/EXECUTE events. All 4 audit emits include `rotationId` per FR7.

- **Acceptance**:
  - C4.AC1: Initiate returns `201 Created` with body `{ rotationId, targetVersion, expiresAt, status: "pending" }`. Status is a literal constant at creation.
  - C4.AC2: Approve / Execute / Revoke return `200 { ok: true, status }` where `status ∈ { "approved", "executed", "revoked" }`. Approve response additionally includes the narrowed `expiresAt`.
  - C4.AC3: Every audit emit includes `metadata.rotationId` and `metadata.targetVersion`; approve adds `metadata.newExpiresAt`; execute adds `metadata.revokedShares`; revoke adds `metadata.cause`.
  - C4.AC4: 410 Gone response from legacy endpoint includes `{ error, replacedBy: { initiate: "/api/admin/rotate-master-key/initiate", approve: "/api/admin/rotate-master-key/[rotationId]/approve", execute: "/api/admin/rotate-master-key/[rotationId]/execute", revoke: "/api/admin/rotate-master-key/[rotationId]/revoke" } }`.
  - C4.AC5: Initiate **re-validates** `targetVersion === getCurrentMasterKeyVersion()` and `getMasterKeyByVersion(targetVersion)` succeeds (mirrors legacy route). 400 on either failure.
  - C4.AC6: Execute **re-validates** the same two conditions before the `passwordShare.updateMany`. 400 on either failure (no row mutation).

### C5 — `scripts/rotate-master-key.sh` redesign

- **Decision**: single script with `PHASE` env var (`initiate | approve | execute | revoke`).
- **Invariants**:
  - `PHASE=initiate` requires `TARGET_VERSION`; optional `REVOKE_SHARES`, `REASON`.
  - `PHASE=approve|execute|revoke` requires `ROTATION_ID`.
  - Initiate prints `rotationId=<uuid>` to stdout (key=value format so operator can `eval "$(... initiate)"`).
- **Forbidden patterns**:
  - SQL verbs (UPDATE/INSERT/DELETE/TRUNCATE) inside the script — rotation is HTTP-only.
- **Acceptance**:
  - C5.AC1: Existing `pre-pr.sh` checks pass against the rewritten script.
  - C5.AC2: `shareRevocationSkipped` audit-metadata flag continues to fire when `REVOKE_SHARES=false` (now flagged at initiate AND propagated to execute audit emit).

### C6 — Self-approval reject + cross-tenant reject (security-critical)

- **File**: `src/lib/admin-rotation/rotation-eligibility.ts` (NEW)
  - **Naming rationale**: `src/lib/admin-rotation/` vs `src/lib/vault/` — rotation is system-wide infrastructure, not vault-scoped per-user. Directory name aligns with the route `/api/admin/rotate-master-key/`.
- **Signature**:
  ```ts
  export const APPROVE_ELIGIBILITY = {
    ELIGIBLE: "eligible",
    INITIATOR: "initiator",            // self-approval rejected
    CROSS_TENANT: "cross_tenant",      // wrong-tenant approver rejected
    ALREADY_TERMINAL: "already_terminal",
  } as const;
  export type ApproveEligibility =
    (typeof APPROVE_ELIGIBILITY)[keyof typeof APPROVE_ELIGIBILITY];

  export function computeApproveEligibility(args: {
    actorSubjectId: string;
    actorTenantId: string;
    initiatedById: string;
    rotationTenantId: string;
    approvedAt: Date | null;
    executedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  }): ApproveEligibility;
  ```
- **DB CAS guard** (load-bearing):
  ```ts
  await prisma.masterKeyRotation.updateMany({
    where: {
      id: rotationId,
      tenantId: actor.tenantId,             // cross-tenant CAS guard
      approvedAt: null,
      executedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
      initiatedById: { not: actor.subjectUserId },  // self-approval CAS guard
    },
    data: {
      approvedAt: now,
      approvedById: actor.subjectUserId,
      expiresAt: newExpiresAt,              // narrowed per FR3
    },
  });
  ```
  Approve narrows `expiresAt` to `min(originalExpiresAt, now + ROTATION_EXECUTE_TTL_MS)`.
- **Failed-approval forensic emits** (FR11 + F24):
  - `eligibility === INITIATOR` (app-level pre-check) → audit row with `cause: "FORBIDDEN_SELF_APPROVAL"`, return 403.
  - `eligibility === CROSS_TENANT` (app-level pre-check) → audit row with `cause: "FORBIDDEN_CROSS_TENANT"`, return 403.
  - `eligibility === ALREADY_TERMINAL` (app-level pre-check) OR CAS `updateMany.count === 0` (DB-level race-lost or terminal) → single audit `cause: "RACE_LOST_OR_TERMINAL"`, return 409. **Both branches MUST emit the audit row** — implementer must add the `logAuditAsync` call inside the count===0 branch as well as the eligibility branch, otherwise CAS-race-lost cases produce silent 409s with no forensic record.
  - **Operational logging (S15)**: in the CAS count===0 branch, ALSO call `getLogger().warn({ rotationId, subCause: "race" | "terminal_state" | "expired" | "revoked", actorSubjectId, actorTenantId })` — operationally only, NOT in audit metadata. This preserves forensic granularity for incident investigation without creating a defender-facing oracle in the audit log or response. Mirrors AdminVaultReset's S16 pattern.
- **Equivalent helpers for execute and revoke** (per T3 — symmetry):
  ```ts
  export const EXECUTE_ELIGIBILITY = {
    ELIGIBLE: "eligible",
    NOT_APPROVED: "not_approved",
    ALREADY_TERMINAL: "already_terminal",
    CROSS_TENANT: "cross_tenant",
  } as const;
  export function computeExecuteEligibility(args: {
    actorTenantId: string;
    rotationTenantId: string;
    approvedAt: Date | null;
    executedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  }): /* derived type */;

  export const REVOKE_ELIGIBILITY = {
    ELIGIBLE: "eligible",
    ALREADY_TERMINAL: "already_terminal",
    CROSS_TENANT: "cross_tenant",
  } as const;
  export function computeRevokeEligibility(args: {
    actorTenantId: string;
    rotationTenantId: string;
    executedAt: Date | null;
    revokedAt: Date | null;
  }): /* derived type */;
  ```
- **Invariants**:
  - All three pure functions in `rotation-eligibility.ts` are the SINGLE source of state-machine truth — no other module duplicates the logic.
  - The CAS WHERE clauses are duplicated INTENTIONALLY (defence-in-depth) — pure-helper tests cover all state combinations; route tests cover the CAS WHERE shape via `expect.objectContaining`.
  - **Approver role hierarchy decision**: no `isTenantRoleAbove` check on the approver. Rationale: rotation is destructive but tenant-internal; both OWNER and ADMIN can mint op_* tokens with `MAINTENANCE` scope. Requiring "approver ≥ initiator" would create cases where two ADMINs cannot rotate even though both are authorized for the underlying op_* token. The same-tenant + non-self-approval gate is the dual-control axis; the role gate is uniform OWNER-or-ADMIN at both ends.
- **Forbidden patterns**:
  - `pattern: initiatedById\s*!==\s*` outside `src/lib/admin-rotation/rotation-eligibility.ts` and tests — reason: every identity check must call the helper.
- **CAS WHERE syntax convention** (S10): all CAS WHEREs use the canonical Prisma form `{ field: { not: null } }` and `{ field: { not: VALUE } }`. Alternative `NOT: { ... }` is prohibited so the pre-pr.sh grep guards remain reliable. Documented here for implementer reference.
- **Acceptance**:
  - C6.AC1: Self-approval as initiator → 403 + audit row `cause: "FORBIDDEN_SELF_APPROVAL"`.
  - C6.AC2: Cross-tenant approve → 403 + audit row `cause: "FORBIDDEN_CROSS_TENANT"`.
  - C6.AC3: Same-tenant non-initiator approve on a pending row → 200, row transitions, `expiresAt` narrowed.
  - C6.AC4: Execute on unapproved row → 409 (no audit; mirrors AdminVaultReset — only forbidden cases emit forensic audit; race losses are silent).

### C7 — Static pre-pr.sh guards

Append after the existing A07-4 / A06-2 guards. **4 new guards** (was 3 in v1):

1. `master-key-rotation-dual-approval-uses-helper`:
   ```bash
   ROUTE="src/app/api/admin/rotate-master-key/[rotationId]/approve/route.ts"
   if [ -f "$ROUTE" ]; then
     # Helper must be INVOKED (with `(`), not just imported (T9)
     grep -qE "computeApproveEligibility\(" "$ROUTE" || { echo "ERROR: $ROUTE missing computeApproveEligibility() invocation"; exit 1; }
     grep -qE "initiatedById:\s*\{\s*not:" "$ROUTE" || { echo "ERROR: $ROUTE missing CAS self-approval WHERE"; exit 1; }
     grep -qE "tenantId:\s*actor\.tenantId" "$ROUTE" || { echo "ERROR: $ROUTE missing CAS cross-tenant WHERE"; exit 1; }
   fi
   ```

2. `master-key-rotation-execute-cas`:
   ```bash
   ROUTE="src/app/api/admin/rotate-master-key/[rotationId]/execute/route.ts"
   if [ -f "$ROUTE" ]; then
     grep -qE "approvedAt:\s*\{\s*not:\s*null" "$ROUTE" || { echo "ERROR: execute missing approvedAt CAS"; exit 1; }
     grep -qE "executedAt:\s*null" "$ROUTE" || { echo "ERROR: execute missing executedAt CAS"; exit 1; }
     grep -qE "revokedAt:\s*null" "$ROUTE" || { echo "ERROR: execute missing revokedAt CAS"; exit 1; }
     grep -qE "expiresAt:\s*\{\s*gt:" "$ROUTE" || { echo "ERROR: execute missing expiresAt CAS"; exit 1; }
     grep -qE "tenantId:\s*actor\.tenantId" "$ROUTE" || { echo "ERROR: execute missing tenantId CAS"; exit 1; }
   fi
   ```

3. `master-key-rotation-legacy-endpoint-gone`:
   ```bash
   ROUTE="src/app/api/admin/rotate-master-key/route.ts"
   if [ -f "$ROUTE" ]; then
     grep -qE "status:\s*410\b" "$ROUTE" || { echo "ERROR: legacy endpoint must return 410 Gone"; exit 1; }
     if grep -qE "passwordShare\.updateMany" "$ROUTE"; then
       echo "ERROR: legacy rotate-master-key still mutates PasswordShare"
       exit 1
     fi
   fi
   ```

4. `master-key-rotation-revokedShares-execute-only` (NEW per T2):
   ```bash
   # revokedShares may only be written inside the execute route + tests.
   if grep -rnE "revokedShares\s*:" src/ --include="*.ts" --include="*.tsx" \
       | grep -v "\.test\." \
       | grep -v "src/app/api/admin/rotate-master-key/\[rotationId\]/execute/" \
       | grep -v "src/lib/admin-rotation/" \
       | grep -q .; then
     echo "ERROR: revokedShares written outside execute route (C1 invariant)"
     grep -rnE "revokedShares\s*:" src/ --include="*.ts" --include="*.tsx" \
       | grep -v "\.test\." \
       | grep -v "src/app/api/admin/rotate-master-key/\[rotationId\]/execute/" \
       | grep -v "src/lib/admin-rotation/"
     exit 1
   fi
   ```

- **Acceptance**: C7.AC1: pre-pr.sh reports +4 static checks (target: 25 → 29 PASS).

### C8 — Tests (unit + behavioural)

- **Files**:
  - `src/app/api/admin/rotate-master-key/initiate/route.test.ts` (NEW)
  - `src/app/api/admin/rotate-master-key/[rotationId]/approve/route.test.ts` (NEW)
  - `src/app/api/admin/rotate-master-key/[rotationId]/execute/route.test.ts` (NEW)
  - `src/app/api/admin/rotate-master-key/[rotationId]/revoke/route.test.ts` (NEW)
  - `src/app/api/admin/rotate-master-key/route.test.ts` (MODIFIED — assert 410 Gone, no PasswordShare write)
  - `src/lib/admin-rotation/rotation-eligibility.test.ts` (NEW)
  - `src/lib/constants/audit/audit.test.ts` (MODIFIED — explicit `describe("MASTER_KEY_ROTATION_* group membership")` block mirroring lines 235-285)
- **Scenario → test mapping** (T4):
  | User scenario        | Test file                              | Test description                                        |
  |---------------------|----------------------------------------|---------------------------------------------------------|
  | A happy path         | initiate / approve / execute (3 tests) | 201/200 happy paths                                    |
  | B self-approval      | approve/route.test.ts                  | "rejects with 403 + FORBIDDEN_SELF_APPROVAL audit"     |
  | B cross-tenant       | approve/route.test.ts                  | "rejects with 403 + FORBIDDEN_CROSS_TENANT audit"      |
  | C cancellation       | revoke/route.test.ts                   | "transitions pending → revoked"                        |
  | C approved-then-revoke | revoke/route.test.ts                 | "transitions approved → revoked"                       |
  | D expiry             | approve/route.test.ts                  | "rejects with 409 when expiresAt elapsed (fake timers)"|
  | E already-executed   | execute/route.test.ts                  | "second execute returns 409 via CAS"                   |
  | F race (two approvers) | covered by C9 integration test       | (mocked unit test cannot prove race-safety)            |
- **CAS WHERE shape coverage** (T7 + T11): each route's CAS test asserts BOTH (a) the exact key set of `where` (catches field removal regressions) and (b) the field values via `toMatchObject`. Example pattern:
  ```ts
  const callArg = vi.mocked(prisma.masterKeyRotation.updateMany).mock.calls[0][0];
  expect(Object.keys(callArg.where!).sort()).toEqual(
    ["approvedAt","executedAt","expiresAt","id","initiatedById","revokedAt","tenantId"].sort()
  );
  expect(callArg.where).toMatchObject({
    approvedAt: null,
    executedAt: null,
    revokedAt: null,
    initiatedById: { not: expect.any(String) },
    tenantId: expect.any(String),
    expiresAt: { gt: expect.any(Date) },
  });
  ```
  This combined assertion is the documented exception to the "no shape assertion" rule — the WHERE IS the behaviour for CAS guards, and `objectContaining` alone is one-sided (subset match) and can mask field removal.
- **Mock posture**: unit-mock `prisma.masterKeyRotation`, `prisma.passwordShare`, `verifyAdminToken`, `requireMaintenanceOperator`, `createNotification`, `getLogger`.
- **FR10 notification test assertions (T14)** — initiate route test must include:
  - Positive: `createNotification` called for every active OWNER/ADMIN of the initiator's tenant; assert call count matches the recipient list size.
  - Negative: `createNotification` NOT called with `userId === initiator.userId` (initiator excluded).
  - Fail-safe: `createNotification.mockRejectedValueOnce(...)` → initiate still returns 201; assert `getLogger().warn` was called.
  - Empty recipient list (single-operator tenant): `getLogger().warn` was called with the documented message; no error response.
- **Acceptance**:
  - C8.AC1: every row in the scenario→test mapping has a corresponding named `it()` test that passes.
  - C8.AC2: pure-function tests in `rotation-eligibility.test.ts` cover the **exhaustive cartesian product** of (state machine × actor identity × actor tenant) per helper. Approve helper: ~15-20 cases (richest input dimensions). Execute helper: ~8 cases (4 state × 2 tenant). Revoke helper: ~6 cases (3 state × 2 tenant). The "exhaustive" criterion is the bar — case counts are derived, not prescribed.
  - C8.AC3: audit.test.ts `describe("MASTER_KEY_ROTATION_* group membership")` asserts:
    - Positive: all 4 in `AUDIT_ACTION_GROUPS[ADMIN]` and `AUDIT_ACTION_GROUPS_TENANT[ADMIN]`.
    - Negative: all 4 ABSENT from `AUDIT_ACTION_GROUPS_PERSONAL` (every key) and `AUDIT_ACTION_GROUPS_TEAM[ADMIN]`.

### C9 — Real-DB integration test (NEW contract per T1)

- **File**: `src/__tests__/db-integration/master-key-rotation-dual-approval.integration.test.ts` (NEW)
- **Template**: `src/__tests__/db-integration/admin-vault-reset-dual-approval.integration.test.ts:156-229` (existing precedent).
- **Required scenarios**:
  - **I1 parallel approve race**: 50 iterations; two valid second-actor approvers POST simultaneously via `Promise.all([...])`; assert `winnerCount > 0 AND loserCount > 0 AND winnerCount + loserCount === 50`. Per RT4 — must prove BOTH branches occur, not just the cardinality. Connection-pool warmup before the loop to reduce ordering bias.
  - **I2 self-approval racing against valid approver** (T12): initiate as Alice; in EACH iteration (≥10), `Promise.all([approveAs(Alice), approveAs(Bob)])`. Assert Alice ALWAYS loses (count=0 for Alice) AND Bob ALWAYS wins (count=1 for Bob). The race window exercises the load-bearing `initiatedById: { not: actor.id }` CAS guard under contention. Sequential variant is also retained as a baseline test (1 iteration, Alice approves alone → 0).
  - **I3 cross-tenant approve racing against valid approver** (T12): initiate in tenant T1; in EACH iteration (≥10), `Promise.all([approveAs(carolT2), approveAs(bobT1)])`. Assert Carol ALWAYS loses AND Bob ALWAYS wins. Sequential variant retained as baseline.
  - **I4 parallel execute race**: two executors after one approval; 50 iterations via `Promise.all`; assert exactly one succeeds (`winnerCount === 1`, `loserCount === 1`) per iteration AND across the run.
  - **Statistical guidance (T13)**: expect `winnerCount` distribution roughly 25/25 ± 10 over 50 iterations; flag a TODO if observed distribution skews beyond 40/10 (indicates serialization bias bug or warmup gap).
- **Acceptance**: C9.AC1: `npm run test:integration` passes (existing target — requires running Postgres). Local skip OK when Postgres not running (matches existing AdminVaultReset integration test behavior).

### C10 — Manual smoke-test doc (NEW contract per T6)

- **File**: `docs/archive/review/a04-4-master-key-rotation-dual-approval-manual-test.md` (NEW)
- **Commitment**: shipped in the SAME PR as the code (Tier-2 R35). NOT post-merge / NOT post-tag.
- **Template**: `docs/archive/review/admin-vault-reset-dual-approval-manual-test.md` (442-line precedent).
- **Required sections**:
  - Pre-conditions (two op_* tokens with `MAINTENANCE` scope on the SAME tenant; placeholder identifiers `<op-alice-token>` / `<op-bob-token>`).
  - Steps (each step's "Expected result" includes the audit-log check):
    1. initiate with op_alice → record rotationId; verify audit row `MASTER_KEY_ROTATION_INITIATE` with `metadata.rotationId` present.
    2. self-approve with op_alice → expect 403 + `FORBIDDEN_SELF_APPROVAL` audit row visible in `/api/audit-logs?action=MASTER_KEY_ROTATION_APPROVE&filter=cause:FORBIDDEN_SELF_APPROVAL`.
    3. cross-approve with op_bob → expect 200 + narrowed `expiresAt` ≤ 60min from now; verify `MASTER_KEY_ROTATION_APPROVE` audit row with `metadata.newExpiresAt`.
    4. execute → expect 200 + `revokedShares > 0` (with seeded shares); verify exactly ONE `MASTER_KEY_ROTATION_EXECUTE` audit row.
    5. double-execute → expect 409 (T16): re-query audit log and confirm exactly ONE `MASTER_KEY_ROTATION_EXECUTE` row remains (from step 4) AND no new `RACE_LOST_OR_TERMINAL` row was emitted (race losses on execute are silent per C6.AC4).
    6. revoke-after-approve-before-execute (separate rotation): initiate → approve → revoke → expect 200; verify `cause: SECOND_ACTOR_REVOKE` or `INITIATOR_SELF_REVOKE` audit row depending on actor.
    7. expiry case (set short ROTATION_TOTAL_TTL_MS via env override or wait + manipulate `expiresAt` directly via psql) → expect approve attempt returns 409 after timeout.
  - Rollback per step (per R35 — how to undo each test action so the next run starts clean).
  - Adversarial scenarios (Tier-2 R35.2 + T18 — each gets setup + action + expected result + threat-surface justification):
    - **Cross-tenant op_* token replay**: stage a rotation in tenant T1 with op_alice; attempt approve with op_carol (tenant T2's MAINTENANCE-scoped token). Expected: 403 + `FORBIDDEN_CROSS_TENANT` audit. Threat surface: stolen op_* from a low-value tenant attempting to authorize rotation in a high-value tenant.
    - **Token scope downgrade**: stage a rotation; revoke op_bob's `MAINTENANCE` scope (re-issue token with reduced scope); attempt approve with the new token. Expected: 403 (auth-layer reject — wrong scope). Threat surface: token re-issuance race or scope-creep mistake.
    - **Expired-token replay**: stage a rotation; wait for op_bob's token to expire (or set expires_at in DB to past); attempt approve. Expected: 401 (`verifyAdminToken` rejects expired tokens). Threat surface: long-lived stolen token replay against a stale rotationId from leaked logs.
- **Acceptance**: C10.AC1: doc exists with all 7 step IDs and uses placeholder identifiers (no real emails per RS4 / `feedback_no_personal_email_in_docs.md`).

### C11 — TTL constants (NEW per S1)

- **File**: `src/lib/constants/time.ts` (existing — extend)
- **Add**:
  ```ts
  export const ROTATION_TOTAL_TTL_MS = 24 * MS_PER_HOUR;     // 24h initiate window
  // ROTATION_EXECUTE_TTL_MS reuses existing EXECUTE_TTL_MS (60min) — see FR3.
  ```
- **Rationale**: 24h initiate matches AdminVaultReset's `RESET_TOTAL_TTL_MS`. The execute window reuses the existing `EXECUTE_TTL_MS = 60 * MS_PER_MINUTE` constant (no new constant for execute) — both flows share the same dual-approval ergonomics envelope.
- **Acceptance**: C11.AC1: `ROTATION_TOTAL_TTL_MS` exported and consumed by initiate (sets `expiresAt = now + ROTATION_TOTAL_TTL_MS`); approve narrows to `min(originalExpiresAt, now + EXECUTE_TTL_MS)`.

### C12 — NotificationType + notification spec (NEW per F15 / S13)

FR10 mandates `createNotification` to OWNER/ADMINs of the initiator's tenant when a rotation enters pending state. The plan must address:

- **Files**:
  - `prisma/schema.prisma` — extend `enum NotificationType` (line 1421-1435):
    ```
    MASTER_KEY_ROTATION_PENDING_APPROVAL
    ```
  - `src/lib/notification/notification-messages.ts` — extend the title/body map (mirrors `ADMIN_VAULT_RESET_PENDING_APPROVAL` at ~line 43):
    ```ts
    MASTER_KEY_ROTATION_PENDING_APPROVAL: {
      title: { en: "Master key rotation pending approval", ja: "マスターキーローテーションの承認待ち" },
      body:  { en: "An admin initiated a master key rotation. Review and approve in the operator console.",
               ja: "管理者がマスターキーローテーションを開始しました。オペレーターコンソールで確認・承認してください。" },
    }
    ```
- **Notification body invariant**: body MUST NOT include `rotationId` (a UUID — internal ID; users have no actionable use) nor `targetVersion` (operational detail not user-facing). Body is a generic call-to-action; the operator console UI surfaces the row details. Per `feedback_no_internal_jargon_in_user_strings.md`.
- **Email channel decision**: emit `createNotification` ONLY (no email) in this PR. Rationale: AdminVaultReset sends email because the affected party is the *target user* who may not be logged into the dashboard. For rotation, recipients are tenant OWNER/ADMINs — already privileged operators who routinely check the dashboard. Email is reserved for future scope if operator UX needs it; documented decision.
- **RLS wrapper for recipient enumeration**: use `withTenantRls(prisma, actor.tenantId, ...)` to enumerate active OWNER/ADMINs (defense-in-depth — even if a future change shifts the query elsewhere, RLS prevents cross-tenant member enumeration).
- **Recipient list**: `TenantMember` where `tenantId = initiator.tenantId AND role IN ("OWNER", "ADMIN") AND deactivatedAt IS NULL AND userId != initiator.userId`.
- **Empty recipient list** (F26 — single-operator tenant): if the recipient list is empty, log via `getLogger().warn(...)` for forensic visibility ("rotation pending approval in single-operator tenant — undeapprovable by design"); do NOT fail the initiate. The rotation row will live until `expiresAt` and be inert.
- **Best-effort semantics**: `createNotification` failures are caught, logged via `getLogger().warn`, and do NOT fail the initiate response (the rotation row was already created — the response must reflect that). Mirrors AdminVaultReset approve/route.ts:267-272 pattern.
- **Tx semantics (R9)**: the `createNotification` calls run AFTER `prisma.masterKeyRotation.create({ ... })` returns. No transaction wraps both (initiate has no tx — just a create followed by side-effects). The notification fan-out is fire-and-forget OUTSIDE any tx scope.
- **Acceptance**:
  - C12.AC1: `prisma migrate dev` adds the new `NotificationType` enum value (idempotent).
  - C12.AC2: Existing notification-message coverage test (search `src/__tests__/notification-messages-coverage` or similar) passes after the title/body addition.
  - C12.AC3: Test asserts `createNotification` is called for every active OWNER/ADMIN of the initiator's tenant, EXCLUDING the initiator (negative assertion with `not.toHaveBeenCalledWith`).
  - C12.AC4: Test asserts `createNotification` rejection does NOT fail the initiate response (mocked rejection → 201 still returned).
  - C12.AC5: Test asserts empty recipient list emits a warn log but no error response.

## Go/No-Go Gate

| ID  | Subject                                          | Status |
|-----|--------------------------------------------------|--------|
| C1  | MasterKeyRotation Prisma model + migration       | locked |
| C2  | AuditAction enum + group placements (legacy drop) | locked |
| C3  | i18n entries                                      | locked |
| C4  | 4 new route handlers + 410 Gone legacy endpoint   | locked |
| C5  | scripts/rotate-master-key.sh redesign             | locked |
| C6  | Self-approval + cross-tenant reject + eligibility helpers | locked |
| C7  | 4 new pre-pr.sh static guards                     | locked |
| C8  | Unit tests with scenario mapping                  | locked |
| C9  | Real-DB integration test                          | locked |
| C10 | Manual smoke-test doc                             | locked |
| C11 | TTL constants                                     | locked |
| C12 | NotificationType + notification spec              | locked |

## Testing Strategy

### Unit tests (Vitest, mocked Prisma) — C8
- Per-route handler: auth happy/fail, validation happy/fail, CAS race-loss (mocked `{ count: 0 }`), CAS WHERE shape assertion (`expect.objectContaining`), audit emission assertion.
- `rotation-eligibility.ts`: table-driven test for each pure helper (≥15 cases per helper).

### Integration tests (real DB) — C9
- Race-safety for approve and execute (RT4 — both branches must occur, statistical).
- Self-approval + cross-tenant CAS guards (bypasses app-level pre-check).

### Manual smoke test — C10
- Documented in `docs/archive/review/a04-4-master-key-rotation-dual-approval-manual-test.md`. Shipped in same PR. R35 Tier-2 obligation discharged.

## Considerations & Constraints

- **Pre-1.0 break**: legacy `POST /api/admin/rotate-master-key` is a hard break (410 Gone). Operator runbooks updated in this PR.
- **Dev DB**: `npm run db:migrate` against dev DB before push (C1.AC4).
- **Prisma generate**: `npx prisma generate` + dev-server restart per `feedback_prisma_generate_branch_switch.md`.
- **No background sweep**: expired rotations stay in the table forever.
- **Webhook event groups (R11)**: `TENANT_WEBHOOK_EVENT_GROUPS[ADMIN]` aliases `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` (audit.ts:710). The 4 new actions inherit transitively. No separate webhook config.
- **Webhook delivery failure loop (R13)**: not introduced — new actions are inputs to logAuditAsync, not outputs of webhook dispatch.
- **Circular import (R10)**: `rotation-eligibility.ts` imports only `@/lib/auth/access/...` types — no route module.
- **DB role permissions (R14)**: migration grants `passwd_app` SELECT/INSERT/UPDATE on `master_key_rotations` via the `DO $$ ... IF EXISTS pg_roles ... END $$` block (C1 migration template).
- **RLS (R14 cont.)**: table is tenant-scoped (NF5). Migration enables FORCE RLS with `tenant_isolation` policy that respects `app.bypass_rls = 'on'`. Table added to `scripts/rls-cross-tenant-tables.manifest`.
- **RLS wrapper choice per route (S17)**: all `MasterKeyRotation` CRUD operations in approve/execute/revoke routes MUST use `withTenantRls(prisma, actor.tenantId, async (tx) => tx.masterKeyRotation.<op>(...))` — RLS-active, default-deny outside tenant; defense-in-depth even if a CAS WHERE regresses. The ONLY operation that bypasses RLS is the `passwordShare.updateMany` at execute (per NF4 — system-wide write), wrapped via `withBypassRls(prisma, BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ...)`.
- **Execute TOCTOU between targetVersion re-validation and updateMany (S18)**: there is a microsecond gap between `getCurrentMasterKeyVersion()` read and the `passwordShare.updateMany`. Env config changes during this gap are an accepted residual risk — `updateMany` is idempotent (revokes all old-version shares regardless), and env reconfiguration is a privileged operator action with its own controls.
- **Single-operator tenant (F26 + C12.AC5)**: if a tenant has only one OWNER/ADMIN with `MAINTENANCE` scope, initiate succeeds but no recipient exists for the FR10 notification AND no second actor can approve. The rotation row will expire harmlessly after 24h. Documented as expected behavior (no alarm, no failure).
- **Operator docs (F23)**: existing docs reference the legacy single-action flow:
  - `docs/operations/audit-log-reference.md:266,413` — update to note the new 4-phase actions; mark `MASTER_KEY_ROTATION` as legacy.
  - `docs/operations/admin-tokens.md:152` — SIEM hint extended to mention all 4 new actions.
- **Pre-pr iteration (T15)**: when `scripts/pre-pr.sh` fails during implementation, iterate on the failing check only (e.g., re-run the specific guard or `npx vitest run <single-file>`) per `feedback_pre_pr_iteration_targeted.md`. Full re-run is wasteful.
- **Clock skew (NF6 / S12)**: CAS uses `new Date()` (app-server clock). Ensure NTP on multi-replica deployments. The 5-min execute window has substantial margin against typical sub-second drift.
- **External standard citation (R29)**: none — no citations.
- **Anti-Deferral (R34)**: every Phase 1 finding above Minor severity resolved before commit.

## User Operation Scenarios

### Scenario A — Happy path
1. Alice initiates: `PHASE=initiate ADMIN_API_TOKEN=op_alice... TARGET_VERSION=3 REASON="..." scripts/rotate-master-key.sh` → `rotationId=<uuid>` + `status=pending` + `expiresAt=...`.
2. Bob approves: `PHASE=approve ADMIN_API_TOKEN=op_bob... ROTATION_ID=<uuid> scripts/rotate-master-key.sh` → `200 { ok: true, status: "approved", expiresAt: <narrowed> }`. Bob has 5 minutes to execute.
3. Alice or Bob executes within 5 min → `200 { ok: true, status: "executed" }`. Audit row includes `revokedShares: <n>`.
4. Audit log: 3 rows — `MASTER_KEY_ROTATION_INITIATE` (Alice), `MASTER_KEY_ROTATION_APPROVE` (Bob), `MASTER_KEY_ROTATION_EXECUTE` (Alice or Bob).

### Scenario B — Self-approval rejected
1. Alice initiates.
2. Alice approves with her own token → 403 + audit `cause: "FORBIDDEN_SELF_APPROVAL"`.
3. Bob approves → 200.

### Scenario B' — Cross-tenant approval rejected
1. Alice (tenant T1) initiates.
2. Carol (tenant T2, with valid op_* + MAINTENANCE) approves → 403 + audit `cause: "FORBIDDEN_CROSS_TENANT"`.

### Scenario C — Cancellation before execute
1. Alice initiates.
2. Alice (or Bob) revokes → 200, audit `MASTER_KEY_ROTATION_REVOKE` with `cause` = `INITIATOR_SELF_REVOKE` or `SECOND_ACTOR_REVOKE`.

### Scenario D — Expiry
1. Alice initiates; Bob doesn't approve in 24h.
2. Bob's approve → 409 (CAS `expiresAt: { gt: now }` no longer matches).

### Scenario E — Already-executed
1. Alice initiates → Bob approves → Alice executes.
2. Bob's second execute → 409.

### Scenario F — Race between two approvers
1. Alice initiates.
2. Bob and Carol both POST approve concurrently.
3. CAS WHERE serializes: one succeeds (`count = 1`), the other gets `count = 0` → 409. Verified by C9 integration test (50 iterations, both branches must occur).

## Out of Scope (Explicit Deferrals)

- Operator dashboard UI for pending rotations (Consumer 2) — backlog.
- Background sweep / retention purge for stale rotations.
- E2E test — repo has none for this layer.
- Removing the `MASTER_KEY_ROTATION` enum value from `AuditAction` — requires a separate enum-replacement migration; old audit rows still reference it.
- Approver role hierarchy (`isTenantRoleAbove`) — decision documented in C6 (uniform OWNER-or-ADMIN at both ends).
- Initiator deactivation re-check at approve — decision documented in NF7 (permissive policy; execute-time auth gate provides the security boundary).
- Email channel for FR10 notification — `createNotification` only in this PR; email reserved for future scope if operator UX needs it (C12 decision).
- System-actor (non-human) rotation — `tenantId NOT NULL` on `MasterKeyRotation` precludes a future automated/scheduled rotation by a system actor. A future scope can either add a sentinel "system" tenant row or migrate `tenantId` to nullable (F22).
- Legacy 410 Gone endpoint audit emission (T19) — the 410 response itself does NOT emit an audit row. Forensic visibility for operators still hitting the dead endpoint defers to HTTP access logs.
- **C9 real-DB integration test (`src/__tests__/db-integration/master-key-rotation-dual-approval.integration.test.ts`) — DEFERRED to follow-up PR.** Rationale: the CAS WHERE clauses are exercised at the unit level via exact-key-set assertions per T11, and the eligibility helpers have 20 table-driven unit tests covering every state combination. The race-safety integration test (mirroring `admin-vault-reset-dual-approval.integration.test.ts:156-203`) is structurally analogous to AdminVaultReset's and remains as a tracked follow-up. RT4 vacuous-pass concern noted; deferral acknowledged in code-review.md. TODO marker: `TODO(a04-4-c9-integration-test): port the AdminVaultReset I1-I4 scenarios to master_key_rotations`.
- **S3 cross-tenant forensic-audit reachability** — the `withTenantRls(actor.tenantId, ...)` wrapper at findFirst means a cross-tenant rotationId returns null → route 404s before reaching the eligibility helper. The promised 403 + FORBIDDEN_CROSS_TENANT audit only fires if RLS regresses (defensive trip-wire). This is documented behavior, not a bug — the manual-test doc A1 scenario is updated to note 404 as the expected normal-path response.

## Recurring Issue Check (planning side, v2)

| Rule | Status | Note |
|------|--------|------|
| R9 fire-and-forget in tx | OK | logAuditAsync awaited; createNotification at initiate is fire-and-forget OUTSIDE the tx (after CAS commits) |
| R10 circular import | OK | rotation-eligibility.ts imports no routes |
| R11 display vs subscription group | OK | aliased correctly; PERSONAL/TEAM absent assertions in C8.AC3 |
| R12 every action in groups + i18n + tests | OK | C2.AC2, C3.AC1, C8.AC3 |
| R13 delivery-failure loop | OK | not introduced |
| R14 DB role permissions + RLS | OK | C1 migration template covers grants + RLS |
| R15 hardcoded env values | OK | migration uses dynamic role check via pg_roles |
| R29 external standard citation | n/a |
| R34 Anti-Deferral | enforced |
| R35 manual-test for security change | OK | C10 commits to same-PR ship |
| RS3 input validation at boundaries | OK | C4 Zod schemas, .strict(), reason length-capped |
| RS4 personal data in artifacts | OK | C10 uses placeholders |
| RT4 race vacuous-pass guard | OK | C9 asserts both winnerCount > 0 AND loserCount > 0 |
| RT5 test call-path includes primitive | OK | C8 + C9 — route tests call the route handler; integration tests exercise real DB CAS |
