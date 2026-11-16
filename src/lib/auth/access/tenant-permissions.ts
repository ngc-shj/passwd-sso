/**
 * Tenant role permissions, free of server imports so the audit-outbox worker
 * and client code can apply the same rules the routes enforce (tenant-auth.ts
 * re-exports them).
 */

import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
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
    TENANT_PERMISSION.TEAM_OWNER_ASSIGN,
    TENANT_PERMISSION.SCIM_MANAGE,
    TENANT_PERMISSION.AUDIT_LOG_VIEW,
    TENANT_PERMISSION.BREAKGLASS_REQUEST,
    TENANT_PERMISSION.WEBHOOK_MANAGE,
    TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
    TENANT_PERMISSION.AUDIT_DELIVERY_MANAGE,
    TENANT_PERMISSION.OPERATOR_TOKEN_MANAGE,
  ]),
  ADMIN: new Set([
    TENANT_PERMISSION.MEMBER_MANAGE,
    TENANT_PERMISSION.MEMBER_VAULT_RESET,
    TENANT_PERMISSION.TEAM_CREATE,
    TENANT_PERMISSION.TEAM_OWNER_ASSIGN,
    TENANT_PERMISSION.SCIM_MANAGE,
    TENANT_PERMISSION.AUDIT_LOG_VIEW,
    TENANT_PERMISSION.BREAKGLASS_REQUEST,
    TENANT_PERMISSION.WEBHOOK_MANAGE,
    TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
    TENANT_PERMISSION.AUDIT_DELIVERY_MANAGE,
    TENANT_PERMISSION.OPERATOR_TOKEN_MANAGE,
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
