export const TENANT_PERMISSION = {
  MEMBER_MANAGE: "tenant:member:manage",
  MEMBER_VAULT_RESET: "tenant:member:vaultReset",
  TEAM_CREATE: "tenant:team:create",
  SCIM_MANAGE: "tenant:scim:manage",
  AUDIT_LOG_VIEW: "tenant:auditLog:view",
  BREAKGLASS_REQUEST: "tenant:breakglass:request",
  WEBHOOK_MANAGE: "tenant:webhook:manage",
} as const;

export type TenantPermissionValue =
  (typeof TENANT_PERMISSION)[keyof typeof TENANT_PERMISSION];
