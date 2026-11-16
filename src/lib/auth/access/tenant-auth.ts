/**
 * Tenant authorization helpers (RBAC).
 *
 * Permissions are derived from tenant role:
 *   OWNER  — full control (manage members, vault reset, create teams, SCIM)
 *   ADMIN  — full control (manage members, vault reset, create teams, SCIM)
 *   MEMBER — no admin permissions
 */

import { prisma } from "@/lib/prisma";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { hasTenantPermission, type TenantPermission } from "@/lib/auth/access/tenant-permissions";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import type { TenantRole } from "@prisma/client";

export { hasTenantPermission, type TenantPermission } from "@/lib/auth/access/tenant-permissions";

// Back-compat re-export — see tenant-role-hierarchy.ts for the pure module.
export { isTenantRoleAbove } from "@/lib/auth/access/tenant-role-hierarchy";

// Re-export isTenantAdminRole from constants for backward compatibility
export { isTenantAdminRole } from "@/lib/constants";

/**
 * Get the membership record for a user in their tenant.
 * Returns null if the user has no active tenant membership.
 *
 * Uses withBypassRls because the caller may not yet know the tenantId
 * (this function is used to resolve it).
 */
export async function getTenantMembership(userId: string) {
  return withBypassRls(prisma, async (tx) =>
    tx.tenantMember.findFirst({
      where: { userId, deactivatedAt: null },
    }),
  BYPASS_GRANT.TENANT_MEMBERSHIP_LOOKUP);
}

/**
 * Get the tenant role for a user.
 * Returns null if the user has no active tenant membership.
 *
 * Uses withBypassRls since this is called from layouts that do not
 * yet know the tenantId.
 */
export async function getTenantRole(userId: string): Promise<TenantRole | null> {
  const membership = await getTenantMembership(userId);
  return membership?.role ?? null;
}

/**
 * Require that the user has an active tenant membership.
 * Returns the membership record, or throws a structured error.
 */
export async function requireTenantMember(userId: string) {
  const membership = await getTenantMembership(userId);
  if (!membership) {
    throw new TenantAuthError(API_ERROR.FORBIDDEN, 403);
  }
  return membership;
}

/**
 * Require that the user has a specific permission in their tenant.
 * Returns the membership record, or throws a structured error.
 */
export async function requireTenantPermission(
  userId: string,
  permission: TenantPermission,
) {
  const membership = await requireTenantMember(userId);
  if (!hasTenantPermission(membership.role, permission)) {
    throw new TenantAuthError(API_ERROR.FORBIDDEN, 403);
  }
  return membership;
}

// ─── Error Class ────────────────────────────────────────────────

export class TenantAuthError extends Error {
  override message: ApiErrorCode;
  status: number;

  constructor(code: ApiErrorCode, status: number) {
    super(code);
    this.message = code;
    this.name = "TenantAuthError";
    this.status = status;
  }
}
