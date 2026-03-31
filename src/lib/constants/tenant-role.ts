import type { TenantRole } from "@prisma/client";

export const TENANT_ROLE = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MEMBER: "MEMBER",
} as const satisfies Record<TenantRole, TenantRole>;

export type TenantRoleValue = TenantRole;

export const TENANT_ROLE_VALUES = [
  TENANT_ROLE.OWNER,
  TENANT_ROLE.ADMIN,
  TENANT_ROLE.MEMBER,
] as const satisfies readonly [TenantRole, ...TenantRole[]];

/** Check if a tenant role has admin-level privileges (OWNER or ADMIN). */
export function isTenantAdminRole(role: string | null | undefined): boolean {
  return role === TENANT_ROLE.OWNER || role === TENANT_ROLE.ADMIN;
}
