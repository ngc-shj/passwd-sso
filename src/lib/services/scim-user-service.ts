/**
 * SCIM User service — Prisma queries and data transformation for SCIM User operations.
 *
 * All functions must be called within a `withTenantRls()` context — except
 * `toScimUserResource`, which reads identity through a bypass and must run after
 * that context closes.
 */

import { Prisma } from "@prisma/client";
import { prisma, type TxOrPrisma } from "@/lib/prisma";
import {
  assertTeamsLocked,
  createLockBudget,
  lockMemberTeamsAgainstRotation,
} from "@/lib/team/team-key-rotation-lock";
import { lockTenantRows } from "@/lib/team/tenant-row-lock";
import {
  type DepartureAuditActor,
  type DepartureRevocation,
  departFromTenant,
  returnToTenant,
} from "@/lib/team/team-departure";
import { revokeUserAuthArtifactsInTx } from "@/lib/auth/session/user-session-invalidation";
import type { AuditAction } from "@prisma/client";
import { AUDIT_ACTION } from "@/lib/constants";
import { userToScimUser, type ScimUserInput, type ScimUserResource } from "@/lib/scim/serializers";
import { isScimExternalMappingUniqueViolation } from "@/lib/scim/prisma-error";
import type { UserPatchResult } from "@/lib/scim/patch-parser";
import { fetchUserDisplayMap } from "@/lib/audit/audit-user-lookup";

// ── Input types ───────────────────────────────────────────────

export interface ScimUserReplaceInput {
  active: boolean;
  externalId?: string;
  name?: { formatted?: string; givenName?: string; familyName?: string };
}

// ── Result types ──────────────────────────────────────────────

/** The membership half of a SCIM User resource; identity is joined by `toScimUserResource`. */
export interface ScimUserSnapshot {
  userId: string;
  deactivatedAt: Date | null;
  externalId: string | undefined;
}

export interface ScimUserReplaceResult {
  snapshot: ScimUserSnapshot;
  userId: string;
  auditAction: AuditAction;
  /**
   * What the deactivation revoked in its transaction; non-null exactly when
   * `auditAction` is SCIM_USER_DEACTIVATE. The route tombstones its sessions.
   */
  revocation: DepartureRevocation | null;
}

export interface ScimUserPatchResult {
  snapshot: ScimUserSnapshot;
  userId: string;
  auditAction: AuditAction;
  /** As in ScimUserReplaceResult. */
  revocation: DepartureRevocation | null;
}

export interface DeactivateResult {
  userId: string;
  /** What the deletion revoked in its transaction. The route tombstones its sessions. */
  revocation: DepartureRevocation;
}

/**
 * The one 409 detail for an existing user a SCIM token may not provision or
 * reactivate: another tenant's — active there or suspended — a departed member
 * another tenant now owns, or one of several users whose emails differ only in
 * case. Distinct details told a token holder which of those any email was
 * (round-6 R6-S4, and for PUT/PATCH round-7 R7-S3).
 */
export const SCIM_USER_NOT_PROVISIONABLE_DETAIL = "User cannot be provisioned by this organization";

/** The session-cache tombstone signal of a SCIM deprovisioning: one alert key for every SCIM route. */
export const SCIM_DEPROVISION_TOMBSTONE = { reason: "scim_deprovision", operation: "SCIM user deprovisioning" } as const;

// ── Error classes ─────────────────────────────────────────────

export class ScimUserNotFoundError extends Error {
  constructor() {
    super("User not found");
    this.name = "ScimUserNotFoundError";
  }
}

import { ScimOwnerProtectedError } from "@/lib/scim/errors";
import { TENANT_ROLE } from "@/lib/constants/auth/tenant-role";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
export { ScimOwnerProtectedError };

export class ScimExternalIdConflictError extends Error {
  constructor() {
    super("externalId is already mapped to a different resource");
    this.name = "ScimExternalIdConflictError";
  }
}

export class ScimDeleteConflictError extends Error {
  constructor() {
    super("Cannot delete user: related resources exist");
    this.name = "ScimDeleteConflictError";
  }
}

// ── Service functions ─────────────────────────────────────────

/**
 * Resolve a SCIM `id` parameter to an internal userId.
 *
 * Tries `tenantId_userId` first (direct match), then falls back to
 * the `ScimExternalMapping` table for IdP-assigned external IDs.
 *
 * Returns `null` if the user cannot be found.
 */
export async function resolveUserId(
  tenantId: string,
  scimId: string,
  db: TxOrPrisma = prisma,
): Promise<string | null> {
  if (scimId.length > 255) return null;

  const member = await db.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId: scimId } },
    select: { userId: true },
  });
  if (member) return member.userId;

  const mapping = await db.scimExternalMapping.findFirst({
    where: {
      tenantId,
      externalId: scimId,
      resourceType: "User",
    },
    select: { internalId: true },
  });
  return mapping?.internalId ?? null;
}

