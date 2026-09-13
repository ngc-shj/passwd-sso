/**
 * SCIM User service — Prisma queries and data transformation for SCIM User operations.
 *
 * All functions must be called within a `withTenantRls()` context — except
 * `toScimUserResource`, which reads identity through a bypass and must run after
 * that context closes.
 */

import { Prisma } from "@prisma/client";
import { prisma, type TxOrPrisma } from "@/lib/prisma";
import type { AuditAction } from "@prisma/client";
import { AUDIT_ACTION } from "@/lib/constants";
import { userToScimUser, type ScimUserInput, type ScimUserResource } from "@/lib/scim/serializers";
import { isScimExternalMappingUniqueViolation } from "@/lib/scim/prisma-error";
import type { UserPatchResult } from "@/lib/scim/patch-parser";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";
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
  /** When true, the route handler must call invalidateUserSessions(userId, { tenantId }). */
  needsSessionInvalidation: boolean;
}

export interface ScimUserPatchResult {
  snapshot: ScimUserSnapshot;
  userId: string;
  auditAction: AuditAction;
  /** When true, the route handler must call invalidateUserSessions(userId, { tenantId }). */
  needsSessionInvalidation: boolean;
}

export interface DeactivateResult {
  userId: string;
  /** Always true — the route handler must call invalidateUserSessions(userId, { tenantId }). */
  needsSessionInvalidation: true;
}

/**
 * The one 409 detail for an existing user a SCIM token may not provision: another
 * tenant's, a departed member another tenant now owns, or one of several users
 * whose emails differ only in case. Distinct details told a token holder which of
 * those any email was (round-6 R6-S4).
 */
export const SCIM_USER_NOT_PROVISIONABLE_DETAIL = "User cannot be provisioned by this organization";

// ── Error classes ─────────────────────────────────────────────

export class ScimUserNotFoundError extends Error {
  constructor() {
    super("User not found");
    this.name = "ScimUserNotFoundError";
  }
}

import { ScimOwnerProtectedError } from "@/lib/scim/errors";
import { TENANT_ROLE } from "@/lib/constants/auth/tenant-role";
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
  const users = await fetchUserDisplayMap([snapshot.userId], BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
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
): Promise<ScimUserReplaceResult> {
  const { active, externalId } = data;

  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!member) throw new ScimUserNotFoundError();
  if (member.role === TENANT_ROLE.OWNER && active === false) throw new ScimOwnerProtectedError();

  let auditAction: AuditAction = AUDIT_ACTION.SCIM_USER_UPDATE;
  if (active === false && member.deactivatedAt === null) {
    auditAction = AUDIT_ACTION.SCIM_USER_DEACTIVATE;
  } else if (active !== false && member.deactivatedAt !== null) {
    auditAction = AUDIT_ACTION.SCIM_USER_REACTIVATE;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.tenantMember.update({
        where: { id: member.id },
        data: {
          deactivatedAt: active === false ? (member.deactivatedAt ?? new Date()) : null,
          scimManaged: true,
          provisioningSource: "SCIM",
          lastScimSyncedAt: new Date(),
        },
      });

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
  return {
    snapshot,
    userId,
    auditAction,
    needsSessionInvalidation: auditAction === AUDIT_ACTION.SCIM_USER_DEACTIVATE,
  };
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
): Promise<ScimUserPatchResult> {
  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!member) throw new ScimUserNotFoundError();

  if (member.role === TENANT_ROLE.OWNER && operations.active === false) throw new ScimOwnerProtectedError();

  const updateData: Prisma.TenantMemberUpdateInput = {
    scimManaged: true,
    provisioningSource: "SCIM",
    lastScimSyncedAt: new Date(),
  };

  let auditAction: AuditAction = AUDIT_ACTION.SCIM_USER_UPDATE;

  if (operations.active !== undefined) {
    if (operations.active) {
      updateData.deactivatedAt = null;
      if (member.deactivatedAt !== null) {
        auditAction = AUDIT_ACTION.SCIM_USER_REACTIVATE;
      }
    } else {
      updateData.deactivatedAt = member.deactivatedAt ?? new Date();
      if (member.deactivatedAt === null) {
        auditAction = AUDIT_ACTION.SCIM_USER_DEACTIVATE;
      }
    }
  }

  await prisma.tenantMember.update({
    where: { id: member.id },
    data: updateData,
  });

  const snapshot = await loadScimUserSnapshot(tenantId, userId);
  if (!snapshot) throw new ScimUserNotFoundError();
  return {
    snapshot,
    userId,
    auditAction,
    needsSessionInvalidation: auditAction === AUDIT_ACTION.SCIM_USER_DEACTIVATE,
  };
}

/**
 * Soft-delete (deactivate + remove) a SCIM-managed user from a tenant.
 *
 * Deletes the tenant membership and all related rows in a single transaction.
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

  try {
    await prisma.$transaction([
      prisma.teamMemberKey.deleteMany({ where: { tenantId, userId } }),
      prisma.scimExternalMapping.deleteMany({
        where: { tenantId, internalId: userId, resourceType: "User" },
      }),
      prisma.teamMember.deleteMany({ where: { tenantId, userId } }),
      prisma.tenantMember.delete({
        where: { tenantId_userId: { tenantId, userId } },
      }),
    ]);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      throw new ScimDeleteConflictError();
    }
    throw e;
  }

  return {
    userId,
    needsSessionInvalidation: true,
  };
}
