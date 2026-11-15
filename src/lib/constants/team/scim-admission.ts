/** Most members one bulk approve / reject request may name. */
export const SCIM_BULK_ADMISSION_MAX = 100;

export const SCIM_APPROVE_OUTCOME = {
  APPROVED: "approved",
  NOT_FOUND: "not_found",
  ROLE_CHANGED: "role_changed",
  TENANT_INACTIVE: "tenant_inactive",
  CAS_FAILED: "cas_failed",
} as const;

export type ScimApproveOutcome = (typeof SCIM_APPROVE_OUTCOME)[keyof typeof SCIM_APPROVE_OUTCOME];

export const SCIM_REJECT_OUTCOME = {
  REJECTED: "rejected",
  NOT_FOUND: "not_found",
} as const;

export type ScimRejectOutcome = (typeof SCIM_REJECT_OUTCOME)[keyof typeof SCIM_REJECT_OUTCOME];
