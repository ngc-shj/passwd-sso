/**
 * SCIM User service — Prisma queries and data transformation for SCIM User operations.
 *
 * All functions must be called within a `withTenantRls()` context.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AuditAction } from "@prisma/client";
import { AUDIT_ACTION } from "@/lib/constants";
import { userToScimUser, type ScimUserInput, type ScimUserResource } from "@/lib/scim/serializers";
import { isScimExternalMappingUniqueViolation } from "@/lib/scim/prisma-error";
import type { UserPatchResult } from "@/lib/scim/patch-parser";

// ── Input types ───────────────────────────────────────────────

export interface ScimUserReplaceInput {
  active: boolean;
  externalId?: string;
  name?: { formatted?: string; givenName?: string; familyName?: string };
}

// ── Result types ──────────────────────────────────────────────

export interface ScimUserReplaceResult {
  resource: ScimUserResource;
  userId: string;
  auditAction: AuditAction;
  /** When true, the route handler must call invalidateUserSessions(userId, { tenantId }). */
  needsSessionInvalidation: boolean;
}

export interface ScimUserPatchResult {
  resource: ScimUserResource;
  userId: string;
  auditAction: AuditAction;
  /** When true, the route handler must call invalidateUserSessions(userId, { tenantId }). */
  needsSessionInvalidation: boolean;
}

export interface DeactivateResult {
  userId: string;
  userEmail: string | null;
  /** Always true — the route handler must call invalidateUserSessions(userId, { tenantId }). */
  needsSessionInvalidation: true;
}

// ── Error classes ─────────────────────────────────────────────

export class ScimUserNotFoundError extends Error {
  constructor() {
    super("User not found");
    this.name = "ScimUserNotFoundError";
  }
}

import { ScimOwnerProtectedError } from "@/lib/scim/errors";
import { TENANT_ROLE } from "@/lib/constants/tenant-role";
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
export async function resolveUserId(tenantId: string, scimId: string): Promise<string | null> {
  if (scimId.length > 255) return null;

  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId: scimId } },
    select: { userId: true },
  });
  if (member) return member.userId;

  const mapping = await prisma.scimExternalMapping.findFirst({
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
 * Fetch a SCIM User resource by internal userId.
 *
 * Returns `null` when the member row or its user email is missing.
 */
export async function fetchScimUser(
  tenantId: string,
  userId: string,
  baseUrl: string,
): Promise<ScimUserResource | null> {
  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!member || !member.user?.email) return null;

  const extMapping = await prisma.scimExternalMapping.findFirst({
    where: {
      tenantId,
      internalId: userId,
      resourceType: "User",
    },
    select: { externalId: true },
  });

  const input: ScimUserInput = {
    userId: member.userId,
    email: member.user.email,
    name: member.user.name,
    deactivatedAt: member.deactivatedAt,
    externalId: extMapping?.externalId,
  };

  return userToScimUser(input, baseUrl);
}

/**
 * Full-replace a SCIM User (PUT semantics).
 *
 * Updates member active state, manages `ScimExternalMapping`, and returns the
 * updated resource with an audit action indicator.
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
  baseUrl: string,
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

  const resource = await fetchScimUser(tenantId, userId, baseUrl);
  return {
    resource: resource!,
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
  baseUrl: string,
): Promise<ScimUserPatchResult> {
  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!member) throw new ScimUserNotFoundError();

  if (member.role === TENANT_ROLE.OWNER && operations.active === false) throw new ScimOwnerProtectedError();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {
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

  const resource = await fetchScimUser(tenantId, userId, baseUrl);
  return {
    resource: resource!,
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
    select: { id: true, role: true, user: { select: { email: true } } },
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
    userEmail: member.user?.email ?? null,
    needsSessionInvalidation: true,
  };
}
