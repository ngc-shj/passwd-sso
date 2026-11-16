// Centralized so GET history (UI precompute) and POST approve
// (enforcement) cannot drift apart on who-can-approve rules.

import type { TenantRole } from "@prisma/client";
import { isTenantRoleAbove } from "@/lib/auth/access/tenant-role-hierarchy";

export const APPROVE_ELIGIBILITY = {
  ELIGIBLE: "eligible",
  INITIATOR: "initiator",
  INSUFFICIENT_ROLE: "insufficient_role",
  // The initiator no longer holds the authority the reset was filed under
  // (deactivated, demoted, left since); approve answers RESET_NOT_APPROVABLE.
  INITIATOR_UNAUTHORIZED: "initiator_unauthorized",
} as const;

export type ApproveEligibility =
  (typeof APPROVE_ELIGIBILITY)[keyof typeof APPROVE_ELIGIBILITY];

export function computeApproveEligibility(args: {
  actorId: string;
  actorRole: TenantRole;
  targetRole: TenantRole;
  initiatedById: string;
  initiatorAuthorized: boolean;
}): ApproveEligibility {
  if (args.actorId === args.initiatedById) return APPROVE_ELIGIBILITY.INITIATOR;
  if (!isTenantRoleAbove(args.actorRole, args.targetRole)) {
    return APPROVE_ELIGIBILITY.INSUFFICIENT_ROLE;
  }
  if (!args.initiatorAuthorized) return APPROVE_ELIGIBILITY.INITIATOR_UNAUTHORIZED;
  return APPROVE_ELIGIBILITY.ELIGIBLE;
}