/**
 * The membership half of a SCIM User resource, read in the tenant context.
 *
 * Returns `null` when the member row is missing. Identity is not read here: a
 * member whose users row names another tenant — a departed member the
 * realignment moved — has a row RLS hides in this context, and the REQUIRED
 * relation this used to include came back null (measured: Prisma does not throw).
 */
export async function loadScimUserSnapshot(
  tenantId: string,
  userId: string,
): Promise<ScimUserSnapshot | null> {
  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { userId: true, deactivatedAt: true },
  });
  if (!member) return null;

  const extMapping = await prisma.scimExternalMapping.findFirst({
    where: {
      tenantId,
      internalId: userId,
      resourceType: "User",
    },
    select: { externalId: true },
  });

  return {
    userId: member.userId,
    deactivatedAt: member.deactivatedAt,
    externalId: extMapping?.externalId,
  };
}

/**
 * A SCIM User resource from a membership snapshot, or `null` when the user has no
 * email. Must run after the tenant context closes: identity is read through a
 * bypass, which refuses to open inside one.
 */
export async function toScimUserResource(
  snapshot: ScimUserSnapshot,
  baseUrl: string,
): Promise<ScimUserResource | null> {
  const users = await fetchUserDisplayMap([snapshot.userId], BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP);
  const user = users.get(snapshot.userId);
  if (!user?.email) return null;

  const input: ScimUserInput = {
    userId: snapshot.userId,
    email: user.email,
    name: user.name,
    deactivatedAt: snapshot.deactivatedAt,
    externalId: snapshot.externalId,
  };

  return userToScimUser(input, baseUrl);
}

/**
 * Full-replace a SCIM User (PUT semantics).
 *
 * Updates member active state, manages `ScimExternalMapping`, and returns the
 * updated membership snapshot with an audit action indicator.
 *
 * Throws:
 * - `ScimUserNotFoundError` — member not found
 * - `ScimOwnerProtectedError` — attempt to deactivate the tenant owner
 * - `ScimExternalIdConflictError` — externalId already mapped to a different user
 */
export async function replaceScimUser(
  tenantId: string,
  userId: string,
  data: ScimUserReplaceInput,
  actor: DepartureAuditActor,
): Promise<ScimUserReplaceResult> {
  const { active, externalId } = data;

  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!member) throw new ScimUserNotFoundError();
  if (member.role === TENANT_ROLE.OWNER && active === false) throw new ScimOwnerProtectedError();

  let transition: { auditAction: AuditAction; revocation: DepartureRevocation | null };
  try {
    transition = await prisma.$transaction(async (tx) => {
      // The active state moves only through team-departure.ts, which ends or
      // restores the user's memberships of the tenant's teams with it; the
      // returned ids, not the pre-read above, decide the audit action.
      const budget = createLockBudget();
      await lockTenantRows(tx, tenantId, [userId], "update", budget);
      await tx.tenantMember.update({
        where: { id: member.id },
        data: {
          scimManaged: true,
          provisioningSource: "SCIM",
          lastScimSyncedAt: new Date(),
        },
      });
      const transitionOptions = { actor, budget, alreadyLocked: true };
      let action: AuditAction = AUDIT_ACTION.SCIM_USER_UPDATE;
      let revocation: DepartureRevocation | null = null;
      if (active === false) {
        const departed = await departFromTenant(tx, tenantId, [userId], transitionOptions);
        if (departed.userIds.length > 0) {
          action = AUDIT_ACTION.SCIM_USER_DEACTIVATE;
          revocation = departed.revocation;
        }
      } else if ((await returnToTenant(tx, tenantId, [userId], transitionOptions)).length > 0) {
        action = AUDIT_ACTION.SCIM_USER_REACTIVATE;
      }

      if (externalId) {
        const existingMapping = await tx.scimExternalMapping.findFirst({
          where: { tenantId, externalId, resourceType: "User" },
        });
        if (existingMapping && existingMapping.internalId !== userId) {
          throw new Error("SCIM_EXTERNAL_ID_CONFLICT");
        }
        if (!existingMapping) {
          await tx.scimExternalMapping.deleteMany({
            where: { tenantId, internalId: userId, resourceType: "User" },
          });
          await tx.scimExternalMapping.create({
            data: { tenantId, externalId, resourceType: "User", internalId: userId },
          });
        }
      } else {
        await tx.scimExternalMapping.deleteMany({
          where: { tenantId, internalId: userId, resourceType: "User" },
        });
      }
      return { auditAction: action, revocation };
    });
  } catch (e) {
    if (e instanceof Error && e.message === "SCIM_EXTERNAL_ID_CONFLICT") {
      throw new ScimExternalIdConflictError();
    }
    if (isScimExternalMappingUniqueViolation(e)) {
      throw new ScimExternalIdConflictError();
    }
    throw e;
  }

  const snapshot = await loadScimUserSnapshot(tenantId, userId);
  if (!snapshot) throw new ScimUserNotFoundError();
  return { snapshot, userId, ...transition };
}

