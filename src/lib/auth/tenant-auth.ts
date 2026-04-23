/**
 * Tenant authorization helpers (RBAC).
 *
 * Permissions are derived from tenant role:
 *   OWNER  — full control (manage members, vault reset, create teams, SCIM)
 *   ADMIN  — full control (manage members, vault reset, create teams, SCIM)
 *   MEMBER — no admin permissions
 */

import { prisma } from "@/lib/prisma";
import { API_ERROR, type ApiErrorCode } from "@/lib/api-error-codes";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import type { TenantRole } from "@prisma/client";

// ─── Permission Definitions ─────────────────────────────────────

export type TenantPermission =
  (typeof TENANT_PERMISSION)[keyof typeof TENANT_PERMISSION];

// OWNER and ADMIN share the same permissions intentionally.
// The role hierarchy (OWNER > ADMIN > MEMBER) is enforced via
// isTenantRoleAbove() — e.g., ADMIN cannot reset another ADMIN's vault,
// only OWNER can. OWNER-to-OWNER resets are also blocked (strict-above).
const ROLE_PERMISSIONS: Record<TenantRole, Set<TenantPermission>> = {
  OWNER: new Set([
    TENANT_PERMISSION.MEMBER_MANAGE,
    TENANT_PERMISSION.MEMBER_VAULT_RESET,
    TENANT_PERMISSION.TEAM_CREATE,
    TENANT_PERMISSION.SCIM_MANAGE,
    TENANT_PERMISSION.AUDIT_LOG_VIEW,
    TENANT_PERMISSION.BREAKGLASS_REQUEST,
    TENANT_PERMISSION.WEBHOOK_MANAGE,
    TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
    TENANT_PERMISSION.AUDIT_DELIVERY_MANAGE,
  ]),
  ADMIN: new Set([
    TENANT_PERMISSION.MEMBER_MANAGE,
    TENANT_PERMISSION.MEMBER_VAULT_RESET,
    TENANT_PERMISSION.TEAM_CREATE,
    TENANT_PERMISSION.SCIM_MANAGE,
    TENANT_PERMISSION.AUDIT_LOG_VIEW,
    TENANT_PERMISSION.BREAKGLASS_REQUEST,
    TENANT_PERMISSION.WEBHOOK_MANAGE,
    TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
    TENANT_PERMISSION.AUDIT_DELIVERY_MANAGE,
  ]),
  MEMBER: new Set(),
};

// ─── Helpers ────────────────────────────────────────────────────

/** Check if a role has a specific permission. */
export function hasTenantPermission(
  role: TenantRole,
  permission: TenantPermission,
): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Role hierarchy (10-stride for extensibility). */
const ROLE_LEVEL: Record<TenantRole, number> = {
  OWNER: 30,
  ADMIN: 20,
  MEMBER: 10,
};

/** Check if actorRole is strictly higher than targetRole. */
export function isTenantRoleAbove(
  actorRole: TenantRole,
  targetRole: TenantRole,
): boolean {
  return ROLE_LEVEL[actorRole] > ROLE_LEVEL[targetRole];
}

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
  return withBypassRls(prisma, async () =>
    prisma.tenantMember.findFirst({
      where: { userId, deactivatedAt: null },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
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
