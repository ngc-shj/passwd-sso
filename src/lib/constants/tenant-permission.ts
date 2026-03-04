export const TENANT_PERMISSION = {
  MEMBER_MANAGE: "tenant:member:manage",
  MEMBER_VAULT_RESET: "tenant:member:vaultReset",
  TEAM_CREATE: "tenant:team:create",
} as const;

export type TenantPermissionValue =
  (typeof TENANT_PERMISSION)[keyof typeof TENANT_PERMISSION];