/**
 * Partial-update a SCIM User (PATCH semantics).
 *
 * Applies only the fields present in `operations` (parsed by `parseUserPatchOps`).
 *
 * Throws:
 * - `ScimUserNotFoundError` — member not found
 * - `ScimOwnerProtectedError` — attempt to deactivate the tenant owner
 */
export async function patchScimUser(
  tenantId: string,
  userId: string,
  operations: UserPatchResult,
  actor: DepartureAuditActor,
): Promise<ScimUserPatchResult> {
  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!member) throw new ScimUserNotFoundError();

  if (member.role === TENANT_ROLE.OWNER && operations.active === false) throw new ScimOwnerProtectedError();

  const transition = await prisma.$transaction(async (tx): Promise<{
    auditAction: AuditAction;
    revocation: DepartureRevocation | null;
  }> => {
    // As in replaceScimUser: the active state moves only through
    // team-departure.ts, and its returned ids decide the audit action.
    const budget = createLockBudget();
    await lockTenantRows(tx, tenantId, [userId], "update", budget);
    await tx.tenantMember.update({
      where: { id: member.id },
      data: { scimManaged: true, provisioningSource: "SCIM", lastScimSyncedAt: new Date() },
    });
    const unchanged = { auditAction: AUDIT_ACTION.SCIM_USER_UPDATE, revocation: null };
    if (operations.active === undefined) return unchanged;
    const transitionOptions = { actor, budget, alreadyLocked: true };
    if (operations.active) {
      const returned = await returnToTenant(tx, tenantId, [userId], transitionOptions);
      return returned.length > 0 ? { auditAction: AUDIT_ACTION.SCIM_USER_REACTIVATE, revocation: null } : unchanged;
    }
    const departed = await departFromTenant(tx, tenantId, [userId], transitionOptions);
    return departed.userIds.length > 0
      ? { auditAction: AUDIT_ACTION.SCIM_USER_DEACTIVATE, revocation: departed.revocation }
      : unchanged;
  });

  const snapshot = await loadScimUserSnapshot(tenantId, userId);
  if (!snapshot) throw new ScimUserNotFoundError();
  return { snapshot, userId, ...transition };
}

/**
 * Soft-delete (deactivate + remove) a SCIM-managed user from a tenant.
 *
 * Deletes the tenant membership and all related rows in a single transaction,
 * and revokes the user's sessions and tokens in the tenant in it.
 *
 * Throws:
 * - `ScimUserNotFoundError` — member not found
 * - `ScimOwnerProtectedError` — attempt to delete the tenant owner
 * - `ScimDeleteConflictError` — foreign-key constraint prevents deletion
 */
export async function deactivateScimUser(
  tenantId: string,
  userId: string,
): Promise<DeactivateResult> {
  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { id: true, role: true },
  });
  if (!member) throw new ScimUserNotFoundError();
  if (member.role === TENANT_ROLE.OWNER) throw new ScimOwnerProtectedError();

  let revocation: DepartureRevocation;
  try {
    revocation = await prisma.$transaction(async (tx) => {
      // Lock order (tenant-row-lock.ts): the tenant row, then the teams being
      // left, before any invitation, member row or key is touched.
      const budget = createLockBudget();
      await lockTenantRows(tx, tenantId, [userId], "update", budget);
      // The row is about to go, and with it the deactivation stamp admission
      // reads; this record keeps invitations issued before now void even if
      // the membership is re-created (SCIM POST, SSO sign-in).
      await tx.$executeRaw`
        INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at)
        VALUES (${tenantId}::uuid, ${userId}::uuid, clock_timestamp())
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET departed_at = EXCLUDED.departed_at
      `;
      const lockedTeams = await lockMemberTeamsAgainstRotation(tx, userId, tenantId, budget);
      await tx.$executeRaw`
        UPDATE team_invitations SET status = 'EXPIRED', updated_at = clock_timestamp()
         WHERE tenant_id = ${tenantId}::uuid AND invited_by_id = ${userId}::uuid AND status = 'PENDING'
      `;
      await tx.teamMemberKey.deleteMany({ where: { tenantId, userId } });
      await tx.scimExternalMapping.deleteMany({
        where: { tenantId, internalId: userId, resourceType: "User" },
      });
      // A membership that appeared after the lock was taken was never
      // serialised with rotation: refuse rather than remove it.
      const leftTeams = await tx.$queryRaw<{ team_id: string }[]>`
        DELETE FROM team_members WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid
        RETURNING team_id
      `;
      assertTeamsLocked(lockedTeams, leftTeams.map((row) => row.team_id));
      await tx.tenantMember.delete({
        where: { tenantId_userId: { tenantId, userId } },
      });
      // Last (user-auth-serialization.ts): the credential lock after every row
      // write, so no mint holding it waits on this transaction.
      return revokeUserAuthArtifactsInTx(tx, userId, { tenantFilter: { tenantId }, boundedLockWait: true });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      throw new ScimDeleteConflictError();
    }
    throw e;
  }

  return { userId, revocation };
}
